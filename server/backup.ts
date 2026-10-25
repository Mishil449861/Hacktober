/**
 * Keeps the boards when the hosted demo's disk is wiped (Streamlit Community Cloud restarts apps on a fresh
 * disk, e.g. after 12 hours asleep). With ORGMAP_DB_BACKUP=cloudinary, data/db.json is copied to the
 * Cloudinary account as a PRIVATE raw file: it can only be downloaded with the API secret, never by URL.
 * On startup, an empty database is restored from that copy.
 */
import { v2 as cloudinary } from 'cloudinary'
import { cloudinaryEnabled } from './cloudinary.ts'
import { onPersist, store } from './store.ts'

const PUBLIC_ID = process.env.ORGMAP_DB_BACKUP_ID || 'orgmap-backup/db.json'
export const backupEnabled = process.env.ORGMAP_DB_BACKUP === 'cloudinary' && cloudinaryEnabled
/**
 * Set when the backup exists but couldn't be read (Cloudinary briefly unreachable, ...). Uploading after
 * that would replace everyone's boards with this server's empty start, so backups stay off until a restart.
 */
let restoreFailed = false

export async function restoreBackup() {
  if (!backupEnabled || store.db.workspaces.length) return
  const url = cloudinary.utils.private_download_url(PUBLIC_ID, '', { resource_type: 'raw', type: 'private' })
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (res.status === 404) return void console.log('[backup] no backup yet: starting empty')
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
      const db = await res.json()
      if (!Array.isArray(db?.workspaces)) throw new Error('backup is not an OrgMap database')
      store.db = db
      return void console.log(`[backup] restored ${db.workspaces.length} board(s) from Cloudinary`)
    } catch (e) {
      console.error(`[backup] restore attempt ${attempt} failed:`, (e as Error).message)
      if (attempt < 3) await new Promise((r) => setTimeout(r, Number(process.env.ORGMAP_BACKUP_RETRY_MS ?? 3000) * attempt))
    }
  }
  restoreFailed = true
  console.error('[backup] could not restore: starting empty, and NOT backing up (the old backup is kept). Restart the app to retry.')
}

let timer: NodeJS.Timeout | undefined
let uploading = false
/** Upload at most every 20 s, after changes settle. */
function scheduleBackup() {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    if (uploading) return scheduleBackup()
    uploading = true
    try {
      const body = Buffer.from(JSON.stringify(store.db))
      await new Promise((resolve, reject) => cloudinary.uploader.upload_stream(
        { resource_type: 'raw', type: 'private', public_id: PUBLIC_ID, overwrite: true, invalidate: true },
        (err, r) => (err ? reject(err) : resolve(r)),
      ).end(body))
    } catch (e) {
      console.error('[backup] upload failed, retrying later:', (e as { message?: string }).message ?? e)
      timer = setTimeout(scheduleBackup, 60_000)
    } finally {
      uploading = false
    }
  }, 20_000)
}

/** For tests and logs: is the backup on, and did the restore fail? */
export const backupState = () => ({ enabled: backupEnabled, restoreFailed, active })
let active = false

export function startBackup() {
  if (!backupEnabled || restoreFailed) return
  active = true
  onPersist(scheduleBackup)
  console.log(`[backup] boards are backed up to Cloudinary (private raw file "${PUBLIC_ID}")`)
}
