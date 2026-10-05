import Fastify, { LogController } from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import { createHmac } from 'node:crypto'
import { z, ZodError } from 'zod'
import type pg from 'pg'
import type { Config } from './config.js'
import { createPool, transaction } from './db.js'
import { authService, safeUserColumns, type Identity } from './auth.js'
import { ApiError, notFound } from './errors.js'
import { safeMime, storageFor } from './storage.js'
import { registerUploads } from './media-upload.js'
import { supabaseStorage, type CloudStorage } from './supabase-storage.js'
import { cleanStorage } from './cleanup.js'

declare module 'fastify' { interface FastifyRequest { identity: Identity } }
const email = z.string().trim().toLowerCase().email().max(254)
const login = z.object({ email, password: z.string().min(1).max(128) }).strict()
const registration = login.extend({ password: z.string().min(12).max(128), display_name: z.string().trim().min(1).max(80).optional() })
const idParams = z.object({ id: z.string().uuid() }).strict()
const paging = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict()
const titleSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict()
const settingsSchema = z.object({
  theme: z.enum(['dark','light','system']).optional(), selected_voice: z.string().trim().min(1).max(80).optional(),
  default_ai_provider: z.enum(['auto','chatgpt','claude','gemini','deepseek']).optional(),
  default_ai_model: z.string().trim().min(1).max(100).nullable().optional(),
  language: z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/).max(35).optional()
}).strict().refine(v => Object.keys(v).length>0)
const mediaColumns = 'id,chat_id,message_id,media_type,source_type,original_filename,mime_type,file_size,width,height,duration,status,created_at,updated_at'

export async function buildApp(config: Config, options: { pool?: pg.Pool; rateLimits?: boolean; logger?: boolean; cloudStorage?: CloudStorage } = {}) {
  if (options.cloudStorage && config.NODE_ENV !== 'test') throw new Error('Storage injection is test-only')
  if (options.rateLimits === false && config.NODE_ENV !== 'test') throw new Error('Rate limits may only be disabled in tests')
  const pool = options.pool ?? createPool(config)
  const app = Fastify({ bodyLimit: 98304, requestTimeout: 300000, connectionTimeout: 10000,
    trustProxy: config.TRUST_PROXY === 'true', logController: new LogController({disableRequestLogging:true}),
    logger: options.logger === false ? false : { level: 'info', redact: { paths: ['req.headers.authorization','req.body','res.body','password','password_hash','access_token','refresh_token','DATABASE_URL'], censor: '[REDACTED]' } } })
  pool.on('error', () => app.log.error({code:'DB_POOL_ERROR'}, 'Database connection error'))
  if (!options.pool) app.addHook('onClose', async () => { await pool.end() })
  const auth = await authService(pool,config)
  app.decorateRequest('identity')
  const origins = config.CORS_ORIGINS.split(',').map(v=>v.trim()).filter(Boolean)
  await app.register(helmet)
  await app.register(cors, { origin(origin, done) {
    if (!origin || origins.includes(origin)) done(null,true)
    else done(new ApiError(403,'ORIGIN_DENIED','Origin not allowed'),false)
  }, methods: ['GET','POST','PUT','PATCH','DELETE'], allowedHeaders: ['Content-Type','Authorization'], credentials: false })
  async function rate(key: string, max: number, seconds: number) {
    if (options.rateLimits === false) return
    const hash = createHmac('sha256',config.RATE_LIMIT_SECRET).update(key).digest('hex')
    const { rows: [bucket] } = await pool.query(`INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE rate_limits.count+1 END,
      expires_at=CASE WHEN rate_limits.expires_at<=now() THEN excluded.expires_at ELSE rate_limits.expires_at END RETURNING count`, [hash,seconds])
    if (bucket.count>max) throw new ApiError(429,'RATE_LIMITED','Too many requests; try again later')
  }
  app.addHook('onRequest', async (request,reply) => {
    reply.header('Cache-Control','no-store')
    if (request.url.split('?')[0] === '/health') return
    await rate(`global:${request.ip}`,300,60)
    if (request.routeOptions.url?.startsWith('/auth/') || request.method === 'DELETE' && request.routeOptions.url === '/me') await rate(`auth-ip:${request.ip}`,30,900)
  })
  app.addHook('onResponse', async (request,reply) => {
    app.log.info({requestId:request.id,method:request.method,route:request.routeOptions.url ?? 'unmatched',status:reply.statusCode},'Request completed')
  })
  app.setErrorHandler((error,request,reply) => {
    if (error instanceof ZodError) return reply.code(400).send({error:{code:'INVALID_REQUEST',message:'Request validation failed',request_id:request.id}})
    if (error instanceof ApiError) {
      if (error.status === 429) reply.header('Retry-After','900')
      return reply.code(error.status).send({error:{code:error.code,message:error.message,request_id:request.id}})
    }
    const code = (error as {code?: string}).code
    const status = code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 413 : code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ? 415 : (error as {statusCode?:number}).statusCode === 400 ? 400 : 500
    app.log.error({requestId:request.id,code:status===500?'INTERNAL_ERROR':'INVALID_REQUEST'},'Request failed')
    return reply.code(status).send({error:{code:status===500?'INTERNAL_ERROR':'INVALID_REQUEST',message:status===500?'An unexpected error occurred':'Invalid request',request_id:request.id}})
  })
  app.setNotFoundHandler((request,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:'Resource not found',request_id:request.id}}))
  const protectedRoute = { preHandler: async (request: import('fastify').FastifyRequest) => { request.identity = await auth.authenticate(request.headers.authorization) } }
  await registerUploads(app,pool,config,protectedRoute.preHandler,rate,options.cloudStorage)

  app.get('/health', async()=>({status:'ok'}))
  app.get('/ready', async (request,reply)=> {
    try { await pool.query('SELECT 1 FROM users LIMIT 1'); return {status:'ready'} }
    catch { return reply.code(503).send({error:{code:'NOT_READY',message:'Service unavailable',request_id:request.id}}) }
  })
  app.post('/auth/register', async (request,reply)=> {
    const body = registration.parse(request.body)
    await rate(`register:${request.ip}`,5,900)
    return reply.code(201).send({user: await auth.register(body)})
  })
  app.post('/auth/login', async request=> {
    const body = login.parse(request.body)
    await rate(`login-email:${body.email}`,10,900)
    return auth.login(body)
  })
  app.post('/auth/refresh', async request=> {
    const body = z.object({refresh_token:z.string().regex(/^cp_rt_[A-Za-z0-9_-]{43}$/)}).strict().parse(request.body)
    return auth.refresh(body.refresh_token)
  })
  app.post('/auth/logout', protectedRoute, async (request,reply)=> {
    z.object({}).strict().parse(request.body ?? {})
    await auth.logout(request.identity); return reply.code(204).send()
  })
  app.get('/me', protectedRoute, async request=> {
    const { rows: [user] } = await pool.query(`SELECT ${safeUserColumns} FROM users WHERE id=$1`, [request.identity.userId])
    if (!user) throw notFound()
    return {user}
  })
  app.delete('/me', protectedRoute, async (request,reply)=> {
    const body = z.object({password:z.string().min(1).max(128),confirmation:z.literal('DELETE')}).strict().parse(request.body)
    await rate(`delete:${request.identity.userId}`,5,900)
    await auth.deleteAccount(request.identity,body.password)
    return reply.code(204).send()
  })
  app.patch('/me', protectedRoute, async request => {
    const body = z.object({display_name:z.string().trim().max(80).nullable()}).strict().parse(request.body)
    const {rows:[user]} = await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2 RETURNING ${safeUserColumns}`,
      [body.display_name || null, request.identity.userId])
    if (!user) throw notFound()
    return {user}
  })
  app.get('/me/settings', protectedRoute, async request=> {
    const {rows:[settings]} = await pool.query('SELECT * FROM user_settings WHERE user_id=$1',[request.identity.userId])
    if (!settings) throw notFound()
    return {settings}
  })
  app.patch('/me/settings', protectedRoute, async request=> {
    const body = settingsSchema.parse(request.body)
    const fields = Object.keys(body) as (keyof typeof body)[]
    // Column names are exclusively the strict schema's fixed keys; values remain parameterized.
    const { rows:[settings] } = await pool.query(`UPDATE user_settings SET ${fields.map((field,i)=>`${field}=$${i+2}`).join(',')} WHERE user_id=$1 RETURNING *`, [request.identity.userId,...fields.map(field=>body[field])])
    if (!settings) throw notFound()
    return {settings}
  })
  app.post('/chats', protectedRoute, async (request,reply)=> {
    const body = z.object({id:z.string().uuid().optional(),title:z.string().trim().min(1).max(200).optional()}).strict().parse(request.body ?? {})
    const {rows:[chat]} = await pool.query(`INSERT INTO chats(id,user_id,title,title_source) VALUES(coalesce($4::uuid,gen_random_uuid()),$1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET id=chats.id WHERE chats.user_id=$1 RETURNING *`,[request.identity.userId,body.title ?? 'New chat',body.title ? 'user' : 'default',body.id ?? null])
    if (!chat) throw notFound()
    return reply.code(201).send({chat})
  })
  app.get('/chats', protectedRoute, async request=> {
    const query = paging.extend({q:z.string().trim().max(200).optional()}).parse(request.query)
    const {rows:chats} = await pool.query(`SELECT * FROM chats WHERE user_id=$1 AND ($2::text IS NULL OR strpos(lower(title),lower($2))>0)
      ORDER BY coalesce(last_message_at,created_at) DESC,id DESC LIMIT $3 OFFSET $4`, [request.identity.userId,query.q ?? null,query.limit,query.offset])
    return {chats,limit:query.limit,offset:query.offset}
  })
  app.get('/chats/:id', protectedRoute, async request=> {
    const {id} = idParams.parse(request.params)
    const {rows:[chat]} = await pool.query('SELECT * FROM chats WHERE id=$1 AND user_id=$2',[id,request.identity.userId])
    if (!chat) throw notFound()
    return {chat}
  })
  app.patch('/chats/:id', protectedRoute, async request=> {
    const {id}=idParams.parse(request.params), body=titleSchema.parse(request.body)
    const {rows:[chat]} = await pool.query("UPDATE chats SET title=$1,title_source='user' WHERE id=$2 AND user_id=$3 RETURNING *",[body.title,id,request.identity.userId])
    if (!chat) throw notFound()
    return {chat}
  })
  app.delete('/chats/:id', protectedRoute, async (request,reply)=> {
    const {id}=idParams.parse(request.params)
    const result = await pool.query('DELETE FROM chats WHERE id=$1 AND user_id=$2',[id,request.identity.userId])
    if (!result.rowCount) throw notFound()
    return reply.code(204).send()
  })
  app.post('/chats/:id/messages', protectedRoute, async (request,reply)=> {
    const {id}=idParams.parse(request.params)
    const body=z.object({id:z.string().uuid().optional(),content:z.string().min(1).max(20000).refine(v=>v.trim().length>0)}).strict().parse(request.body)
    const message=await transaction(pool,async client=> {
      const owned=await client.query('SELECT id FROM chats WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,request.identity.userId])
      if (!owned.rowCount) throw notFound()
      const {rows:[message]}=await client.query(`INSERT INTO messages(id,chat_id,user_id,role,content) VALUES(coalesce($4::uuid,gen_random_uuid()),$1,$2,'user',$3)
        ON CONFLICT(id) DO UPDATE SET id=messages.id WHERE messages.chat_id=$1 AND messages.user_id=$2 AND messages.content=$3 AND messages.role='user' RETURNING *`,[id,request.identity.userId,body.content,body.id ?? null])
      if (!message) throw new ApiError(409,'MESSAGE_CONFLICT','Message could not be saved with this identifier')
      await client.query(`UPDATE chats SET last_message_at=greatest(last_message_at,$1),
        title=CASE WHEN title_source='default' THEN $3 ELSE title END,
        title_source=CASE WHEN title_source='default' THEN 'auto' ELSE title_source END
        WHERE id=$2`,[message.created_at,id,body.content.trim().replace(/\s+/g,' ').slice(0,80)])
      return message
    })
    return reply.code(201).send({message})
  })
  app.get('/chats/:id/messages', protectedRoute, async request=> {
    const {id}=idParams.parse(request.params),query=paging.parse(request.query)
    const owned=await pool.query('SELECT id FROM chats WHERE id=$1 AND user_id=$2',[id,request.identity.userId])
    if (!owned.rowCount) throw notFound()
    const {rows:messages}=await pool.query(`SELECT m.*,coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',a.id,'media_type',a.media_type,'mime_type',a.mime_type,'original_filename',a.original_filename) ORDER BY a.created_at,a.id)
      FROM media a WHERE a.message_id=m.id AND a.user_id=$2 AND a.status='ready' AND a.deleted_at IS NULL),'[]'::jsonb) AS attachments
      FROM messages m WHERE m.chat_id=$1 AND m.user_id=$2 ORDER BY m.created_at,m.id LIMIT $3 OFFSET $4`,[id,request.identity.userId,query.limit,query.offset])
    return {messages,limit:query.limit,offset:query.offset}
  })
  app.get('/media',protectedRoute,async request=> {
    const query=paging.extend({type:z.enum(['image','video','audio','file']).optional(),chat_id:z.string().uuid().optional(),source_type:z.enum(['uploaded','generated','camera','photo_library','audio_recording','chat_attachment']).optional()}).parse(request.query)
    const {rows}=await pool.query(`SELECT ${mediaColumns} FROM media WHERE user_id=$1 AND deleted_at IS NULL AND status='ready'
      AND ($2::text IS NULL OR media_type=$2) AND ($5::uuid IS NULL OR chat_id=$5) AND ($6::text IS NULL OR source_type=$6)
      ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
      [request.identity.userId,query.type ?? null,query.limit+1,query.offset,query.chat_id??null,query.source_type??null])
    return {media:rows.slice(0,query.limit),limit:query.limit,offset:query.offset,has_more:rows.length>query.limit}
  })
  app.delete('/media/:id',protectedRoute,async (request,reply)=> {
    const {id}=idParams.parse(request.params)
    const result=await pool.query('DELETE FROM media WHERE id=$1 AND user_id=$2',[id,request.identity.userId])
    if (!result.rowCount) throw notFound()
    return reply.code(204).send()
  })
  app.patch('/media/:id',protectedRoute,async request=>{
    const {id}=idParams.parse(request.params)
    const body=z.object({chat_id:z.string().uuid(),message_id:z.string().uuid()}).strict().parse(request.body)
    const media=await transaction(pool,async client=>{
      const owned=await client.query("SELECT id FROM media WHERE id=$1 AND user_id=$2 AND status='ready' AND deleted_at IS NULL FOR UPDATE",[id,request.identity.userId])
      if(!owned.rowCount) throw notFound()
      const message=await client.query('SELECT id FROM messages WHERE id=$1 AND chat_id=$2 AND user_id=$3',[body.message_id,body.chat_id,request.identity.userId])
      if(!message.rowCount) throw notFound()
      const {rows:[result]}=await client.query(`UPDATE media SET chat_id=$1,message_id=$2 WHERE id=$3 AND user_id=$4 RETURNING ${mediaColumns}`,[body.chat_id,body.message_id,id,request.identity.userId])
      return result
    })
    return {media}
  })
  app.get('/media/:id',protectedRoute,async request=> {
    const {id}=idParams.parse(request.params)
    const {rows:[media]}=await pool.query(`SELECT ${mediaColumns} FROM media WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,[id,request.identity.userId])
    if (!media) throw notFound()
    return {media}
  })
  app.get('/media/:id/content',protectedRoute,async (request,reply)=> {
    const {id}=idParams.parse(request.params)
    const {rows:[media]}=await pool.query('SELECT * FROM media WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[id,request.identity.userId])
    if (!media) throw notFound()
    if (media.status!=='ready') throw new ApiError(409,'MEDIA_NOT_READY','This upload is not ready')
    if (media.storage_driver==='supabase') {
      await rate(`media-sign:${request.identity.userId}`,60,60)
      const storage=supabaseStorage(config,media.storage_bucket)
      await storage.verifyPrivate()
      return reply.redirect(await storage.sign(media.storage_key))
    }
    if (!safeMime[media.media_type]?.includes(media.mime_type) || Number(media.file_size)>config.MAX_MEDIA_BYTES) throw new ApiError(415,'UNSUPPORTED_MEDIA','Media type or size is unsupported')
    const file=await storageFor(config,media.storage_driver).open(media.storage_key)
    try {
      const stat=await file.stat()
      if (!stat.isFile() || stat.size!==Number(media.file_size) || stat.size>config.MAX_MEDIA_BYTES) throw new ApiError(409,'MEDIA_UNAVAILABLE','Media is unavailable')
      reply.header('Content-Type',media.mime_type).header('Content-Disposition',`attachment; filename="${media.id}"`).header('X-Content-Type-Options','nosniff')
      return reply.send(file.createReadStream())
    } catch(error) { await file.close(); throw error }
  })
  if(config.STORAGE_DRIVER==='supabase' && config.NODE_ENV!=='test') {
    let running:Promise<unknown>|undefined
    const sweep=()=>{if(running)return;running=cleanStorage(pool,config,10).catch(()=>app.log.error({code:'STORAGE_CLEANUP_FAILED'},'Cleanup remains queued')).finally(()=>{running=undefined})}
    const timer=setInterval(sweep,60000);timer.unref()
    app.addHook('onClose',async()=>{clearInterval(timer);await running})
  }
  await app.ready()
  return app
}
