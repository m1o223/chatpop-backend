import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readConfig } from '../dist/config.js'
import { createPool } from '../dist/db.js'
import { buildApp } from '../dist/app.js'

// No truncation, database reset, or global cleanup: only this run's random fixtures.
const config = readConfig()
const target = new URL(config.DATABASE_URL)
if (process.env.CONFIRM_CLOUD_SMOKE !== 'yes' || config.NODE_ENV !== 'development'
  || !target.hostname.endsWith('.pooler.supabase.com') || target.port !== '5432'
  || config.DATABASE_SSL !== 'true' || !config.DATABASE_CA_FILE) {
  throw new Error('Requires explicit cloud smoke confirmation and verified Session Pooler TLS')
}
const pool = createPool(config)
const users = []
const mediaKeys = []
let app, address
let stage = 'startup'
async function start() {
  app = await buildApp(config, { logger: false })
  address = await app.listen({ host: '127.0.0.1', port: 0 })
}
async function request(method, path, body, token, expected = 200) {
  const response = await fetch(address + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  assert.equal(response.status, expected, `${method} ${path.split('?')[0]} status`)
  return response.status === 204 ? undefined : response.json()
}
function pass(label) { console.log(`PASS: ${label}`) }
try {
  stage = 'backend-only table access'
  const { rows: grants } = await pool.query("SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('anon','authenticated','service_role','PUBLIC') AND table_name IN ('users','user_settings','sessions','refresh_tokens','chats','messages','media','storage_deletions','rate_limits') LIMIT 1")
  assert.equal(grants.length, 0, 'Backend tables must not be exposed to public API roles')
  await start()
  await request('GET', '/health')
  await request('GET', '/ready')
  pass('health and database readiness')
  stage = 'registration'
  for (let i = 0; i < 2; i++) {
    const email = `cloud-check-${randomUUID()}@example.test`
    const password = randomBytes(32).toString('base64url')
    const fixture = { email, password }
    users.push(fixture)
    const { user } = await request('POST', '/auth/register', { email: ` ${email.toUpperCase()} `, password, display_name: 'Cloud verification' }, undefined, 201)
    fixture.id = user.id
    assert.equal(user.email, email)
    assert.equal(user.password_hash, undefined)
    const { rows: [stored] } = await pool.query('SELECT password_hash,created_at,updated_at FROM users WHERE id=$1', [user.id])
    assert.ok(stored.password_hash.startsWith('$argon2id$') && stored.password_hash !== password)
    assert.ok(stored.created_at && stored.updated_at)
    assert.equal((await pool.query('SELECT theme FROM user_settings WHERE user_id=$1', [user.id])).rows[0].theme, 'dark')
    fixture.session = await request('POST', '/auth/login', { email, password })
  }
  pass('two normalized persistent users, Argon2id passwords, timestamps and default settings')
  const [a, b] = users
  stage = 'authentication'
  await request('POST', '/auth/register', { email: a.email, password: a.password }, undefined, 409)
  await request('POST', '/auth/login', { email: a.email, password: 'incorrect-password' }, undefined, 401)
  await request('GET', '/me', undefined, undefined, 401)
  const me = await request('GET', '/me', undefined, a.session.access_token)
  assert.equal(me.user.id, a.id)
  assert.ok(me.user.last_login_at)
  assert.equal(me.user.password_hash, undefined)
  const { rows: [session] } = await pool.query('SELECT access_token_hash FROM sessions WHERE user_id=$1', [a.id])
  assert.equal(session.access_token_hash.length, 64)
  assert.notEqual(session.access_token_hash, a.session.access_token)
  pass('login, safe /me, duplicate email, wrong password and protected routes')
  stage = 'settings and chat persistence'
  await request('PATCH', '/me/settings', { theme: 'system', language: 'sv' }, a.session.access_token)
  assert.equal((await request('GET', '/me/settings', undefined, b.session.access_token)).settings.theme, 'dark')
  for (const user of users) {
    user.chat = (await request('POST', '/chats', {}, user.session.access_token, 201)).chat
    const renamed = await request('PATCH', `/chats/${user.chat.id}`, { title: 'Cloud persistence verification' }, user.session.access_token)
    assert.equal(renamed.chat.title_source, 'user')
    assert.equal((await request('GET', '/chats?q=Cloud%20persistence', undefined, user.session.access_token)).chats.length, 1)
    await request('POST', `/chats/${user.chat.id}/messages`, { content: 'Persistent cloud message' }, user.session.access_token, 201)
    const key = `cloud-check-${randomUUID()}`
    mediaKeys.push(key)
    user.media = (await pool.query("INSERT INTO media(user_id,chat_id,media_type,storage_driver,storage_key,mime_type,file_size) VALUES($1,$2,'file','disabled',$3,'text/plain',1) RETURNING id", [user.id, user.chat.id, key])).rows[0]
  }
  pass('settings, chat creation/list/search/rename and message persistence')
  stage = 'ownership'
  for (const [owner, other] of [[a, b], [b, a]]) {
    await request('GET', `/chats/${owner.chat.id}`, undefined, other.session.access_token, 404)
    await request('PATCH', `/chats/${owner.chat.id}`, { title: 'Not allowed' }, other.session.access_token, 404)
    await request('DELETE', `/chats/${owner.chat.id}`, undefined, other.session.access_token, 404)
    await request('GET', `/chats/${owner.chat.id}/messages`, undefined, other.session.access_token, 404)
    await request('POST', `/chats/${owner.chat.id}/messages`, { content: 'Not allowed' }, other.session.access_token, 404)
    await request('GET', `/media/${owner.media.id}`, undefined, other.session.access_token, 404)
    await request('GET', `/media/${owner.media.id}/content`, undefined, other.session.access_token, 404)
    assert.equal((await request('GET', `/media/${owner.media.id}`, undefined, owner.session.access_token)).media.storage_key, undefined)
  }
  await assert.rejects(pool.query("INSERT INTO messages(chat_id,user_id,role,content) VALUES($1,$2,'user','Rejected')", [a.chat.id, b.id]), { code: '23503' })
  pass('bidirectional chat/message/media ownership and composite foreign key enforcement')
  stage = 'backend restart'
  await app.close()
  await start()
  assert.equal((await request('GET', '/me', undefined, a.session.access_token)).user.id, a.id)
  assert.equal((await request('GET', '/me/settings', undefined, a.session.access_token)).settings.theme, 'system')
  assert.equal((await request('GET', `/chats/${a.chat.id}`, undefined, a.session.access_token)).chat.title, 'Cloud persistence verification')
  assert.equal((await request('GET', `/chats/${a.chat.id}/messages`, undefined, a.session.access_token)).messages[0].content, 'Persistent cloud message')
  pass('server close/recreation with new database pool preserves users, sessions, settings, chats and messages')
  stage = 'session rotation and revocation'
  const previous = a.session
  a.session = await request('POST', '/auth/refresh', { refresh_token: previous.refresh_token })
  assert.notEqual(a.session.refresh_token, previous.refresh_token)
  await request('GET', '/me', undefined, previous.access_token, 401)
  await request('GET', '/me', undefined, a.session.access_token)
  await request('POST', '/auth/logout', undefined, a.session.access_token, 204)
  await request('GET', '/me', undefined, a.session.access_token, 401)
  await request('POST', '/auth/refresh', { refresh_token: a.session.refresh_token }, undefined, 401)
  a.session = await request('POST', '/auth/login', { email: a.email, password: a.password })
  assert.equal(a.session.user.id, a.id)
  pass('refresh rotation, logout revocation and repeat login')
  stage = 'account deletion'
  for (const user of users) {
    await request('DELETE', '/me', { password: user.password, confirmation: 'DELETE' }, user.session.access_token, 204)
    await request('GET', '/me', undefined, user.session.access_token, 401)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [user.id])).rows[0].n, 0)
    for (const table of ['user_settings','sessions','chats','messages','media']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [user.id])).rows[0].n, 0)
    }
  }
  pass('confirmed account deletion and owned-data cleanup')
} catch {
  console.error(`FAIL: ${stage}; sensitive error details suppressed`)
  process.exitCode = 1
} finally {
  await app?.close()
  try {
    for (const user of users) await pool.query('DELETE FROM users WHERE email=$1', [user.email])
    // These metadata-only fixtures never had corresponding object-storage files.
    for (const key of mediaKeys) await pool.query("DELETE FROM storage_deletions WHERE storage_driver='disabled' AND storage_key=$1", [key])
    pass('only this run\'s random test fixtures removed')
  } catch { console.error('Fixture cleanup failed; inspect cloud-check test identities'); process.exitCode = 1 }
  await pool.end()
}
