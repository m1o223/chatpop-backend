import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, access, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runner } from 'node-pg-migrate'
import { readConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { cleanStorage } from '../src/cleanup.js'

const config=readConfig(),url=new URL(config.DATABASE_URL),database=url.pathname.slice(1)
if(config.NODE_ENV!=='test'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!database.endsWith('_test')||process.env.ALLOW_TEST_DATABASE_RESET!==database) {
  throw new Error('Refusing tests: require NODE_ENV=test, a loopback *_test database, and exact ALLOW_TEST_DATABASE_RESET confirmation')
}
const pool=createPool(config)
let app: Awaited<ReturnType<typeof buildApp>>
const password='Test-only correct horse 42!'
const request=(method:'GET'|'POST'|'PATCH'|'DELETE',path:string,body?:unknown,token?:string)=>app.inject({method,url:path,payload:body as never,headers:token?{authorization:`Bearer ${token}`}:{}})
async function account() {
  const email=`${randomUUID()}@example.test`
  const registration=await request('POST','/auth/register',{email,password,display_name:'Test user'})
  assert.equal(registration.statusCode,201)
  const login=await request('POST','/auth/login',{email,password})
  assert.equal(login.statusCode,200)
  return {email,...login.json()}
}
before(async()=> {
  await runner({databaseUrl:config.DATABASE_URL,dir:'migrations',direction:'up',migrationsTable:'pgmigrations',log:()=>{}})
  await pool.query('TRUNCATE users,storage_deletions,rate_limits CASCADE')
  app=await buildApp(config,{pool,rateLimits:false,logger:false})
})
after(async()=> { await app?.close(); await pool.end() })

test('registration normalizes email, stores Argon2id, creates settings, never exposes hash',async()=> {
  const result=await request('POST','/auth/register',{email:'  PERSON@Example.test  ',password,display_name:'Person'})
  assert.equal(result.statusCode,201)
  const user=result.json().user
  assert.equal(user.email,'person@example.test'); assert.equal(user.password_hash,undefined)
  assert.match(user.id,/^[0-9a-f-]{36}$/)
  const {rows:[stored]}=await pool.query('SELECT password_hash FROM users WHERE id=$1',[user.id])
  assert.ok(stored.password_hash!==password && stored.password_hash.startsWith('$argon2id$v=19$'))
  assert.deepEqual(stored.password_hash.split('$')[3].split(',').sort(),['m=65536','p=1','t=3'])
  assert.equal((await pool.query('SELECT theme FROM user_settings WHERE user_id=$1',[user.id])).rows[0].theme,'dark')
})
test('duplicate normalized email is rejected, including concurrent registration',async()=> {
  const results=await Promise.all([request('POST','/auth/register',{email:'race@example.test',password}),request('POST','/auth/register',{email:'RACE@example.test',password})])
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[201,409])
})
test('correct password login, safe me and last login timestamp',async()=> {
  const a=await account(),me=await request('GET','/me',undefined,a.access_token)
  assert.equal(me.statusCode,200); assert.equal(me.json().user.id,a.user.id)
  assert.ok(me.json().user.last_login_at); assert.equal(me.json().user.password_hash,undefined)
  const {rows:[session]}=await pool.query('SELECT * FROM sessions WHERE user_id=$1',[a.user.id])
  assert.equal(session.access_token_hash.length,64); assert.notEqual(session.access_token_hash,a.access_token)
  const {rows:[refresh]}=await pool.query('SELECT * FROM refresh_tokens WHERE session_id=$1',[session.id])
  assert.equal(refresh.token_hash.length,64); assert.notEqual(refresh.token_hash,a.refresh_token)
})
test('wrong password and unknown email both give generic unauthorized',async()=> {
  const a=await account()
  for(const email of [a.email,'missing@example.test']) {
    const result=await request('POST','/auth/login',{email,password:'wrong password'})
    assert.equal(result.statusCode,401); assert.equal(result.json().error.code,'UNAUTHORIZED')
  }
})
test('protected routes reject missing, malformed and refresh-token credentials',async()=> {
  const a=await account()
  for(const path of ['/me','/me/settings','/chats',`/media/${randomUUID()}`]) assert.equal((await request('GET',path)).statusCode,401)
  assert.equal((await request('GET','/me',undefined,'invalid')).statusCode,401)
  assert.equal((await request('GET','/me',undefined,a.refresh_token)).statusCode,401)
})
test('settings updates are strictly scoped to the authenticated user',async()=> {
  const a=await account(),b=await account()
  const result=await request('PATCH','/me/settings',{theme:'light',selected_voice:'voice-3',language:'en-US'},a.access_token)
  assert.equal(result.statusCode,200);assert.equal(result.json().settings.user_id,a.user.id)
  assert.equal((await request('GET','/me/settings',undefined,b.access_token)).json().settings.theme,'dark')
  assert.equal((await request('PATCH','/me/settings',{theme:'light',user_id:b.user.id},a.access_token)).statusCode,400)
})
test('chat ownership protects list, get, rename, delete and title search',async()=> {
  const a=await account(),b=await account()
  const {chat}= (await request('POST','/chats',{},a.access_token)).json()
  assert.equal(chat.title_source,'default')
  assert.equal((await request('PATCH',`/chats/${chat.id}`,{title:'Trip plans'},a.access_token)).json().chat.title_source,'user')
  for(const method of ['GET','PATCH','DELETE'] as const) assert.equal((await request(method,`/chats/${chat.id}`,method==='PATCH'?{title:'Stolen'}:undefined,b.access_token)).statusCode,404)
  assert.equal((await request('GET','/chats?q=trip',undefined,a.access_token)).json().chats.length,1)
  assert.equal((await request('GET','/chats?q=trip',undefined,b.access_token)).json().chats.length,0)
  assert.equal((await request('POST','/chats',{user_id:b.user.id},a.access_token)).statusCode,400)
})
test('messages persist, update activity and cannot be read or injected by another user',async()=> {
  const a=await account(),b=await account(),{chat}=(await request('POST','/chats',{},a.access_token)).json()
  assert.equal((await request('POST',`/chats/${chat.id}/messages`,{content:'Hello'},b.access_token)).statusCode,404)
  assert.equal((await request('GET',`/chats/${chat.id}/messages`,undefined,b.access_token)).statusCode,404)
  assert.equal((await request('POST',`/chats/${chat.id}/messages`,{content:'Hello',role:'assistant'},a.access_token)).statusCode,400)
  const result=await request('POST',`/chats/${chat.id}/messages`,{content:'Hello'},a.access_token)
  assert.equal(result.statusCode,201);assert.equal(result.json().message.user_id,a.user.id)
  assert.equal((await request('GET',`/chats/${chat.id}/messages`,undefined,a.access_token)).json().messages[0].content,'Hello')
  assert.ok((await request('GET',`/chats/${chat.id}`,undefined,a.access_token)).json().chat.last_message_at)
  await assert.rejects(pool.query("INSERT INTO messages(chat_id,user_id,role,content) VALUES($1,$2,'user','Cross-owner')",[chat.id,b.user.id]),{code:'23503'})
})
test('private media metadata never exposes storage keys and enforces ownership',async()=> {
  const a=await account(),b=await account()
  const {rows:[media]}=await pool.query("INSERT INTO media(user_id,media_type,storage_driver,storage_key,mime_type,file_size) VALUES($1,'image','local',$2,'image/png',32) RETURNING id",[a.user.id,randomUUID()])
  assert.equal((await request('GET',`/media/${media.id}`,undefined,b.access_token)).statusCode,404)
  assert.equal((await request('GET',`/media/${media.id}/content`,undefined,b.access_token)).statusCode,404)
  const response=await request('GET',`/media/${media.id}`,undefined,a.access_token)
  assert.equal(response.statusCode,200);assert.equal(response.json().media.storage_key,undefined)
  assert.equal((await request('GET',`/media/${media.id}/content`,undefined,a.access_token)).statusCode,503)
})
test('refresh rotates tokens; replay revokes the entire session',async()=> {
  const a=await account(),rotated=await request('POST','/auth/refresh',{refresh_token:a.refresh_token})
  assert.equal(rotated.statusCode,200)
  const next=rotated.json();assert.notEqual(next.refresh_token,a.refresh_token)
  assert.equal((await request('GET','/me',undefined,a.access_token)).statusCode,401)
  assert.equal((await request('GET','/me',undefined,next.access_token)).statusCode,200)
  assert.equal((await request('POST','/auth/refresh',{refresh_token:a.refresh_token})).statusCode,401)
  assert.equal((await request('GET','/me',undefined,next.access_token)).statusCode,401)
  assert.equal((await request('POST','/auth/refresh',{refresh_token:next.refresh_token})).statusCode,401)
})
test('logout immediately revokes access and refresh credentials',async()=> {
  const a=await account()
  assert.equal((await request('POST','/auth/logout',undefined,a.access_token)).statusCode,204)
  assert.equal((await request('GET','/me',undefined,a.access_token)).statusCode,401)
  assert.equal((await request('POST','/auth/refresh',{refresh_token:a.refresh_token})).statusCode,401)
})
test('concurrent refresh replay revokes the winning session too',async()=> {
  const a=await account()
  const results=await Promise.all([request('POST','/auth/refresh',{refresh_token:a.refresh_token}),request('POST','/auth/refresh',{refresh_token:a.refresh_token})])
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,401])
  const winner=results.find(r=>r.statusCode===200)!.json()
  assert.equal((await request('GET','/me',undefined,winner.access_token)).statusCode,401)
})
test('expired sessions and disabled accounts are rejected',async()=> {
  const a=await account()
  await pool.query('UPDATE sessions SET access_expires_at=now()-interval \'1 second\' WHERE user_id=$1',[a.user.id])
  assert.equal((await request('GET','/me',undefined,a.access_token)).statusCode,401)
  const expired=await account()
  await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",[expired.user.id])
  assert.equal((await request('POST','/auth/refresh',{refresh_token:expired.refresh_token})).statusCode,401)
  await pool.query("UPDATE users SET account_status='disabled' WHERE id=$1",[a.user.id])
  assert.equal((await request('POST','/auth/login',{email:a.email,password})).statusCode,401)
  assert.equal((await request('POST','/auth/refresh',{refresh_token:a.refresh_token})).statusCode,401)
})
test('account deletion reauthenticates, cascades metadata, queues and executes private file cleanup',async()=> {
  const a=await account(),{chat}=(await request('POST','/chats',{},a.access_token)).json()
  const {message}=(await request('POST',`/chats/${chat.id}/messages`,{content:'Delete me'},a.access_token)).json()
  const key=randomUUID(),root=resolve('.local/test-storage');await mkdir(root,{recursive:true});await writeFile(resolve(root,key),'private')
  await pool.query("INSERT INTO media(user_id,chat_id,message_id,media_type,storage_driver,storage_key,mime_type,file_size) VALUES($1,$2,$3,'file','local',$4,'text/plain',7)",[a.user.id,chat.id,message.id,key])
  assert.equal((await request('DELETE','/me',{password:'wrong',confirmation:'DELETE'},a.access_token)).statusCode,401)
  assert.equal((await request('DELETE','/me',{password,confirmation:'DELETE'},a.access_token)).statusCode,204)
  for(const table of ['user_settings','sessions','chats','messages','media']) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,[a.user.id])).rows[0].n,0)
  assert.equal((await request('GET','/me',undefined,a.access_token)).statusCode,401)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM storage_deletions WHERE storage_key=$1',[key])).rows[0].n,1)
  await cleanStorage(pool,{...config,STORAGE_DRIVER:'local',STORAGE_LOCAL_ROOT:root})
  await assert.rejects(access(resolve(root,key)),{code:'ENOENT'})
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM storage_deletions WHERE storage_key=$1',[key])).rows[0].n,0)
  await rm(root,{recursive:true,force:true})
})
test('invalid input, UUIDs, pagination, spoofed fields, oversized bodies and CORS fail safely',async()=> {
  const a=await account()
  for(const path of ['/chats/not-a-uuid','/chats?limit=1000','/chats?offset=-1']) assert.equal((await request('GET',path,undefined,a.access_token)).statusCode,400)
  assert.equal((await request('POST','/auth/register',{email:'bad',password:'short'})).statusCode,400)
  assert.equal((await request('POST','/chats',{title:'x'.repeat(100000)},a.access_token)).statusCode,413)
  const result=await app.inject({method:'GET',url:'/me',headers:{origin:'https://evil.example',authorization:`Bearer ${a.access_token}`}})
  assert.equal(result.statusCode,403);assert.ok(!result.body.includes('password_hash'))
})
test('private local file download checks owner, size, MIME and security headers',async()=> {
  const a=await account(),b=await account(),root=resolve('.local/test-downloads'),key=randomUUID()
  await mkdir(root,{recursive:true});await writeFile(resolve(root,key),'private file')
  const {rows:[media]}=await pool.query("INSERT INTO media(user_id,media_type,storage_driver,storage_key,mime_type,file_size) VALUES($1,'file','local',$2,'text/plain',12) RETURNING id",[a.user.id,key])
  const local=await buildApp({...config,STORAGE_DRIVER:'local',STORAGE_LOCAL_ROOT:root},{pool,rateLimits:false,logger:false})
  try {
    const response=await local.inject({method:'GET',url:`/media/${media.id}/content`,headers:{authorization:`Bearer ${a.access_token}`}})
    assert.equal(response.statusCode,200);assert.equal(response.body,'private file')
    assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(response.headers['cache-control'],'no-store')
    assert.match(String(response.headers['content-disposition']),/^attachment/)
    assert.equal((await local.inject({method:'GET',url:`/media/${media.id}/content`,headers:{authorization:`Bearer ${b.access_token}`}})).statusCode,404)
    await pool.query('UPDATE media SET mime_type=$1 WHERE id=$2',['text/html',media.id])
    assert.equal((await local.inject({method:'GET',url:`/media/${media.id}/content`,headers:{authorization:`Bearer ${a.access_token}`}})).statusCode,415)
    await pool.query('UPDATE media SET mime_type=$1,file_size=20 WHERE id=$2',['text/plain',media.id])
    assert.equal((await local.inject({method:'GET',url:`/media/${media.id}/content`,headers:{authorization:`Bearer ${a.access_token}`}})).statusCode,409)
  } finally { await local.close();await rm(root,{recursive:true,force:true}) }
})
test('media associations cannot cross owners and failed cleanup stays retryable',async()=> {
  const a=await account(),b=await account(),{chat}=(await request('POST','/chats',{},b.access_token)).json()
  await assert.rejects(pool.query("INSERT INTO media(user_id,chat_id,media_type,storage_driver,storage_key,mime_type,file_size) VALUES($1,$2,'file','local',$3,'text/plain',1)",[a.user.id,chat.id,randomUUID()]),{code:'23503'})
  const key=randomUUID()
  await pool.query("INSERT INTO storage_deletions(storage_driver,storage_key) VALUES('unconfigured',$1)",[key])
  await cleanStorage(pool,config)
  const {rows:[job]}=await pool.query('SELECT attempts,completed_at FROM storage_deletions WHERE storage_key=$1',[key])
  assert.ok(job.attempts>0);assert.equal(job.completed_at,null)
})
test('backend restart retains database users, settings, chats, messages and sessions',async()=> {
  const a=await account(),{chat}=(await request('POST','/chats',{title:'Persistent'},a.access_token)).json()
  await request('POST',`/chats/${chat.id}/messages`,{content:'Still here'},a.access_token)
  await request('PATCH','/me/settings',{theme:'system'},a.access_token)
  await app.close();app=await buildApp(config,{pool,rateLimits:false,logger:false})
  assert.equal((await request('GET','/me',undefined,a.access_token)).statusCode,200)
  assert.equal((await request('GET','/me/settings',undefined,a.access_token)).json().settings.theme,'system')
  assert.equal((await request('GET',`/chats/${chat.id}/messages`,undefined,a.access_token)).json().messages[0].content,'Still here')
})
test('profile updates preserve identity and reject ownership spoofing',async()=> {
  const a=await account(),b=await account()
  const profile=await request('PATCH','/me',{display_name:'Persistent name'},a.access_token)
  assert.equal(profile.statusCode,200);assert.equal(profile.json().user.id,a.user.id)
  assert.equal(profile.json().user.password_hash,undefined)
  assert.equal((await request('GET','/me',undefined,b.access_token)).json().user.display_name,'Test user')
  assert.equal((await request('PATCH','/me',{display_name:'Attack',user_id:b.user.id},a.access_token)).statusCode,400)
  const login=await request('POST','/auth/login',{email:a.email,password})
  assert.equal(login.json().user.id,a.user.id);assert.equal(login.json().user.display_name,'Persistent name')
})
test('message retries are idempotent and automatic titles do not replace user titles',async()=> {
  const a=await account(),b=await account(),id=randomUUID(),messageId=randomUUID()
  for(let i=0;i<2;i++) assert.equal((await request('POST','/chats',{id},a.access_token)).statusCode,201)
  assert.equal((await request('POST','/chats',{id},b.access_token)).statusCode,404)
  for(let i=0;i<2;i++) assert.equal((await request('POST',`/chats/${id}/messages`,{id:messageId,content:'Plan a Japan trip'},a.access_token)).statusCode,201)
  assert.equal((await request('GET',`/chats/${id}/messages`,undefined,a.access_token)).json().messages.length,1)
  assert.equal((await request('GET',`/chats/${id}`,undefined,a.access_token)).json().chat.title,'Plan a Japan trip')
  await request('PATCH',`/chats/${id}`,{title:'My title'},a.access_token)
  await request('POST',`/chats/${id}/messages`,{content:'Another message'},a.access_token)
  assert.equal((await request('GET',`/chats/${id}`,undefined,a.access_token)).json().chat.title,'My title')
})
test('media library listing and deletion are owner scoped and queue cleanup',async()=> {
  const a=await account(),b=await account(),key=randomUUID()
  const {rows:[media]}=await pool.query("INSERT INTO media(user_id,media_type,storage_driver,storage_key,mime_type,file_size) VALUES($1,'file','unconfigured',$2,'text/plain',1) RETURNING id",[a.user.id,key])
  assert.equal((await request('GET','/media?limit=1&offset=0',undefined,a.access_token)).json().media[0].id,media.id)
  assert.equal((await request('GET','/media',undefined,b.access_token)).json().media.length,0)
  assert.equal((await request('DELETE',`/media/${media.id}`,undefined,b.access_token)).statusCode,404)
  assert.equal((await request('DELETE',`/media/${media.id}`,undefined,a.access_token)).statusCode,204)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM storage_deletions WHERE storage_key=$1',[key])).rows[0].n,1)
})
test('database-backed auth rate limiting works and is not bypassed with forwarded headers',async()=> {
  const limited=await buildApp(config,{pool,logger:false})
  try {
    for(let i=0;i<11;i++) {
      const response=await limited.inject({method:'POST',url:'/auth/login',remoteAddress:'127.0.0.9',headers:{'x-forwarded-for':`10.0.0.${i}`},payload:{email:'rate-test@example.test',password:'wrong'}})
      assert.equal(response.statusCode,i<10?401:429)
    }
    for(let i=0;i<31;i++) {
      const response=await limited.inject({method:'POST',url:'/auth/refresh',remoteAddress:'127.0.0.10',headers:{'x-forwarded-for':`10.0.1.${i}`},payload:{refresh_token:'cp_rt_'+'x'.repeat(43)}})
      assert.equal(response.statusCode,i<30?401:429)
    }
  } finally { await limited.close() }
})
