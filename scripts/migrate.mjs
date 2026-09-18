import { runner } from 'node-pg-migrate'
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
if (process.env.NODE_ENV === 'production' && process.env.DATABASE_SSL !== 'true') throw new Error('Production migrations require verified database TLS')
try {
  await runner({ databaseUrl: { connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_FILE ? { ca: (await import('node:fs')).readFileSync(process.env.DATABASE_CA_FILE, 'utf8') } : {}) } : false },
    dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })
  console.log('Migrations applied successfully')
} catch { console.error('Migration failed. Verify connectivity, credentials, and migration state.'); process.exitCode = 1 }
