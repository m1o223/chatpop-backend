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
    STORAGE_DRIVER: z.enum(['disabled','local']).default('disabled'), STORAGE_LOCAL_ROOT: z.string().default('.local/private-media'),
    MAX_MEDIA_BYTES: z.coerce.number().int().min(1).max(104857600).default(104857600)
  }).safeParse(env)
  if (!parsed.success) throw new Error('Invalid environment configuration; check variable names and constraints in .env.example')
  const config = parsed.data
  if (config.NODE_ENV === 'production' && config.DATABASE_SSL !== 'true') throw new Error('Production requires verified database TLS')
  if (config.CORS_ORIGINS.split(',').includes('*')) throw new Error('Wildcard CORS is not supported')
  return config
}
export type Config = ReturnType<typeof readConfig>
