import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GraphEdge, GraphNode, Source, Workspace, WorkspaceState } from '../src/shared/schema.ts'

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data')
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
const DB_FILE = path.join(DATA_DIR, 'db.json')

interface Db {
  workspaces: Workspace[]
  sources: Source[]
  nodes: GraphNode[]
  edges: GraphEdge[]
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true })

let db: Db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : { workspaces: [], sources: [], nodes: [], edges: [] }

let writeTimer: NodeJS.Timeout | undefined
/** Set while the last save failed (e.g. disk full); shown in /api/status. The data stays in memory. */
export let persistError: string | undefined

/** Debounced atomic write: temp file + rename so a crash never leaves a half-written db. */
export function persist() {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
      fs.renameSync(tmp, DB_FILE)
      persistError = undefined
    } catch (e) {
      // A full disk must not take the server down: keep serving from memory and retry shortly.
      const code = (e as NodeJS.ErrnoException).code
      persistError = code === 'ENOSPC' ? 'Disk is full: changes are not being saved. Free up disk space.' : `Could not save data: ${(e as Error).message}`
      console.error('[store]', persistError)
      writeTimer = setTimeout(persist, 15_000)
    }
  }, 100)
}

export const now = () => new Date().toISOString()
export const newId = () => randomUUID()

export const store = {
  get db() { return db },
  set db(v: Db) { db = v },

  listWorkspaces: () => db.workspaces,
  createWorkspace(name: string): Workspace {
    const ws = { id: newId(), name, createdAt: now() }
    db.workspaces.push(ws)
    persist()
    return ws
  },
  deleteWorkspace(id: string) {
    db.workspaces = db.workspaces.filter((w) => w.id !== id)
    db.sources = db.sources.filter((s) => s.workspaceId !== id)
    db.nodes = db.nodes.filter((n) => n.workspaceId !== id)
    db.edges = db.edges.filter((e) => e.workspaceId !== id)
    persist()
  },
  state(workspaceId: string): WorkspaceState | undefined {
    const workspace = db.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    return {
      workspace,
      sources: db.sources.filter((s) => s.workspaceId === workspaceId),
      nodes: db.nodes.filter((n) => n.workspaceId === workspaceId),
      edges: db.edges.filter((e) => e.workspaceId === workspaceId),
    }
  },
  source: (id: string) => db.sources.find((s) => s.id === id),
  node: (id: string) => db.nodes.find((n) => n.id === id),
  edge: (id: string) => db.edges.find((e) => e.id === id),
}
