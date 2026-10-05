import { z } from 'zod'
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z.object({
    NODE_ENV: z.enum(['development','test','production']).default('development'),
    HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().url().refine(v => ['postgres:','postgresql:'].includes(new URL(v).protocol)),
    DATABASE_SSL: z.enum(['true','false']).default('false'), DATABASE_CA_FILE: z.string().default(''),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    RATE_LIMIT_SECRET: z.string().min(32).refine(v => !v.startsWith('REPLACE')),
    ACCESS_TOKEN_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
    SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    CORS_ORIGINS: z.string().default(''), TRUST_PROXY: z.enum(['false','true']).default('false'),
    STORAGE_DRIVER: z.enum(['disabled','local','supabase']).default('disabled'), STORAGE_LOCAL_ROOT: z.string().default('.local/private-media'),
    SUPABASE_URL: z.string().default(''), SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
    STORAGE_BUCKET: z.literal('chatpop-media').default('chatpop-media'),
    STORAGE_SIGNED_URL_SECONDS: z.coerce.number().int().min(30).max(300).default(60),
    STORAGE_USER_MAX_BYTES: z.coerce.number().int().min(1).max(1099511627776).default(268435456),
    STORAGE_USER_MAX_FILES: z.coerce.number().int().min(1).max(100000).default(100),
    STORAGE_MAX_IMAGE_BYTES: z.coerce.number().int().min(1).max(104857600).default(20971520),
    STORAGE_MAX_VIDEO_BYTES: z.coerce.number().int().min(1).max(104857600).default(52428800),
    STORAGE_MAX_AUDIO_BYTES: z.coerce.number().int().min(1).max(104857600).default(26214400),
    STORAGE_MAX_DOCUMENT_BYTES: z.coerce.number().int().min(1).max(104857600).default(20971520),
    STORAGE_UPLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    MAX_MEDIA_BYTES: z.coerce.number().int().min(1).max(104857600).default(104857600)
  }).safeParse(env)
  if (!parsed.success) throw new Error('Invalid environment configuration; check variable names and constraints in .env.example')
  const config = parsed.data
  if (config.NODE_ENV === 'production' && config.DATABASE_SSL !== 'true') throw new Error('Production requires verified database TLS')
  if (config.CORS_ORIGINS.split(',').includes('*')) throw new Error('Wildcard CORS is not supported')
  if (config.STORAGE_DRIVER === 'supabase') {
    let url: URL
    try { url = new URL(config.SUPABASE_URL) } catch { throw new Error('Storage configuration is incomplete') }
    if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || config.SUPABASE_SERVICE_ROLE_KEY.length < 32) throw new Error('Storage configuration is invalid')
  }
  if (config.NODE_ENV === 'production' && config.STORAGE_DRIVER === 'local') throw new Error('Production media requires cloud storage')
  return config
}
export type Config = ReturnType<typeof readConfig>
