// Shared between the Express server and the React client.
import { z } from 'zod'

export const NODE_TYPES = [
  'PERSON', 'TEAM', 'PROJECT', 'SYSTEM', 'COMPONENT', 'PROCESS',
  'DECISION', 'MILESTONE', 'BLOCKER', 'TASK', 'DOCUMENT', 'OTHER',
] as const
export type NodeType = (typeof NODE_TYPES)[number]

/** Lifecycle for TASK (action items), BLOCKER and MILESTONE nodes. */
export const NODE_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'RESOLVED', 'CANCELLED'] as const
export type NodeStatus = (typeof NODE_STATUSES)[number]

const isoDate = z.preprocess(
  (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) ? v.trim().slice(0, 10) : undefined),
  z.string().optional(),
)
const nodeStatus = z.preprocess((v) => {
  if (typeof v !== 'string') return undefined
  const s = v.trim().toUpperCase().replace(/[\s-]+/g, '_')
  const alias: Record<string, NodeStatus> = { COMPLETED: 'DONE', COMPLETE: 'DONE', FINISHED: 'DONE', CLOSED: 'DONE', FIXED: 'RESOLVED', TODO: 'OPEN', NEW: 'OPEN', DOING: 'IN_PROGRESS', WIP: 'IN_PROGRESS', STARTED: 'IN_PROGRESS' }
  return alias[s] ?? s
}, z.enum(NODE_STATUSES).optional().catch(undefined))

export const RELATIONSHIP_TYPES = [
  'OWNS', 'PART_OF', 'REPORTS_TO', 'DEPENDS_ON', 'BLOCKS', 'FEEDS_INTO',
  'CALLS', 'PRODUCES', 'USES', 'RESPONSIBLE_FOR', 'PRECEDES', 'RELATES_TO',
] as const
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

const confidence = z.coerce.number().min(0).max(1).catch(0.5)

const nodeType = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.enum(NODE_TYPES).catch('OTHER'),
)

/** Lenient parser for local-model extraction output. Unknown enums are coerced, never trusted. */
export const ExtractionSchema = z.object({
  summary: z.string().catch(''),
  nodes: z.array(z.object({
    temporaryId: z.coerce.string().min(1),
    label: z.string().trim().min(1).max(120),
    type: nodeType,
    description: z.string().max(1000).optional().catch(undefined),
    status: nodeStatus,
    date: isoDate,
    confidence,
  })).max(200),
  edges: z.array(z.object({
    sourceTemporaryId: z.coerce.string(),
    targetTemporaryId: z.coerce.string(),
    relationship: z.string().trim().catch('RELATES_TO'),
    label: z.string().max(120).optional().catch(undefined),
    confidence,
  })).max(400).catch([]),
  ambiguities: z.array(z.coerce.string()).catch([]),
})
export type Extraction = z.infer<typeof ExtractionSchema>

/** JSON schema handed to Ollama's `format` for constrained decoding. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          temporaryId: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string', enum: [...NODE_TYPES] },
          description: { type: 'string' },
          status: { type: 'string', enum: [...NODE_STATUSES] },
          date: { type: 'string', description: 'YYYY-MM-DD: due date (TASK), target date (MILESTONE)' },
          confidence: { type: 'number' },
        },
        required: ['temporaryId', 'label', 'type', 'confidence'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sourceTemporaryId: { type: 'string' },
          targetTemporaryId: { type: 'string' },
          relationship: { type: 'string' },
          label: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['sourceTemporaryId', 'targetTemporaryId', 'relationship', 'confidence'],
      },
    },
    ambiguities: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'nodes', 'edges', 'ambiguities'],
} as const

export const ReconcileSchema = z.object({
  decisions: z.array(z.object({
    temporaryId: z.coerce.string(),
    decision: z.enum(['MATCH_EXISTING', 'CREATE_NEW', 'UNCERTAIN']).catch('UNCERTAIN'),
    existingNodeId: z.string().nullable().optional(),
    confidence,
  })).catch([]),
})
export type ReconcileResult = z.infer<typeof ReconcileSchema>

export const RECONCILE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          temporaryId: { type: 'string' },
          decision: { type: 'string', enum: ['MATCH_EXISTING', 'CREATE_NEW', 'UNCERTAIN'] },
          existingNodeId: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
        required: ['temporaryId', 'decision', 'confidence'],
      },
    },
  },
  required: ['decisions'],
} as const

// ---------- persisted entities ----------

export type SourceType = 'IMAGE' | 'TEXT' | 'TEXT_FILE'
export type SourceStatus = 'PENDING' | 'ANALYZING' | 'DONE' | 'ERROR'

export interface CloudinaryAsset {
  publicId: string
  assetId?: string
  secureUrl: string
  width: number
  height: number
  format: string
  createdAt: string
}

export interface Source {
  id: string
  workspaceId: string
  type: SourceType
  name: string
  status: SourceStatus
  /** 'inbox' = photo picked up automatically from the Cloudinary inbox folder. */
  origin?: 'upload' | 'inbox'
  /** Date of the meeting this source documents (YYYY-MM-DD). Orders updates: later meetings win. */
  meetingDate?: string
  text?: string
  cloudinary?: CloudinaryAsset
  /** Local fallback path (served from /uploads) when Cloudinary is not configured. */
  localFile?: string
  previewUrl?: string
  thumbUrl?: string
  summary?: string
  ambiguities?: string[]
  ocrText?: string
  analyzedWith?: string
  error?: string
  createdAt: string
  analyzedAt?: string
}

export interface GraphNode {
  id: string
  workspaceId: string
  label: string
  type: NodeType
  description?: string
  aliases: string[]
  confidence: number
  sourceIds: string[]
  position?: { x: number; y: number }
  /** Set when reconciliation could not decide whether this duplicates an existing node. */
  possibleDuplicateOf?: { nodeId: string; score: number }
  /** Current lifecycle state / date, derived from `history` (latest meeting wins). */
  status?: NodeStatus
  date?: string
  /** Every statement about this node's status/date, by which source and as of which meeting date. */
  history?: NodeHistoryEntry[]
  createdAt: string
  updatedAt: string
}

export interface NodeHistoryEntry {
  sourceId: string // or 'manual'
  asOf: string // meeting date (YYYY-MM-DD) the statement was made
  status?: NodeStatus
  date?: string
}

export interface GraphEdge {
  id: string
  workspaceId: string
  source: string
  target: string
  relationship: RelationshipType
  label?: string
  confidence: number
  sourceIds: string[]
  createdAt: string
}

export interface Workspace {
  id: string
  name: string
  createdAt: string
}

export interface WorkspaceState {
  workspace: Workspace
  sources: Source[]
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface SystemStatus {
  provider: string
  reachable: boolean
  textModel?: string
  visionModel?: string
  ocr: string
  cloudinary: boolean
  cloudName?: string
  inbox?: { enabled: boolean; root: string; lastPollAt?: string; lastError?: string; imported: number; captureUrls: string[] }
  notes: string[]
}
