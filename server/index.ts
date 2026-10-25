import 'dotenv/config'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { NODE_STATUSES, NODE_TYPES, RELATIONSHIP_TYPES, type GraphEdge, type Source, type SystemStatus } from '../src/shared/schema.ts'
import { analysisUrl, cloudName, cloudinaryEnabled, deleteImage, previewUrl, thumbUrl, uploadImage } from './cloudinary.ts'
import { analyzeImage, analyzeText, runtime, systemInfo, type Trace } from './lib/ai/provider.ts'
import { AI_PROVIDERS, checkKey, keyRuntime, withAi, type AiKey } from './lib/ai/runtimes.ts'
import { restoreBackup, startBackup } from './backup.ts'
import { deriveState, mergeExtraction, mergeNodes, retractHistory } from './graph/reconcile.ts'
import { buildReport, buildViews } from './views.ts'
import { DATA_DIR, newId, now, persist, persistError, store, UPLOAD_DIR } from './store.ts'
import { ensureInboxFolder, inboxFolder, inboxState, INBOX_ROOT, pollNow, removeProjectFolders, signInboxUpload, startInbox } from './inbox.ts'
import { capturePage } from './capture.ts'

const port = Number(process.env.PORT ?? 8787)

/**
 * Fingerprint of the server's code (server/**.ts, the shared schema, the package lock), reported by
 * /api/status. The hosted demo page computes the same from its own files (demo/server_boot.py
 * code_version) and restarts a server left running from before an update. Keep the two in step.
 */
const ROOT_DIR = path.resolve(import.meta.dirname, '..')
const codeVersion = (() => {
  const files = [
    ...fs.readdirSync(path.join(ROOT_DIR, 'server'), { recursive: true }).map((f) => `server/${String(f).split(path.sep).join('/')}`).filter((f) => f.endsWith('.ts')),
    'src/shared/schema.ts', 'package-lock.json',
  ].sort()
  const h = createHash('sha1')
  for (const f of files) {
    h.update(f); h.update('\0')
    try { h.update(fs.readFileSync(path.join(ROOT_DIR, f))) } catch { /* missing file: hashed as empty */ }
  }
  return h.digest('hex').slice(0, 12)
})()
const app = express()
app.use(express.json({ limit: '2mb' }))
// Text-only sources may arrive as a plain form post (e.g. Python `requests.post(data=...)`), not multipart.
app.use(express.urlencoded({ extended: false, limit: '2mb' }))
app.use('/uploads', express.static(UPLOAD_DIR))

/**
 * Extraction traces (data/debug/<source id>.json, also GET /api/sources/:id/trace): what OCR, the model,
 * the notes parser, cleanup and the merge each produced. On by default in development; ORGMAP_DEBUG=false
 * turns it off, ORGMAP_DEBUG=true turns it on in production. Contains the source's text and the model's
 * output, never credentials or URLs.
 */
const TRACE = process.env.ORGMAP_DEBUG === 'true' || (process.env.ORGMAP_DEBUG !== 'false' && process.env.NODE_ENV !== 'production')
const TRACE_DIR = path.join(DATA_DIR, 'debug')
const traceFile = (sourceId: string) => path.join(TRACE_DIR, `${sourceId.replace(/[^\w-]/g, '')}.json`)

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i
const TEXT_EXT = /\.(txt|md|markdown)$/i
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error(e)
    res.status(500).json({ error: (e as Error).message })
  })

// ---------- system ----------
app.get('/api/status', wrap(async (_req, res) => {
  const ai = await systemInfo()
  const notes: string[] = []
  if (!ai.reachable) notes.push('Local model runtime is not reachable. Start Ollama.')
  if (ai.reachable && !ai.visionModel) notes.push('No local vision model found. Images use OCR + text model fallback.')
  if (!cloudinaryEnabled) notes.push('Cloudinary not configured. Images are stored locally.')
  if (persistError) notes.push(persistError)
  const status: SystemStatus = {
    ...ai,
    ocr: process.env.OCR_ENABLED === 'false' ? 'disabled' : 'tesseract.js (local)',
    cloudinary: cloudinaryEnabled,
    cloudName: cloudinaryEnabled ? cloudName : undefined,
    inbox: { ...inboxState, root: INBOX_ROOT, captureUrls: captureUrls() },
    notes,
    // Hosted demos have no AI of their own: visitors bring a key for one of these.
    aiProviders: Object.entries(AI_PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel, keyUrl: p.keyUrl })),
    codeVersion,
    // Only when nothing but this machine can reach the API (the hosted demo): lets the page replace an outdated server.
    ...(process.env.HOST === '127.0.0.1' ? { pid: process.pid } : {}),
  }
  if (inboxState.lastError) notes.push(`Cloudinary inbox: ${inboxState.lastError}`)
  res.json(status)
}))

// ---------- visitors' own AI keys ----------
/** A key from a request body (ai_provider, ai_key, ai_model), or undefined if none was sent. Throws if it's unusable. */
function keyFrom(body: Record<string, unknown> | undefined): AiKey | undefined {
  const apiKey = String(body?.ai_key ?? '').trim()
  if (!apiKey) return undefined
  if (apiKey.length > 512) throw new Error('That API key is too long')
  const k: AiKey = { provider: String(body?.ai_provider ?? ''), apiKey, model: String(body?.ai_model ?? '').trim().slice(0, 100) || undefined }
  keyRuntime(k) // validates provider, model, key
  return k
}
/** Never echo a key back: providers sometimes quote it in error messages. */
const redact = (msg: string, k?: AiKey) => (k ? msg.split(k.apiKey).join('[your key]') : msg)

/** Check a key (and that it can use the chosen model) before any notes are sent. Answers within ~45 s at most. */
app.post('/api/ai/check', wrap(async (req, res) => {
  let k: AiKey | undefined
  const t0 = Date.now()
  try {
    k = keyFrom(req.body)
    if (!k) return void res.status(400).json({ ok: false, error: 'Add an API key' })
    const model = await checkKey(k)
    console.log(`[ai] key check ${k.provider}/${model}: ok in ${Date.now() - t0} ms`)
    res.json({ ok: true, model })
  } catch (e) {
    const error = redact((e as Error).message, k)
    console.log(`[ai] key check ${k?.provider ?? '?'}: failed in ${Date.now() - t0} ms: ${error}`)
    res.json({ ok: false, error })
  }
}))

/** URLs a phone on the same Wi-Fi can open to photograph notes. */
function captureUrls() {
  // Skip virtual adapters (WSL, Docker, Hyper-V, VPNs): a phone can't reach those.
  const ips = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V|Loopback|Tailscale|ZeroTier/i.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254'))
    .map((i) => i.address)
  return [...ips.map((ip) => `http://${ip}:${port}/capture`), `http://localhost:${port}/capture`]
}

// ---------- Cloudinary inbox / phone capture ----------
app.get('/capture', (_req, res) => {
  res.type('html').send(capturePage({ cloudName: cloudName ?? '', apiKey: process.env.CLOUDINARY_API_KEY ?? '', enabled: cloudinaryEnabled }))
})
app.get('/api/workspaces/:id/inbox', (req, res) => {
  const ws = store.db.workspaces.find((w) => w.id === req.params.id)
  if (!ws) return void res.status(404).json({ error: 'not found' })
  res.json({ folder: inboxFolder(ws), enabled: inboxState.enabled })
})
app.post('/api/inbox/poll', wrap(async (_req, res) => {
  await pollNow()
  res.json({ ok: true, imported: inboxState.imported })
}))
app.post('/api/cloudinary/sign', (req, res) => {
  try {
    res.json({ signature: signInboxUpload(req.body?.params_to_sign ?? {}) })
  } catch (e) {
    res.status(403).json({ error: (e as Error).message })
  }
})

// ---------- workspaces ----------
app.get('/api/workspaces', (_req, res) => { res.json(store.listWorkspaces()) })
app.post('/api/workspaces', (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) return void res.status(400).json({ error: 'name required' })
  const ws = store.createWorkspace(name)
  void ensureInboxFolder(ws)
  res.json(ws)
})
app.delete('/api/workspaces/:id', wrap(async (req, res) => {
  await deleteWorkspace(String(req.params.id))
  res.json({ ok: true })
}))

async function deleteWorkspace(id: string) {
  // Remove the workspace's images from Cloudinary too (uploads and inbox photos).
  const ws = store.db.workspaces.find((w) => w.id === id)
  for (const s of store.db.sources.filter((x) => x.workspaceId === id && x.cloudinary)) await deleteImage(s.cloudinary!.publicId)
  for (const s of store.db.sources.filter((x) => x.workspaceId === id)) fs.rmSync(traceFile(s.id), { force: true })
  // Also remove the project's (now empty) Cloudinary folders, so repeated resets don't litter the Media Library.
  if (ws) await removeProjectFolders(ws)
  store.deleteWorkspace(id)
}

/**
 * BOARD_MAX_AGE_DAYS (the hosted demo): delete boards nobody has touched for that long, with their photos,
 * at startup and daily, so a public demo doesn't collect strangers' notes forever.
 */
async function deleteStaleBoards() {
  const days = Number(process.env.BOARD_MAX_AGE_DAYS)
  if (!days) return
  const cutoff = Date.now() - days * 86_400_000
  for (const ws of [...store.db.workspaces]) {
    const last = Math.max(Date.parse(ws.createdAt), ...store.db.sources.filter((s) => s.workspaceId === ws.id).map((s) => Date.parse(s.createdAt)))
    if (last < cutoff) {
      await deleteWorkspace(ws.id).catch((e) => console.error('[cleanup]', (e as Error).message))
      console.log(`[cleanup] deleted board "${ws.name}" (no activity since ${new Date(last).toISOString().slice(0, 10)})`)
    }
  }
}
app.get('/api/workspaces/:id', (req, res) => {
  const s = store.state(req.params.id)
  if (!s) return void res.status(404).json({ error: 'not found' })
  res.json(s)
})

/** Derived corporate views: KPIs, action items, blockers, decisions, milestones, org chart, ownership, trends. */
app.get('/api/workspaces/:id/views', (req, res) => {
  const s = store.state(req.params.id)
  if (!s) return void res.status(404).json({ error: 'not found' })
  res.json(buildViews(s, typeof req.query.today === 'string' ? req.query.today : undefined))
})
app.get('/api/workspaces/:id/report.md', (req, res) => {
  const s = store.state(req.params.id)
  if (!s) return void res.status(404).json({ error: 'not found' })
  res.type('text/markdown').send(buildReport(s, typeof req.query.today === 'string' ? req.query.today : undefined))
})

// ---------- sources ----------
app.post('/api/workspaces/:id/sources', upload.array('files', 20), wrap(async (req, res) => {
  const workspaceId = String(req.params.id)
  if (!store.state(workspaceId)) return void res.status(404).json({ error: 'workspace not found' })
  let key: AiKey | undefined
  try {
    key = keyFrom(req.body)
  } catch (e) {
    return void res.status(400).json({ error: (e as Error).message })
  }
  if (!key && req.body?.analyze !== 'false' && !(await runtime.reachable())) {
    return void res.status(400).json({ error: 'This demo has no AI of its own: add your AI key first.' })
  }
  const created: Source[] = []
  const meetingDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date ?? '')) ? String(req.body.date) : undefined
  const base = { workspaceId, status: 'PENDING' as const, createdAt: now(), ...(meetingDate ? { meetingDate } : {}) }

  if (req.body?.text) {
    const text = String(req.body.text)
    created.push({ ...base, id: newId(), type: 'TEXT', name: String(req.body.name || text.slice(0, 40).replace(/\s+/g, ' ') + '…'), text })
  }
  for (const f of (req.files as Express.Multer.File[]) ?? []) {
    // multer decodes multipart filenames as latin1; re-decode so "·", accents, CJK etc. survive.
    f.originalname = Buffer.from(f.originalname, 'latin1').toString('utf8')
    if (TEXT_EXT.test(f.originalname)) {
      created.push({ ...base, id: newId(), type: 'TEXT_FILE', name: f.originalname, text: f.buffer.toString('utf8') })
    } else if (IMAGE_EXT.test(f.originalname)) {
      const src: Source = { ...base, id: newId(), type: 'IMAGE', name: f.originalname }
      if (cloudinaryEnabled) {
        try {
          src.cloudinary = await uploadImage(f.buffer, `orgmap/${workspaceId}`, f.originalname)
          src.previewUrl = previewUrl(src.cloudinary.publicId)
          src.thumbUrl = thumbUrl(src.cloudinary.publicId)
          src.analysisUrl = analysisUrl(src.cloudinary.publicId)
        } catch (e) {
          // Bad credentials / offline: keep working with local storage rather than failing the upload.
          console.warn('[cloudinary] upload failed, storing locally:', (e as { message?: string }).message ?? e)
        }
      }
      if (!src.cloudinary) {
        const file = `${src.id}${path.extname(f.originalname).toLowerCase()}`
        fs.writeFileSync(path.join(UPLOAD_DIR, file), f.buffer)
        src.localFile = file
        src.previewUrl = src.thumbUrl = `/uploads/${file}`
      }
      created.push(src)
    } else {
      return void res.status(400).json({ error: `Unsupported file type: ${f.originalname}` })
    }
  }
  store.db.sources.push(...created)
  persist()
  // The key waits in memory for its turn in the queue, is used for these sources only, and is then dropped.
  if (key) for (const s of created) visitorKeys.set(s.id, key)
  if (req.body?.analyze !== 'false') for (const s of created) void runAnalysis(s.id)
  res.json(created)
}))

app.get('/api/sources/:id/trace', (req, res) => {
  const file = traceFile(String(req.params.id))
  if (!fs.existsSync(file)) return void res.status(404).json({ error: TRACE ? 'no trace for this source (analyze it again)' : 'tracing is off (ORGMAP_DEBUG=false)' })
  res.type('json').send(fs.readFileSync(file, 'utf8'))
})

app.post('/api/sources/:id/analyze', (req, res) => {
  const s = store.source(req.params.id)
  if (!s) return void res.status(404).json({ error: 'not found' })
  if (s.status === 'ANALYZING') return void res.json(s)
  void runAnalysis(s.id)
  res.json(s)
})

app.post('/api/workspaces/:id/analyze', (req, res) => {
  const pending = store.db.sources.filter((s) => s.workspaceId === req.params.id && (s.status === 'PENDING' || s.status === 'ERROR'))
  for (const s of pending) void runAnalysis(s.id)
  res.json({ queued: pending.length })
})

app.delete('/api/sources/:id', wrap(async (req, res) => {
  const s = store.source(String(req.params.id))
  if (!s) return void res.status(404).json({ error: 'not found' })
  if (s.cloudinary) await deleteImage(s.cloudinary.publicId)
  if (s.localFile) fs.rmSync(path.join(UPLOAD_DIR, s.localFile), { force: true })
  fs.rmSync(traceFile(s.id), { force: true })
  store.db.sources = store.db.sources.filter((x) => x.id !== s.id)
  retractSource(s)
  persist()
  res.json({ ok: true })
}))

/** Edit a text source (e.g. corrected meeting minutes): retract its old contribution, then re-analyze. */
app.patch('/api/sources/:id', (req, res) => {
  const s = store.source(req.params.id)
  if (!s) return void res.status(404).json({ error: 'not found' })
  if (typeof req.body?.name === 'string' && req.body.name.trim()) s.name = req.body.name.trim()
  const textChanged = typeof req.body?.text === 'string' && s.type !== 'IMAGE' && req.body.text !== s.text
  if (textChanged) s.text = req.body.text
  const dateChanged = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date ?? '')) && req.body.date !== s.meetingDate
  if (dateChanged) s.meetingDate = req.body.date
  persist()
  if (textChanged || dateChanged) void runAnalysis(s.id)
  res.json(s)
})

/**
 * Remove a source's provenance from the graph. Nodes/edges supported only by this source are
 * dropped; anything other sources (or the user) also asserted stays.
 */
function retractSource(s: Source) {
  retractHistory(s.id, s.workspaceId) // undo status changes / date slips this source asserted
  for (const n of store.db.nodes) n.sourceIds = n.sourceIds.filter((id) => id !== s.id)
  for (const e of store.db.edges) e.sourceIds = e.sourceIds.filter((id) => id !== s.id)
  const orphan = new Set(store.db.nodes.filter((n) => n.workspaceId === s.workspaceId && n.sourceIds.length === 0 && !n.id.startsWith('manual')).map((n) => n.id))
  store.db.nodes = store.db.nodes.filter((n) => !orphan.has(n.id))
  store.db.edges = store.db.edges.filter((e) => !orphan.has(e.source) && !orphan.has(e.target) && (e.sourceIds.length > 0 || e.id.startsWith('manual')))
}

/** Serialized analysis queue: a local GPU handles one model call at a time well. */
let queue = Promise.resolve()
/** Visitors' keys for sources still waiting to be read. Memory only: never saved, never logged. */
const visitorKeys = new Map<string, AiKey>()
function runAnalysis(sourceId: string) {
  const s = store.source(sourceId)
  if (!s) return
  s.status = 'ANALYZING'
  s.error = undefined
  persist()
  const key = visitorKeys.get(sourceId)
  queue = queue
    .then(() => (key ? withAi(key, () => analyzeSource(sourceId, key)) : analyzeSource(sourceId)))
    .catch(() => undefined)
    .finally(() => { visitorKeys.delete(sourceId) })
  return queue
}

async function analyzeSource(sourceId: string, key?: AiKey) {
  const s = store.source(sourceId)
  if (!s) return
  const t0 = Date.now()
  // Re-analysis replaces this source's previous contribution instead of stacking on top of it.
  if (s.analyzedAt) retractSource(s)
  const asOf = s.meetingDate ?? s.cloudinary?.createdAt?.slice(0, 10) ?? s.createdAt.slice(0, 10)
  const trace: Trace | undefined = TRACE ? [{ stage: 'input', data: { name: s.name, type: s.type, meetingDate: asOf, text: s.text } }] : undefined
  const ctx = {
    meetingDate: asOf,
    knownEntities: store.db.nodes.filter((n) => n.workspaceId === s.workspaceId)
      .map((n) => ({ label: n.label, type: n.type, status: n.status })),
    trace,
  }
  try {
    const result = s.type === 'IMAGE' ? await analyzeImage(await loadAnalysisImage(s), s.name, ctx) : await analyzeText(s.text ?? '', undefined, ctx)
    result.extraction.ambiguities = result.extraction.ambiguities.map((a) => redact(a, key))
    const report = await mergeExtraction(s.workspaceId, s.id, result.extraction, asOf)
    Object.assign(s, {
      status: 'DONE', summary: result.extraction.summary, ambiguities: result.extraction.ambiguities,
      ocrText: result.ocrText, analyzedWith: result.model, analyzedAt: now(),
    })
    if (trace) {
      trace.push({ stage: 'merge', data: report })
      // The to-dos this source touched, as the demo receives them.
      const touched = new Set(store.db.nodes.filter((n) => n.sourceIds.includes(s.id)).map((n) => n.id))
      trace.push({ stage: 'views.actionItems', data: buildViews(store.state(s.workspaceId)!).actionItems.filter((a) => touched.has(a.id)) })
    }
    console.log(`[analyze] ${s.name}: ${JSON.stringify(report)} via ${result.model} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  } catch (e) {
    s.status = 'ERROR'
    s.error = redact((e as Error).message, key)
    trace?.push({ stage: 'error', data: s.error })
    console.error(`[analyze] ${s.name} failed: ${s.error}`)
  }
  if (trace) {
    try {
      fs.mkdirSync(TRACE_DIR, { recursive: true })
      fs.writeFileSync(traceFile(s.id), JSON.stringify(trace, null, 2))
    } catch (e) {
      console.warn('[trace] could not write:', (e as Error).message)
    }
  }
  persist()
}

async function loadAnalysisImage(s: Source): Promise<Buffer> {
  if (s.cloudinary) {
    const res = await fetch(analysisUrl(s.cloudinary.publicId))
    if (!res.ok) throw new Error(`Cloudinary analysis derivative failed: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  return fs.readFileSync(path.join(UPLOAD_DIR, s.localFile!))
}

// ---------- graph editing ----------
app.post('/api/workspaces/:id/nodes', (req, res) => {
  const { label, type = 'OTHER', description, position } = req.body ?? {}
  if (!label) return void res.status(400).json({ error: 'label required' })
  const ts = now()
  const node = {
    id: 'manual-' + newId(), workspaceId: req.params.id, label: String(label),
    type: NODE_TYPES.includes(type) ? type : 'OTHER', description, aliases: [], confidence: 1,
    sourceIds: [], position, createdAt: ts, updatedAt: ts,
  }
  store.db.nodes.push(node)
  persist()
  res.json(node)
})

app.patch('/api/nodes/:id', (req, res) => {
  const n = store.node(req.params.id)
  if (!n) return void res.status(404).json({ error: 'not found' })
  const { label, type, description, position, aliases } = req.body ?? {}
  if (typeof label === 'string' && label.trim()) n.label = label.trim()
  if (NODE_TYPES.includes(type)) n.type = type
  if (typeof description === 'string') n.description = description
  if (Array.isArray(aliases)) n.aliases = aliases.map(String)
  // Manual status/date change (e.g. ticking off an action item in the dashboard) is recorded like a meeting statement.
  const status = NODE_STATUSES.includes(req.body?.status) ? req.body.status : undefined
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date ?? '')) ? String(req.body.date) : undefined
  if (status || date) {
    n.history = [...(n.history ?? []), { sourceId: 'manual', asOf: now().slice(0, 10), ...(status ? { status } : {}), ...(date ? { date } : {}) }]
    deriveState(n)
  }
  if (position && typeof position.x === 'number') n.position = { x: position.x, y: position.y }
  if (req.body?.dismissDuplicate) n.possibleDuplicateOf = undefined
  if (label || type || description) n.confidence = 1 // user-validated
  n.updatedAt = now()
  persist()
  res.json(n)
})

app.post('/api/positions', (req, res) => {
  for (const { id, x, y } of req.body?.positions ?? []) {
    const n = store.node(id)
    if (n) n.position = { x, y }
  }
  persist()
  res.json({ ok: true })
})

app.delete('/api/nodes/:id', (req, res) => {
  store.db.nodes = store.db.nodes.filter((n) => n.id !== req.params.id)
  store.db.edges = store.db.edges.filter((e) => e.source !== req.params.id && e.target !== req.params.id)
  persist()
  res.json({ ok: true })
})

app.post('/api/nodes/:id/merge', wrap(async (req, res) => {
  mergeNodes(String(req.body.intoId), String(req.params.id))
  res.json({ ok: true })
}))

app.post('/api/workspaces/:id/edges', (req, res) => {
  const { source, target, relationship = 'RELATES_TO', label } = req.body ?? {}
  if (!store.node(source) || !store.node(target)) return void res.status(400).json({ error: 'bad endpoints' })
  const edge: GraphEdge = {
    id: 'manual-' + newId(), workspaceId: req.params.id, source, target,
    relationship: RELATIONSHIP_TYPES.includes(relationship) ? relationship : 'RELATES_TO',
    label, confidence: 1, sourceIds: [], createdAt: now(),
  }
  store.db.edges.push(edge)
  persist()
  res.json(edge)
})

app.patch('/api/edges/:id', (req, res) => {
  const e = store.edge(req.params.id)
  if (!e) return void res.status(404).json({ error: 'not found' })
  if (RELATIONSHIP_TYPES.includes(req.body?.relationship)) e.relationship = req.body.relationship
  if (typeof req.body?.label === 'string') e.label = req.body.label
  e.confidence = 1
  persist()
  res.json(e)
})

app.delete('/api/edges/:id', (req, res) => {
  store.db.edges = store.db.edges.filter((e) => e.id !== req.params.id)
  persist()
  res.json({ ok: true })
})

// Sources stuck in ANALYZING from a previous crash go back to PENDING.
for (const s of store.db.sources) if (s.status === 'ANALYZING') s.status = 'PENDING'

// Production: serve the built client.
const dist = path.resolve('dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^\/(?!api|uploads).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

// HOST=127.0.0.1 keeps the API off the network (the cloud setup does this: only the demo page is published).
// Unset = all interfaces, so phones on the same Wi-Fi can reach the capture page.
const host = process.env.HOST || undefined
// Hosted demo: bring the boards back from the Cloudinary backup before accepting requests.
await restoreBackup()
startBackup()
app.listen(port, host as string, () => {
  console.log(`OrgMap AI server on http://${host ?? 'localhost'}:${port} (cloudinary: ${cloudinaryEnabled ? 'on' : 'off, local storage'})`)
  startInbox((id) => void runAnalysis(id))
  if (cloudinaryEnabled) console.log(`[capture] phone page: ${captureUrls()[0]}`)
  void deleteStaleBoards()
  setInterval(() => void deleteStaleBoards(), 86_400_000)
})
