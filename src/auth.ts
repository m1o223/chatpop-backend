import { randomBytes, createHash } from 'node:crypto'
import argon2 from 'argon2'
import type pg from 'pg'
import type { Config } from './config.js'
import { transaction } from './db.js'
import { ApiError, unauthorized } from './errors.js'

export const safeUserColumns = 'id,email,display_name,auth_provider,created_at,updated_at,last_login_at,account_status'
export type Identity = { userId: string; sessionId: string }
export const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const token = (kind: string) => `cp_${kind}_${randomBytes(32).toString('base64url')}`
export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 })

export async function authService(pool: pg.Pool, config: Config) {
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'))
  async function issue(client: pg.PoolClient, userId: string) {
    const access = token('at'), refresh = token('rt')
    const { rows: [session] } = await client.query(`INSERT INTO sessions(user_id,access_token_hash,access_expires_at,expires_at)
      VALUES($1,$2,now()+$3*interval '1 second',now()+$4*interval '1 day') RETURNING id,expires_at`, [userId,digest(access),config.ACCESS_TOKEN_SECONDS,config.SESSION_DAYS])
    await client.query('INSERT INTO refresh_tokens(token_hash,session_id,expires_at) VALUES($1,$2,$3)', [digest(refresh),session.id,session.expires_at])
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: config.ACCESS_TOKEN_SECONDS }
  }
  return {
    async register(input: { email: string; password: string; display_name?: string }) {
      const hash = await hashPassword(input.password)
      try {
        return await transaction(pool, async client => {
          const { rows: [user] } = await client.query(`INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING ${safeUserColumns}`, [input.email,hash,input.display_name ?? null])
          await client.query('INSERT INTO user_settings(user_id) VALUES($1)', [user.id])
          return user
        })
      } catch (error) {
        if ((error as {code?:string}).code === '23505') throw new ApiError(409,'EMAIL_EXISTS','An account with this email already exists')
        throw error
      }
    },
    async login(input: { email: string; password: string }) {
      const { rows: [found] } = await pool.query('SELECT id,password_hash,account_status FROM users WHERE email=$1', [input.email])
      const valid = await argon2.verify(found?.password_hash ?? dummyHash, input.password)
      if (!valid || !found?.password_hash || found.account_status !== 'active') throw unauthorized()
      return transaction(pool, async client => {
        const { rows: [user] } = await client.query(`UPDATE users SET last_login_at=now() WHERE id=$1 AND account_status='active' RETURNING ${safeUserColumns}`, [found.id])
        if (!user) throw unauthorized()
        return { user, ...await issue(client,user.id) }
      })
    },
    async authenticate(header?: string): Promise<Identity> {
      if (!header || !/^Bearer cp_at_[A-Za-z0-9_-]{43}$/.test(header)) throw unauthorized()
      const { rows: [session] } = await pool.query(`UPDATE sessions s SET last_used_at=now() FROM users u
        WHERE s.user_id=u.id AND u.account_status='active' AND s.access_token_hash=$1
        AND s.revoked_at IS NULL AND s.expires_at>now() AND s.access_expires_at>now() RETURNING s.id,s.user_id`, [digest(header.slice(7))])
      if (!session) throw unauthorized()
      return { userId: session.user_id, sessionId: session.id }
    },
    async refresh(raw: string) {
      const result = await transaction(pool, async client => {
        const { rows: [old] } = await client.query(`SELECT t.consumed_at,t.expires_at,s.id,s.revoked_at,s.user_id,s.expires_at AS session_expires_at
          FROM refresh_tokens t JOIN sessions s ON s.id=t.session_id WHERE t.token_hash=$1 FOR UPDATE OF s,t`, [digest(raw)])
        if (!old || old.revoked_at) return null
        if (old.consumed_at) {
          // Commit revocation even though the caller receives a 401 after the transaction.
          await client.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [old.id]); return null
        }
        if (Math.min(new Date(old.expires_at).getTime(),new Date(old.session_expires_at).getTime()) <= Date.now()) return null
        const { rows: [user] } = await client.query('SELECT id FROM users WHERE id=$1 AND account_status=$2', [old.user_id,'active'])
        if (!user) return null
        const access = token('at'), refresh = token('rt')
        await client.query('UPDATE refresh_tokens SET consumed_at=now() WHERE token_hash=$1', [digest(raw)])
        await client.query(`UPDATE sessions SET access_token_hash=$1,access_expires_at=least(expires_at,now()+$2*interval '1 second'),last_used_at=now() WHERE id=$3`, [digest(access),config.ACCESS_TOKEN_SECONDS,old.id])
        await client.query('INSERT INTO refresh_tokens(token_hash,session_id,expires_at) VALUES($1,$2,$3)', [digest(refresh),old.id,old.expires_at])
        return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: Math.min(config.ACCESS_TOKEN_SECONDS, Math.floor((new Date(old.expires_at).getTime()-Date.now())/1000)) }
      })
      if (!result) throw unauthorized()
      return result
    },
    async logout(identity: Identity) { await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2', [identity.sessionId,identity.userId]) },
    async deleteAccount(identity: Identity, password: string) {
      const { rows: [user] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [identity.userId])
      if (!user?.password_hash || !await argon2.verify(user.password_hash,password)) throw unauthorized()
      await transaction(pool, async client => {
        // Cascades remove sessions/settings/history/metadata; media triggers queue file cleanup atomically.
        await client.query('DELETE FROM users WHERE id=$1', [identity.userId])
      })
    }
  }
}
