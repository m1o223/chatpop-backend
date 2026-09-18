import { randomBytes, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { readConfig } from '../dist/config.js'
import { createPool } from '../dist/db.js'

const config = readConfig()
const database = new URL(config.DATABASE_URL)
const address = new URL(process.env.AUTH_SMOKE_BASE_URL ?? 'http://127.0.0.1:3000')
const localAddresses = new Set(['127.0.0.1', 'localhost', ...Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? [])])
if (config.NODE_ENV !== 'development' || database.hostname !== '127.0.0.1' || database.port !== '55432' || database.pathname !== '/chatpop'
  || !localAddresses.has(address.hostname) || !['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
  throw new Error('This verification only targets the bundled development database and a local API address')
}

const pool = createPool(config)
const email = `native-auth-check-${randomUUID()}@example.test`
const password = randomBytes(32).toString('base64url')
let createdUserId
function check(condition, message) {
  if (!condition) throw new Error(message)
}
async function request(method, path, body, token, status = 200) {
  const response = await fetch(new URL(path, address), {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
    redirect: 'error'
  })
  check(response.status === status, `Unexpected response status for ${method} ${path}: ${response.status}`)
  return response.status === 204 ? undefined : response.json()
}

try {
  await request('GET', '/ready')
  const registered = await request('POST', '/auth/register', { email, password }, undefined, 201)
  createdUserId = registered.user.id
  const { rows: [persisted] } = await pool.query('SELECT id,password_hash FROM users WHERE id=$1 AND email=$2', [createdUserId, email])
  check(persisted?.id === createdUserId && persisted.password_hash.startsWith('$argon2id$') && persisted.password_hash !== password, 'Registration did not persist the expected Argon2id user')
  check(!('password_hash' in registered.user), 'Registration exposed a password hash')
  const duplicate = await request('POST', '/auth/register', { email, password }, undefined, 409)
  check(duplicate.error.code === 'EMAIL_EXISTS', 'Duplicate email contract differs')
  const wrong = await request('POST', '/auth/login', { email, password: 'incorrect-password' }, undefined, 401)
  check(wrong.error.code === 'UNAUTHORIZED', 'Wrong-password contract differs')
  const signedIn = await request('POST', '/auth/login', { email, password })
  const me = await request('GET', '/me', undefined, signedIn.access_token)
  check(me.user.id === createdUserId && me.user.email === email && !('password_hash' in me.user), 'Current user contract differs')
  const refreshed = await request('POST', '/auth/refresh', { refresh_token: signedIn.refresh_token })
  check(refreshed.access_token !== signedIn.access_token && refreshed.refresh_token !== signedIn.refresh_token, 'Refresh did not rotate credentials')
  await request('GET', '/me', undefined, signedIn.access_token, 401)
  await request('GET', '/me', undefined, refreshed.access_token)
  await request('POST', '/auth/logout', undefined, refreshed.access_token, 204)
  await request('GET', '/me', undefined, refreshed.access_token, 401)
  await request('POST', '/auth/refresh', { refresh_token: refreshed.refresh_token }, undefined, 401)
  const returning = await request('POST', '/auth/login', { email, password })
  check(returning.user.id === createdUserId, 'Login did not return the original user')
  await request('DELETE', '/me', { password, confirmation: 'DELETE' }, returning.access_token, 204)
  await request('GET', '/me', undefined, returning.access_token, 401)
  const { rows: [remaining] } = await pool.query('SELECT EXISTS(SELECT 1 FROM users WHERE id=$1) AS present', [createdUserId])
  check(!remaining.present, 'Account deletion left the user in PostgreSQL')
  console.log('PASS: real HTTP registration + PostgreSQL hash, duplicate email, wrong password, login, /me, refresh rotation, logout revocation, login again, and confirmed account deletion. Temporary account removed; no credentials logged.')
} finally {
  // Only remove this invocation's random test identity, never pre-existing users.
  if (createdUserId) await pool.query('DELETE FROM users WHERE id=$1 AND email=$2', [createdUserId, email])
  await pool.end()
}
