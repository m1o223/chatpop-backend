import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileTypeFromFile } from 'file-type'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { Config } from './config.js'
import { transaction } from './db.js'
import { ApiError, notFound } from './errors.js'
import { supabaseStorage, type CloudStorage } from './supabase-storage.js'

const formats: Record<string,string> = {'image/jpeg':'image','image/png':'image','image/webp':'image','video/mp4':'video','video/quicktime':'video','application/pdf':'file','audio/mpeg':'audio','audio/mp4':'audio','audio/x-m4a':'audio','audio/wav':'audio','audio/vnd.wave':'audio'}
export const uploadSchema=z.object({
  upload_key:z.string().uuid(),mime_type:z.string().max(100),file_size:z.number().int().positive(),sha256:z.string().regex(/^[0-9a-f]{64}$/),
  original_filename:z.string().max(512),source_type:z.enum(['uploaded','camera','photo_library','audio_recording','chat_attachment']).default('uploaded'),
  chat_id:z.string().uuid().optional(),message_id:z.string().uuid().optional()
}).strict().refine(v=>!v.message_id || !!v.chat_id)
export function safeFilename(value:string) {return value.normalize('NFKC').replace(/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,160)||'Upload'}
export const publicMedia=(row:Record<string,unknown>)=>Object.fromEntries(['id','chat_id','message_id','media_type','source_type','original_filename','mime_type','file_size','width','height','duration','status','created_at','updated_at'].map(k=>[k,row[k]]))

export async function stageUpload(stream:Readable, expected:{file_size:number;sha256:string;mime_type:string}) {
  const dir=await mkdtemp(join(tmpdir(),'chatpop-upload-')),path=join(dir,'body')
  let bytes=0
  const hash=createHash('sha256')
  try {
    await pipeline(stream,new Transform({transform(chunk:Buffer,_encoding,done){
      bytes+=chunk.length
      if(bytes>expected.file_size) return done(new ApiError(413,'FILE_TOO_LARGE','File exceeds the reserved upload size'))
      hash.update(chunk);done(null,chunk)
    }}),createWriteStream(path,{mode:0o600}),{signal:AbortSignal.timeout(300000)})
    if(bytes!==expected.file_size || hash.digest('hex')!==expected.sha256) throw new ApiError(400,'FILE_INTEGRITY','File size or checksum does not match')
    const detected=await fileTypeFromFile(path)
    const canonical=(mime:string)=>mime==='audio/x-m4a'?'audio/mp4':mime==='audio/vnd.wave'?'audio/wav':mime
    if(!detected || canonical(detected.mime)!==canonical(expected.mime_type)) throw new ApiError(415,'UNSUPPORTED_FILE_TYPE','The file content does not match its supported format')
    return {path,clean:()=>rm(dir,{recursive:true,force:true})}
  } catch(error) {await rm(dir,{recursive:true,force:true});throw error}
}

export async function registerUploads(app:FastifyInstance,pool:pg.Pool,config:Config,authenticate:(request:FastifyRequest)=>Promise<void>,rate:(key:string,max:number,seconds:number)=>Promise<void>,injected?:CloudStorage) {
  let active=0
  const cloud=()=>injected ?? supabaseStorage(config)
  const enabled=()=>{if(config.STORAGE_DRIVER!=='supabase'&&!injected) throw new ApiError(503,'STORAGE_UNAVAILABLE','Cloud uploads are not configured')}
  app.post('/media/uploads',{preHandler:authenticate},async(request,reply)=>{
    enabled();const body=uploadSchema.parse(request.body),owner=request.identity.userId,type=formats[body.mime_type]
    if(!type) throw new ApiError(415,'UNSUPPORTED_FILE_TYPE','This file type is not supported')
    await rate(`upload-reserve:${owner}`,30,60)
    const limits:Record<string,number>={image:config.STORAGE_MAX_IMAGE_BYTES,video:config.STORAGE_MAX_VIDEO_BYTES,audio:config.STORAGE_MAX_AUDIO_BYTES,file:config.STORAGE_MAX_DOCUMENT_BYTES}
    if(body.file_size>Math.min(config.MAX_MEDIA_BYTES,limits[type]!)) throw new ApiError(413,'FILE_TOO_LARGE','This file exceeds the upload limit')
    await cloud().verifyPrivate()
    const row=await transaction(pool,async client=>{
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[owner])
      const {rows:[prior]}=await client.query('SELECT * FROM media WHERE user_id=$1 AND upload_key=$2',[owner,body.upload_key])
      if(prior){
        if(prior.sha256!==body.sha256||Number(prior.file_size)!==body.file_size||prior.mime_type!==body.mime_type||prior.chat_id!==(body.chat_id??null)||prior.message_id!==(body.message_id??null)) throw new ApiError(409,'UPLOAD_CONFLICT','Upload retry details do not match')
        return prior
      }
      if(body.chat_id && !(await client.query('SELECT id FROM chats WHERE id=$1 AND user_id=$2',[body.chat_id,owner])).rowCount) throw notFound()
      if(body.message_id && !(await client.query('SELECT id FROM messages WHERE id=$1 AND chat_id=$2 AND user_id=$3',[body.message_id,body.chat_id,owner])).rowCount) throw notFound()
      const {rows:[usage]}=await client.query(`SELECT count(*)::int AS count,coalesce(sum(file_size),0)::bigint AS bytes FROM
        (SELECT file_size FROM media WHERE user_id=$1 UNION ALL SELECT file_size FROM storage_deletions WHERE owner_id=$1) AS reserved`,[owner])
      if(usage.count>=config.STORAGE_USER_MAX_FILES || Number(usage.bytes)+body.file_size>config.STORAGE_USER_MAX_BYTES) throw new ApiError(413,'STORAGE_QUOTA','Your account storage limit has been reached')
      const id=randomUUID(),key=`users/${owner}/${type}/${id}`
      const {rows:[media]}=await client.query(`INSERT INTO media(id,user_id,chat_id,message_id,media_type,storage_driver,storage_bucket,storage_key,mime_type,file_size,source_type,original_filename,status,sha256,upload_key)
        VALUES($1,$2,$3,$4,$5,'supabase',$6,$7,$8,$9,$10,$11,'pending',$12,$13) RETURNING *`,
      [id,owner,body.chat_id??null,body.message_id??null,type,config.STORAGE_BUCKET,key,body.mime_type,body.file_size,body.source_type,safeFilename(body.original_filename),body.sha256,body.upload_key])
      return media
    })
    return reply.code(201).send({media:publicMedia(row)})
  })
  // The parser returns a stream. Authentication runs onRequest before reading any binary data.
  app.addContentTypeParser('application/octet-stream',(_request,payload,done)=>done(null,payload))
  app.put('/media/:id/content',{onRequest:authenticate,bodyLimit:config.MAX_MEDIA_BYTES},async(request,reply)=>{
    enabled();const {id}=z.object({id:z.string().uuid()}).parse(request.params),owner=request.identity.userId
    await rate(`upload:${owner}`,20,60)
    if(active>=config.STORAGE_UPLOAD_CONCURRENCY) throw new ApiError(429,'UPLOAD_BUSY','Uploads are busy; try again shortly')
    if(request.headers['content-type']!=='application/octet-stream') throw new ApiError(415,'UNSUPPORTED_FILE_TYPE','Send the upload as binary data')
    const {rows:[reserved]}=await pool.query('SELECT * FROM media WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[id,owner])
    if(!reserved) throw notFound()
    if(reserved.storage_driver!=='supabase'||reserved.storage_bucket!==config.STORAGE_BUCKET) throw notFound()
    if(reserved.status==='ready') {request.raw.resume();return {media:publicMedia(reserved)}}
    if(request.headers['content-length']!==String(reserved.file_size)) throw new ApiError(400,'FILE_SIZE_REQUIRED','Content-Length must match the reserved file size')
    active++
    let staged:Awaited<ReturnType<typeof stageUpload>>|undefined
    try {
      staged=await stageUpload(request.body as Readable,{file_size:Number(reserved.file_size),sha256:reserved.sha256,mime_type:reserved.mime_type})
      const file=staged.path
      const saved=await transaction(pool,async client=>{
        // Keep deletion from racing an in-flight cloud write. A crash leaves the pending row for cleanup.
        await client.query("SET LOCAL idle_in_transaction_session_timeout='420s'")
        const {rows:[row]}=await client.query('SELECT * FROM media WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,owner])
        if(!row) throw notFound()
        if(row.status==='ready') return row
        const storage=cloud();await storage.verifyPrivate()
        // Remove a possibly completed object from a previous ambiguous attempt under the same row lock.
        await storage.delete(row.storage_key)
        await storage.put(row.storage_key,file,row.mime_type,row.sha256)
        const {rows:[ready]}=await client.query("UPDATE media SET status='ready' WHERE id=$1 RETURNING *",[id])
        return ready
      })
      return reply.send({media:publicMedia(saved)})
    } catch(error) {
      await pool.query("UPDATE media SET status='failed' WHERE id=$1 AND user_id=$2 AND status<>'ready'",[id,owner]).catch(()=>{})
      throw error
    } finally {active--;await staged?.clean()}
  })
  app.post('/media/:id/signed-url',{preHandler:authenticate},async request=>{
    enabled();const {id}=z.object({id:z.string().uuid()}).parse(request.params)
    z.object({}).strict().parse(request.body??{})
    await rate(`media-sign:${request.identity.userId}`,60,60)
    const {rows:[media]}=await pool.query("SELECT * FROM media WHERE id=$1 AND user_id=$2 AND status='ready' AND deleted_at IS NULL",[id,request.identity.userId])
    if(!media||media.storage_driver!=='supabase'||media.storage_bucket!==config.STORAGE_BUCKET) throw notFound()
    const storage=cloud();await storage.verifyPrivate()
    return {url:await storage.sign(media.storage_key),expires_in:config.STORAGE_SIGNED_URL_SECONDS}
  })
}
