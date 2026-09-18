import type pg from 'pg'
import { pathToFileURL } from 'node:url'
import { readConfig, type Config } from './config.js'
import { createPool, transaction } from './db.js'
import { storageFor } from './storage.js'

export async function cleanStorage(pool: pg.Pool, config: Config, limit = 50) {
  let processed = 0
  for (let i=0;i<limit;i++) {
    const found = await transaction(pool, async client => {
      const { rows: [job] } = await client.query(`SELECT * FROM storage_deletions WHERE completed_at IS NULL AND next_attempt_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`)
      if (!job) return false
      try {
        await storageFor(config,job.storage_driver).delete(job.storage_key)
        await client.query('DELETE FROM storage_deletions WHERE id=$1', [job.id])
      } catch {
        await client.query(`UPDATE storage_deletions SET attempts=attempts+1,next_attempt_at=now()+least(3600,power(2,least(attempts+1,12))) * interval '1 second' WHERE id=$1`, [job.id])
      }
      return true
    })
    if (!found) break
    processed++
  }
  // Expired refresh history is kept for the whole session lifetime to detect replay.
  await pool.query('DELETE FROM sessions WHERE expires_at<now()')
  await pool.query('DELETE FROM rate_limits WHERE expires_at<now()')
  return processed
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig(), pool = createPool(config)
  try { console.log(JSON.stringify({processed: await cleanStorage(pool,config)})) }
  catch { console.error('Cleanup failed; jobs remain queued for retry'); process.exitCode=1 }
  finally { await pool.end() }
}
