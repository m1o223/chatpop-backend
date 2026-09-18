import { resolve, sep, isAbsolute, relative } from 'node:path'
import { constants } from 'node:fs'
import { open, unlink, realpath } from 'node:fs/promises'
import type { Config } from './config.js'
import { ApiError } from './errors.js'

export interface PrivateStorage {
  delete(key: string): Promise<void>
  open(key: string): Promise<import('node:fs/promises').FileHandle>
}
// Future S3-compatible adapters belong here; routes never construct vendor URLs.
export function storageFor(config: Config, driver: string): PrivateStorage {
  if (driver !== 'local' || config.STORAGE_DRIVER !== 'local') throw new ApiError(503,'STORAGE_UNAVAILABLE','Private storage is not configured')
  const root = resolve(config.STORAGE_LOCAL_ROOT)
  async function path(key: string) {
    if (!/^[a-zA-Z0-9/_-]{1,512}$/.test(key) || isAbsolute(key)) throw new Error('Invalid storage key')
    const target = resolve(root,key)
    if (!target.startsWith(root+sep)) throw new Error('Invalid storage key')
    // Reject symlink escapes, including intermediate directories.
    const actualRoot = await realpath(root), actual = await realpath(target)
    const rel = relative(actualRoot,actual)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid storage path')
    return target
  }
  return {
    async delete(key) {
      await realpath(root)
      try { await unlink(await path(key)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    },
    async open(key) { return open(await path(key), constants.O_RDONLY | constants.O_NOFOLLOW) }
  }
}
export const safeMime: Record<string, readonly string[]> = {
  image: ['image/png','image/jpeg','image/webp'], video: ['video/mp4','video/webm'],
  audio: ['audio/mpeg','audio/mp4','audio/wav','audio/ogg'], file: ['application/pdf','text/plain']
}
