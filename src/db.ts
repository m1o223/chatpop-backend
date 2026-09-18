import pg from 'pg'
import { readFileSync } from 'node:fs'
import type { Config } from './config.js'
export const createPool = (config: Config) => new pg.Pool({ connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
  statement_timeout: 10000, idle_in_transaction_session_timeout: 15000,
  ssl: config.DATABASE_SSL === 'true' ? { rejectUnauthorized: true, ...(config.DATABASE_CA_FILE ? { ca: readFileSync(config.DATABASE_CA_FILE, 'utf8') } : {}) } : false })
export async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
