/**
 * Cloudinary inbox: photos that land in `orgmap-inbox/<workspace-slug>` (from the /capture page,
 * the Cloudinary Media Library, or the Cloudinary mobile app) are imported as sources and
 * analyzed automatically. A localhost app cannot receive Cloudinary webhooks, so we poll:
 * one Admin API call per tick (newest uploads first), well under the hourly rate limit.
 */
import { v2 as cloudinary } from 'cloudinary'
import type { Source, Workspace } from '../src/shared/schema.ts'
import { cloudinaryEnabled, previewUrl, thumbUrl } from './cloudinary.ts'
import { newId, now, persist, store } from './store.ts'

export const INBOX_ROOT = process.env.CLOUDINARY_INBOX_FOLDER ?? 'orgmap-inbox'
const POLL_MS = Number(process.env.CLOUDINARY_INBOX_POLL_SECONDS ?? 15) * 1000

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workspace'
export const inboxFolder = (ws: Workspace) => `${INBOX_ROOT}/${slug(ws.name)}`

export const inboxState = { enabled: false, lastPollAt: undefined as string | undefined, lastError: undefined as string | undefined, imported: 0 }

/** Create the workspace's inbox folder so it shows up in the Media Library / mobile app. */
export async function ensureInboxFolder(ws: Workspace) {
  if (!cloudinaryEnabled) return
  await cloudinary.api.create_folder(inboxFolder(ws)).catch(() => undefined)
}

interface CldResource {
  asset_id: string; public_id: string; secure_url: string; width: number; height: number
  format: string; created_at: string; asset_folder?: string; display_name?: string; resource_type: string
}

function workspaceForFolder(folder: string): Workspace | undefined {
  const workspaces = store.db.workspaces
  if (folder === INBOX_ROOT) return workspaces.at(-1) // bare inbox -> newest workspace
  const s = folder.slice(INBOX_ROOT.length + 1).split('/')[0]
  return workspaces.find((w) => slug(w.name) === s)
}

async function pollOnce(onImported: (sourceId: string) => void) {
  if (!store.db.workspaces.length) return
  const res = (await cloudinary.api.resources({ type: 'upload', resource_type: 'image', max_results: 50, direction: -1 })) as { resources: CldResource[] }
  const known = new Set(store.db.sources.map((s) => s.cloudinary?.assetId).filter(Boolean))
  const fresh = res.resources
    .filter((r) => r.asset_folder && (r.asset_folder === INBOX_ROOT || r.asset_folder.startsWith(INBOX_ROOT + '/')))
    .filter((r) => !known.has(r.asset_id))
    .reverse() // oldest first, so meetings merge in the order photos were taken

  for (const r of fresh) {
    const ws = workspaceForFolder(r.asset_folder!)
    if (!ws) continue
    const src: Source = {
      id: newId(), workspaceId: ws.id, type: 'IMAGE', status: 'PENDING', createdAt: now(), origin: 'inbox',
      meetingDate: r.created_at.slice(0, 10),
      name: `${r.display_name || r.public_id.split('/').pop()} (photo ${new Date(r.created_at).toLocaleString()})`,
      cloudinary: {
        publicId: r.public_id, assetId: r.asset_id, secureUrl: r.secure_url,
        width: r.width, height: r.height, format: r.format, createdAt: r.created_at,
      },
      previewUrl: previewUrl(r.public_id), thumbUrl: thumbUrl(r.public_id),
    }
    store.db.sources.push(src)
    inboxState.imported++
    console.log(`[inbox] imported ${r.public_id} -> ${ws.name}`)
    persist()
    onImported(src.id)
  }
}

let pollNowFn: (() => Promise<void>) | undefined
/** Called right after the capture page uploads, so the photo shows up without waiting for the next tick. */
export const pollNow = () => pollNowFn?.()

export function startInbox(onImported: (sourceId: string) => void) {
  if (!cloudinaryEnabled || process.env.CLOUDINARY_INBOX === 'false') return
  inboxState.enabled = true
  for (const ws of store.db.workspaces) void ensureInboxFolder(ws)
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await pollOnce(onImported)
      inboxState.lastError = undefined
    } catch (e) {
      inboxState.lastError = (e as { error?: { message?: string }; message?: string }).error?.message ?? (e as Error).message
      console.warn('[inbox] poll failed:', inboxState.lastError)
    } finally {
      inboxState.lastPollAt = now()
      running = false
    }
  }
  pollNowFn = tick
  void tick()
  setInterval(tick, POLL_MS)
  console.log(`[inbox] watching Cloudinary folder "${INBOX_ROOT}/<workspace>" every ${POLL_MS / 1000}s`)
}

/** Signature for the Upload Widget on /capture. Only uploads into the inbox are signed. */
export function signInboxUpload(params: Record<string, unknown>) {
  const folder = String(params.folder ?? params.asset_folder ?? '')
  if (!(folder === INBOX_ROOT || folder.startsWith(INBOX_ROOT + '/'))) throw new Error('Uploads may only target the OrgMap inbox folder')
  return cloudinary.utils.api_sign_request(params as Record<string, string>, process.env.CLOUDINARY_API_SECRET!)
}
