/**
 * Incremental merge of one source's extraction into the persistent graph.
 * Existing nodes/edges are never removed or overwritten; new evidence only adds
 * nodes, edges, aliases and provenance.
 */
import { RELATIONSHIP_TYPES, type Extraction, type GraphEdge, type GraphNode, type RelationshipType } from '../../src/shared/schema.ts'
import { reconcileGraph, type ReconcileCandidate } from '../lib/ai/provider.ts'
import { newId, now, persist, store } from '../store.ts'
import { normalize, similarity } from './text.ts'

export { normalize, similarity }

const MATCH_AT = 0.9
const CANDIDATE_AT = 0.5

/** Common verbs local models emit, mapped onto the canonical relationship types. */
const SYNONYMS: Record<string, RelationshipType> = {
  LEADS: 'RESPONSIBLE_FOR', MANAGES: 'RESPONSIBLE_FOR', RUNS: 'RESPONSIBLE_FOR', MAINTAINS: 'RESPONSIBLE_FOR',
  MEMBER_OF: 'PART_OF', BELONGS_TO: 'PART_OF', CONTAINS: 'RELATES_TO', IN: 'PART_OF',
  REQUIRES: 'DEPENDS_ON', NEEDS: 'DEPENDS_ON', RELIES_ON: 'DEPENDS_ON', CONNECTS_TO: 'CALLS', SENDS_TO: 'FEEDS_INTO', FLOWS_TO: 'FEEDS_INTO', THEN: 'PRECEDES', FOLLOWED_BY: 'PRECEDES',
  READS: 'USES', WRITES: 'USES', READS_FROM: 'USES', WRITES_TO: 'USES', STORES_IN: 'USES', QUERIES: 'USES',
}

export function toRelationship(raw: string): { relationship: RelationshipType; label?: string } {
  const up = raw.trim().toUpperCase().replace(/[\s-]+/g, '_')
  if ((RELATIONSHIP_TYPES as readonly string[]).includes(up)) return { relationship: up as RelationshipType }
  if (SYNONYMS[up]) return { relationship: SYNONYMS[up], label: raw.trim().toLowerCase().replace(/_/g, ' ') }
  return { relationship: 'RELATES_TO', label: raw.trim().slice(0, 60) || undefined }
}

export interface MergeReport {
  created: number
  matched: number
  uncertain: number
  edgesAdded: number
  edgesReinforced: number
}

const LIFECYCLE = new Set(['TASK', 'BLOCKER', 'MILESTONE'])

/** status/date = the latest statement by meeting date (ties: the later-recorded statement wins). */
export function deriveState(node: GraphNode) {
  const h = (node.history ?? []).map((e, i) => ({ e, i })).sort((a, b) => a.e.asOf.localeCompare(b.e.asOf) || a.i - b.i)
  node.status = h.filter((x) => x.e.status).at(-1)?.e.status
  node.date = h.filter((x) => x.e.date).at(-1)?.e.date
}

/** Drop everything a source said about statuses/dates (used when its minutes are edited or deleted). */
export function retractHistory(sourceId: string, workspaceId: string) {
  for (const n of store.db.nodes) {
    if (n.workspaceId !== workspaceId || !n.history?.some((h) => h.sourceId === sourceId)) continue
    n.history = n.history.filter((h) => h.sourceId !== sourceId)
    deriveState(n)
  }
}

function record(node: GraphNode, sourceId: string, asOf: string, status: GraphNode['status'], date: string | undefined) {
  if (!status && !date) return
  // Two statements from the same source about one node are combined, not overwritten.
  const prev = (node.history ?? []).find((h) => h.sourceId === sourceId)
  node.history = (node.history ?? []).filter((h) => h.sourceId !== sourceId)
  node.history.push({ sourceId, asOf, ...prev, ...(status ? { status } : {}), ...(date ? { date } : {}) })
  deriveState(node)
}

/** Structural things can be described at different granularity; lifecycle items and people cannot. */
const STRUCTURAL = new Set(['SYSTEM', 'COMPONENT', 'PROJECT', 'PROCESS', 'DOCUMENT', 'OTHER'])
export function compatibleTypes(a: string, b: string) {
  return a === b || (STRUCTURAL.has(a) && STRUCTURAL.has(b))
}

const contentTokens = (s: string) => normalize(s).split(' ').filter(Boolean)
const e_verb = (e: GraphNode) => contentTokens(e.label)[0]

/**
 * Deterministic same-entity rules that fuzzy similarity misses:
 * - "Sarah" (sprint-board note) -> the only known person whose first name is Sarah
 * - "Schedule PCI audit" -> "Schedule the PCI audit with the external assessor" (all words contained)
 */
function ruleMatch(label: string, type: string, pool: GraphNode[]): GraphNode | undefined {
  const t = contentTokens(label)
  if (type === 'PERSON' && t.length === 1) {
    const hits = pool.filter((p) => p.type === 'PERSON' && contentTokens(p.label)[0] === t[0])
    if (hits.length === 1) return hits[0]
  }
  if (t.length >= 2) {
    const hits = pool.filter((p) => p.type === type).filter((p) => {
      const pt = contentTokens(p.label)
      const [short, long] = t.length <= pt.length ? [t, pt] : [pt, t]
      return short.length >= 2 && short.every((x) => long.includes(x))
    })
    if (hits.length === 1) return hits[0]
  }
}

export async function mergeExtraction(workspaceId: string, sourceId: string, x: Extraction, asOf = now().slice(0, 10)): Promise<MergeReport> {
  const existing = store.db.nodes.filter((n) => n.workspaceId === workspaceId)
  const report: MergeReport = { created: 0, matched: 0, uncertain: 0, edgesAdded: 0, edgesReinforced: 0 }
  const resolved = new Map<string, string>() // temporaryId -> graph node id
  const decisions = new Map<string, { kind: 'match' | 'new' | 'uncertain'; nodeId?: string; score?: number }>()
  const toAsk: ReconcileCandidate[] = []

  // 1. Deterministic pass: exact / alias / high-similarity match.
  for (const n of x.nodes) {
    const pool = existing.filter((e) => compatibleTypes(e.type, n.type))
    const verb = contentTokens(n.label)[0]
    const scored = pool
      .map((e) => ({ e, score: Math.max(similarity(n.label, e.label), ...e.aliases.map((a) => similarity(n.label, a))) }))
      // Action items that share an object but not the verb are different tasks
      // ("Order the network equipment" vs "Escalate the network equipment delivery"): no fuzzy match.
      .filter((s) => n.type !== 'TASK' || s.score >= MATCH_AT || [e_verb(s.e)].includes(verb))
      .sort((a, b) => b.score - a.score)
    const best = scored[0]
    const rule = !best || best.score < MATCH_AT ? ruleMatch(n.label, n.type, pool) : undefined
    if (rule) decisions.set(n.temporaryId, { kind: 'match', nodeId: rule.id, score: 0.9 })
    else if (best && best.score >= MATCH_AT) decisions.set(n.temporaryId, { kind: 'match', nodeId: best.e.id, score: best.score })
    else if (best && best.score >= CANDIDATE_AT) {
      decisions.set(n.temporaryId, { kind: 'uncertain', nodeId: best.e.id, score: best.score })
      toAsk.push({
        temporaryId: n.temporaryId, label: n.label, type: n.type, description: n.description,
        candidates: scored.filter((s) => s.score >= CANDIDATE_AT).slice(0, 4)
          .map((s) => ({ id: s.e.id, label: s.e.label, type: s.e.type, aliases: s.e.aliases })),
      })
    } else decisions.set(n.temporaryId, { kind: 'new' })
  }

  // 2. Local model adjudicates the fuzzy band. On failure everything stays UNCERTAIN (flagged for the user).
  if (toAsk.length) {
    try {
      const { decisions: ai } = await reconcileGraph(toAsk)
      for (const d of ai) {
        const cur = decisions.get(d.temporaryId)
        if (!cur || cur.kind !== 'uncertain') continue
        const ask = toAsk.find((t) => t.temporaryId === d.temporaryId)!
        if (d.decision === 'MATCH_EXISTING' && d.confidence >= 0.75 && ask.candidates.some((c) => c.id === d.existingNodeId)) {
          decisions.set(d.temporaryId, { kind: 'match', nodeId: d.existingNodeId!, score: d.confidence })
        } else if (d.decision === 'CREATE_NEW' && d.confidence >= 0.75) {
          decisions.set(d.temporaryId, { kind: 'new' })
        }
      }
    } catch (e) {
      console.warn('[reconcile] model adjudication failed, leaving matches for user review:', (e as Error).message)
    }
  }

  // 3. Apply.
  const ts = now()
  for (const n of x.nodes) {
    const d = decisions.get(n.temporaryId)!
    if (d.kind === 'match') {
      const node = store.node(d.nodeId!)!
      if (!node.sourceIds.includes(sourceId)) node.sourceIds.push(sourceId)
      if (normalize(node.label) !== normalize(n.label) || node.label !== n.label) {
        if (n.label !== node.label && !node.aliases.includes(n.label)) node.aliases.push(n.label)
      }
      if (!node.description && n.description) node.description = n.description
      node.confidence = Math.max(node.confidence, n.confidence)
      // A later meeting can move a task to DONE, resolve a blocker, or slip a milestone.
      if (LIFECYCLE.has(node.type) || n.status || n.date) record(node, sourceId, asOf, n.status, n.date)
      node.updatedAt = ts
      resolved.set(n.temporaryId, node.id)
      report.matched++
    } else {
      // Two nodes in the same extraction can share a label: collapse them.
      const dupInBatch = [...resolved.entries()].find(([, id]) => normalize(store.node(id)!.label) === normalize(n.label))
      if (dupInBatch) { resolved.set(n.temporaryId, dupInBatch[1]); continue }
      const node: GraphNode = {
        id: newId(), workspaceId, label: n.label, type: n.type, description: n.description, aliases: [],
        confidence: n.confidence, sourceIds: [sourceId], createdAt: ts, updatedAt: ts,
        ...(d.kind === 'uncertain' ? { possibleDuplicateOf: { nodeId: d.nodeId!, score: d.score ?? 0.5 } } : {}),
      }
      store.db.nodes.push(node)
      // New action items / blockers / milestones start OPEN unless the source says otherwise.
      record(node, sourceId, asOf, n.status ?? (LIFECYCLE.has(n.type) ? 'OPEN' : undefined), n.date)
      resolved.set(n.temporaryId, node.id)
      if (d.kind === 'uncertain') report.uncertain++
      else report.created++
    }
  }

  for (const e of x.edges) {
    const source = resolved.get(e.sourceTemporaryId), target = resolved.get(e.targetTemporaryId)
    if (!source || !target || source === target) continue
    const { relationship, label } = toRelationship(e.relationship)
    // Edge labels are short qualifiers ("latency"); sentences copied from the source are dropped.
    const candidate = e.label?.trim() || label
    const finalLabel = candidate && candidate.length <= 40 ? candidate : undefined
    const dup = store.db.edges.find((g) => g.workspaceId === workspaceId && g.source === source && g.target === target && g.relationship === relationship)
    if (dup) {
      if (!dup.sourceIds.includes(sourceId)) dup.sourceIds.push(sourceId)
      dup.confidence = Math.max(dup.confidence, e.confidence)
      report.edgesReinforced++
      continue
    }
    const edge: GraphEdge = { id: newId(), workspaceId, source, target, relationship, label: finalLabel, confidence: e.confidence, sourceIds: [sourceId], createdAt: ts }
    store.db.edges.push(edge)
    report.edgesAdded++
  }
  persist()
  return report
}

/** Merge `fromId` into `intoId`: rewire edges, keep label as alias, union provenance. */
export function mergeNodes(intoId: string, fromId: string) {
  const into = store.node(intoId), from = store.node(fromId)
  if (!into || !from || into === from) throw new Error('Invalid merge')
  for (const a of [from.label, ...from.aliases]) if (a !== into.label && !into.aliases.includes(a)) into.aliases.push(a)
  into.sourceIds = [...new Set([...into.sourceIds, ...from.sourceIds])]
  if (!into.description) into.description = from.description
  if (from.history?.length) { into.history = [...(into.history ?? []), ...from.history]; deriveState(into) }
  for (const e of store.db.edges) {
    if (e.source === fromId) e.source = intoId
    if (e.target === fromId) e.target = intoId
  }
  // Drop self-loops and now-duplicate edges created by the rewire.
  const seen = new Set<string>()
  store.db.edges = store.db.edges.filter((e) => {
    if (e.source === e.target) return false
    const k = `${e.source}|${e.target}|${e.relationship}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  store.db.nodes = store.db.nodes.filter((n) => n.id !== fromId)
  for (const n of store.db.nodes) if (n.possibleDuplicateOf?.nodeId === fromId) n.possibleDuplicateOf.nodeId = intoId
  into.updatedAt = now()
  persist()
}
