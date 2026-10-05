import { StorageClient } from '@supabase/storage-js'
import { createReadStream } from 'node:fs'
import type { Config } from './config.js'
import { ApiError } from './errors.js'

export interface CloudStorage {
  verifyPrivate(): Promise<void>
  put(key: string, path: string, mime: string, sha256: string): Promise<void>
  sign(key: string): Promise<string>
  delete(key: string): Promise<void>
}
const unavailable = () => new ApiError(503,'STORAGE_UNAVAILABLE','Private media storage is unavailable')
export function supabaseStorage(config: Config, bucket: string = config.STORAGE_BUCKET): CloudStorage {
  if (config.STORAGE_DRIVER !== 'supabase' || bucket !== config.STORAGE_BUCKET) throw unavailable()
  const client = new StorageClient(config.SUPABASE_URL.replace(/\/$/,'')+'/storage/v1',
    {apikey:config.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`},
    (url, init) => fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(120000)}))
  const files=client.from(bucket)
  function keyCheck(key: string) {
    if (!/^users\/[0-9a-f-]{36}\/(image|video|audio|file)\/[0-9a-f-]{36}$/.test(key)) throw unavailable()
  }
  return {
    async verifyPrivate() {
      const {data,error}=await client.getBucket(bucket)
      if(error || !data || data.public !== false) throw unavailable()
    },
    async put(key,path,mime,sha256) {
      keyCheck(key)
      const stream=createReadStream(path)
      try {
        const {error}=await files.upload(key,stream,{contentType:mime,cacheControl:'0',upsert:false,metadata:{sha256}})
        if(error) throw unavailable()
      } finally { stream.destroy() }
    },
    async sign(key) {
      keyCheck(key)
      const {data,error}=await files.createSignedUrl(key,config.STORAGE_SIGNED_URL_SECONDS,{download:true})
      if(error || !data) throw unavailable()
      const url=new URL(data.signedUrl)
      if(url.origin!==new URL(config.SUPABASE_URL).origin || !url.pathname.startsWith('/storage/v1/object/sign/')) throw unavailable()
      return url.href
    },
    async delete(key) {
      keyCheck(key)
      const {error}=await files.remove([key])
      if(error) throw unavailable()
    }
  }
}
