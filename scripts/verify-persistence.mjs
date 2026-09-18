import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readConfig } from '../dist/config.js'
import { buildApp } from '../dist/app.js'

// Explicit non-destructive development proof: leaves one identifiable fixture in PostgreSQL.
const config=readConfig(),url=new URL(config.DATABASE_URL)
if(config.NODE_ENV!=='development'||url.hostname!=='127.0.0.1'||url.port!=='55432'||url.pathname!=='/chatpop') throw new Error('This proof only targets the bundled local development cluster')
let app
try {
  app=await buildApp(config,{logger:false})
  let address=await app.listen({host:'127.0.0.1',port:0})
  const email=`persistence-${randomUUID()}@example.test`,password=randomBytes(32).toString('base64url')
  async function request(method,path,body,token) {
    const response=await fetch(address+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined})
    if(!response.ok) throw new Error(`Verification request failed: ${method} ${path}`)
    return response.status===204?null:response.json()
  }
  await request('POST','/auth/register',{email,password,display_name:'Persistence verification'})
  const credentials=await request('POST','/auth/login',{email,password})
  const {chat}=await request('POST','/chats',{title:'Database restart verification'},credentials.access_token)
  await request('POST',`/chats/${chat.id}/messages`,{content:'Persisted across PostgreSQL and backend restarts.'},credentials.access_token)
  await request('PATCH','/me/settings',{theme:'system'},credentials.access_token)
  await app.close()
  for(const action of ['stop','start']) {
    const result=spawnSync(process.execPath,['scripts/local-db.mjs',action],{stdio:'pipe'})
    if(result.status!==0) throw new Error('Local PostgreSQL restart failed')
  }
  app=await buildApp(config,{logger:false});address=await app.listen({host:'127.0.0.1',port:0})
  const me=await request('GET','/me',undefined,credentials.access_token)
  const history=await request('GET',`/chats/${chat.id}/messages`,undefined,credentials.access_token)
  const settings=await request('GET','/me/settings',undefined,credentials.access_token)
  if(me.user.email!==email||history.messages.length!==1||settings.settings.theme!=='system') throw new Error('Persistence proof failed')
  await request('POST','/auth/logout',undefined,credentials.access_token)
  const login=await request('POST','/auth/login',{email,password})
  await request('POST','/auth/logout',undefined,login.access_token)
  console.log('PASS: HTTP registration/login, backend + PostgreSQL restart, persisted user/settings/chat/message/session, and logout. Fixture remains in the local development database; credentials were not stored.')
} finally { await app?.close() }
