/**
 * Deterministic meeting-minutes parser.
 *
 * Corporate minutes are semi-structured: "Action items" / "Decisions" / "Risks" / "Milestones"
 * sections, "Owner: task (due YYYY-MM-DD)" lines, "X reports to Y" sentences, and status updates
 * ("... is done", "resolved", "moves from A to B"). Parsing that structure is exact and instant;
 * a 7B local model gets it wrong surprisingly often (see tests/scenario.ts). The LLM still extracts
 * relationships from free-form prose, and combineWithModel() lets the parser win where both overlap.
 */
import type { Extraction, NodeStatus, NodeType } from '../../src/shared/schema.ts'
import { normalize, similarity } from '../graph/text.ts'

type XNode = Extraction['nodes'][number]
type XEdge = Extraction['edges'][number]

export interface KnownEntity { label: string; type: string; status?: string }
export interface ParsedMinutes {
  nodes: XNode[]
  edges: XEdge[]
  /** Node types whose section was present, so model output for that type is replaced, not merged. */
  covers: Set<NodeType>
  /** True when reporting lines were stated explicitly ("X reports to Y"). */
  hasReporting: boolean
}

const DATE = /\d{4}-\d{2}-\d{2}/
const NAME = "[A-Z][a-zA-Z'’-]+(?: [A-Z][a-zA-Z'’-]+)?"
const STOP = new Set(['the', 'a', 'an', 'with', 'for', 'to', 'of', 'and', 'on', 'in', 'by', 'is', 'are', 'be', 'it', 'its', 'this', 'that', 'from', 'new', 'our', 'their', 'his', 'her', 'has', 'have', 'been', 'was', 'will', 'now', 'all'])
const STATUS_WORDS = /\b(done|complete[d]?|finished|delivered|confirmed|approved|passed|closed|shipped|resolved|unblocked|cleared|in progress|ongoing|underway|started)\b/i
const NEGATION = /\b(not|n't|no longer|yet to|pending|still open|still blocked)\b/i

const SECTION: [RegExp, string][] = [
  [/action|next step|to-?do|follow[- ]?up|tasks?\b|owners?\b/i, 'actions'],
  [/decision/i, 'decisions'],
  [/milestone|timeline|key dates|schedule|deadlines?/i, 'milestones'],
  [/risk|blocker|issue|impediment/i, 'risks'],
  [/update|status|progress|review of/i, 'updates'],
]

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .filter((t) => t && !STOP.has(t)).map((t) => t.slice(0, 5))

/** Share of an entity's content words that appear in a line (prefix-stemmed). */
function mentionScore(line: string, label: string) {
  const lt = new Set(tokens(line)), et = tokens(label)
  if (!et.length) return 0
  const hit = et.filter((t) => lt.has(t)).length
  return hit < Math.min(2, et.length) ? 0 : hit / et.length
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s\-–:*]+|[\s.;,:]+$/g, '').trim()

function statusFrom(text: string, type: NodeType): NodeStatus | undefined {
  const m = text.match(STATUS_WORDS)
  if (!m) return undefined
  const word = m[1].toLowerCase()
  if (/in progress|ongoing|underway|started/.test(word)) return type === 'TASK' ? 'IN_PROGRESS' : undefined
  // "has not been done", "not renewed yet": a negated completion is not a status change.
  const before = text.slice(0, m.index).split(/[.;]/).at(-1) ?? ''
  if (NEGATION.test(before) || /\bnot\b/.test(text.slice(m.index! - 12, m.index))) return undefined
  if (type === 'BLOCKER') return 'RESOLVED'
  return 'DONE'
}

export function parseMinutes(text: string, ctx: { meetingDate?: string; knownEntities?: KnownEntity[] } = {}): ParsedMinutes {
  const nodes: XNode[] = []
  const edges: XEdge[] = []
  const covers = new Set<NodeType>()
  let hasReporting = false
  let n = 0

  const findNode = (label: string, type?: NodeType) =>
    nodes.find((x) => (!type || x.type === type) && normalize(x.label) === normalize(label))
  const addNode = (label: string, type: NodeType, extra: Partial<XNode> = {}) => {
    const existing = findNode(label, type)
    if (existing) { Object.assign(existing, Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined))); return existing }
    const node: XNode = { temporaryId: `p${++n}`, label: clean(label), type, confidence: 0.95, ...extra }
    nodes.push(node)
    return node
  }
  const addEdge = (a: XNode, b: XNode, relationship: string) => {
    if (a === b || edges.some((e) => e.sourceTemporaryId === a.temporaryId && e.targetTemporaryId === b.temporaryId && e.relationship === relationship)) return
    edges.push({ sourceTemporaryId: a.temporaryId, targetTemporaryId: b.temporaryId, relationship, confidence: 0.95 })
  }
  /** Known-or-parsed entity of a lifecycle type mentioned in this line. */
  const mentioned = (line: string, types: string[]) => {
    const pool = [
      ...(ctx.knownEntities ?? []).filter((e) => types.includes(e.type)).map((e) => ({ label: e.label, type: e.type as NodeType })),
      ...nodes.filter((x) => types.includes(x.type)).map((x) => ({ label: x.label, type: x.type })),
    ]
    return pool.map((e) => ({ e, s: mentionScore(line, e.label) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s)[0]?.e
  }
  /** Targets in a "blocks the X and the Y" phrase, resolved against known/parsed entities. */
  const blockTargets = (line: string) => {
    const m = line.match(/\bblock(?:s|ing)?\s+(.+?)(?:[.;]|$)/i)
    if (!m) return []
    const pool = [...(ctx.knownEntities ?? []).map((e) => e.label), ...nodes.map((x) => x.label)]
    return m[1].split(/,|\band\b/).map((p) => clean(p.replace(/^the\s+/i, '').replace(/\s+go-?live$/i, '')))
      .filter(Boolean)
      .map((p) => pool.map((l) => ({ l, s: Math.max(similarity(p, l), mentionScore(p, l)) })).sort((a, b) => b.s - a.s).find((x) => x.s >= 0.6)?.l ?? p)
  }
  const person = (name: string, role?: string) => addNode(name, 'PERSON', role ? { description: role } : {})

  let section = ''
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    // Headings: "## Action items", "**Decisions**", "Risks:".
    const heading = line.match(/^#{1,6}\s+(.+)$/) ?? line.match(/^\*\*([^*]+)\*\*:?$/) ?? line.match(/^([A-Z][A-Za-z &/]{2,30}):$/)
    if (heading) {
      section = SECTION.find(([re]) => re.test(heading[1]))?.[1] ?? 'notes'
      if (section === 'actions') covers.add('TASK')
      if (section === 'decisions') covers.add('DECISION')
      if (section === 'milestones') covers.add('MILESTONE')
      continue
    }

    // Attendees: "**Attendees:** Sarah Chen (Program Director), Raj Patel".
    const att = line.match(/^\**attendees\**:?\**\s*(.+)$/i)
    if (att) {
      for (const part of att[1].split(/,(?![^(]*\))/)) {
        const m = part.trim().match(new RegExp(`^(${NAME})\\s*(?:\\(([^)]+)\\))?`))
        if (m) person(m[1], m[2])
      }
      continue
    }

    const item = line.replace(/^([-*•]|\d+[.)])\s+/, '')
    const isItem = item !== line

    // Reporting lines / team membership, anywhere in the text.
    for (const sentence of item.split(/(?<=\.)\s+/)) {
      const rep = sentence.match(new RegExp(`reports? to (${NAME})`))
      if (rep) {
        const subj = sentence.match(new RegExp(`^(?:The\\s+)?(${NAME})`))
        if (subj && subj[1] !== rep[1] && !/team$/i.test(subj[1])) {
          addEdge(person(subj[1]), person(rep[1]), 'REPORTS_TO')
          hasReporting = true
        }
      }
      const lead = sentence.match(new RegExp(`^(${NAME}) leads the ([A-Z][A-Za-z ]*?Team)\\b`))
      if (lead) addEdge(person(lead[1]), addNode(lead[2], 'TEAM'), 'RESPONSIBLE_FOR')
      const join = sentence.match(new RegExp(`^(${NAME}) (?:joins|is part of|is on)(?: from)? the ([A-Z][A-Za-z ]*?Team)\\b`))
      if (join) addEdge(person(join[1]), addNode(join[2], 'TEAM'), 'PART_OF')
      // "Sarah Chen owns the Payments Platform Migration project." / "The Platform Team is responsible for the API Gateway."
      const own = sentence.match(new RegExp(`^(?:The\\s+)?(${NAME}|[A-Z][A-Za-z ]*?Team) (owns|is responsible for|is accountable for) (?:the\\s+)?([A-Z][A-Za-z0-9 -]{1,50}?)(?: (project|system|service))?(?:[.,;]|$)`))
      if (own && !/reports? to/.test(sentence)) {
        const owner = /team$/i.test(own[1]) ? addNode(own[1], 'TEAM') : person(own[1])
        const known = (ctx.knownEntities ?? []).find((e) => normalize(e.label) === normalize(own[3]))
        const type: NodeType = (known?.type as NodeType) ?? (own[4] === 'project' ? 'PROJECT' : 'OTHER')
        const label = own[4] === 'service' ? `${own[3]} Service` : own[3]
        addEdge(owner, findNode(label) ?? addNode(label, type), own[2] === 'owns' ? 'OWNS' : 'RESPONSIBLE_FOR')
      }
    }

    // Inline "Decision: ..." anywhere.
    const inlineDecision = item.match(/^decision\s*[:\-–]\s*(.+)$/i)
    if (inlineDecision || (section === 'decisions' && isItem)) {
      const body = clean(inlineDecision ? inlineDecision[1] : item)
      const label = cap(clean(body.split(/\s*[(,;]|\s+rather than\s+|\s+not\s+a\s+/i)[0]).slice(0, 70))
      addNode(label, 'DECISION', { description: body.length > label.length ? body : undefined, date: ctx.meetingDate })
      covers.add('DECISION')
      continue
    }

    // Status updates about existing action items / blockers / milestones (any section).
    const moved = item.match(/\bmove[sd]?\s+(?:from\s+(\d{4}-\d{2}-\d{2})\s+)?to\s+(\d{4}-\d{2}-\d{2})|\b(?:slips?|slipped|pushed|rescheduled|delayed)\s+to\s+(\d{4}-\d{2}-\d{2})/i)
    if (moved) {
      const target = mentioned(item, ['MILESTONE', 'TASK'])
      if (target) { addNode(target.label, target.type, { date: moved[2] ?? moved[3] }); continue }
    }
    if (STATUS_WORDS.test(item) && (section === 'updates' || section === 'actions' || section === 'risks' || section === 'notes' || !section)) {
      const target = mentioned(item, ['TASK', 'BLOCKER', 'MILESTONE'])
      const status = target && statusFrom(item, target.type)
      if (target && status) { addNode(target.label, target.type, { status }); continue }
    }

    if (!isItem) continue

    if (section === 'actions') {
      // "Raj Patel: draft the target architecture (due 2026-09-12)." / "Raj to draft ..."
      const due = item.match(new RegExp(`\\(?\\s*(?:due|by)\\s*(${DATE.source})\\s*\\)?`, 'i'))
      let body = item.replace(due?.[0] ?? '', '')
      let owner: string | undefined
      const colon = body.match(new RegExp(`^(${NAME}|[A-Z][A-Za-z ]*Team)\\s*[:\\-–]\\s*(.+)$`))
      const to = body.match(new RegExp(`^(${NAME}) (?:to|will) (.+)$`))
      if (colon) { owner = colon[1]; body = colon[2] } else if (to) { owner = to[1]; body = to[2] }
      const status = statusFrom(body, 'TASK')
      const label = cap(clean(body.replace(/\b(is|are)?\s*(done|in progress|completed?)\b.*$/i, '')).slice(0, 80))
      if (!label) continue
      const task = addNode(label, 'TASK', { date: due?.[1], status: status ?? 'OPEN' })
      if (owner) addEdge(/team$/i.test(owner) ? addNode(owner, 'TEAM') : person(owner), task, 'RESPONSIBLE_FOR')
      continue
    }

    if (section === 'milestones') {
      // "Checkout launch: 2026-10-31." / "Dual-run cutover on 2026-12-15"
      const m = item.match(new RegExp(`^(.+?)\\s*(?:[:\\-–]|\\bon\\b|\\bby\\b)\\s*(${DATE.source})`))
      if (m) addNode(cap(clean(m[1])), 'MILESTONE', { date: m[2], status: 'OPEN' })
      continue
    }

    if (section === 'risks') {
      // "PCI audit: the audit has not been done. It blocks the Payments Service go-live."
      const m = item.match(/^([^:]{3,60}?)\s*[:\-–]\s*(.+)$/)
      const label = cap(clean(m ? m[1] : item.split(/[.,;]/)[0]).slice(0, 60))
      const detail = m ? clean(m[2]) : item
      const resolved = statusFrom(detail, 'BLOCKER')
      const blocker = addNode(label, 'BLOCKER', { description: detail.slice(0, 200), status: resolved ?? 'OPEN' })
      covers.add('BLOCKER')
      for (const t of blockTargets(detail)) {
        const known = (ctx.knownEntities ?? []).find((e) => e.label === t)
        addEdge(blocker, findNode(t) ?? addNode(t, (known?.type as NodeType) ?? 'OTHER'), 'BLOCKS')
      }
    }
  }
  return { nodes, edges, covers, hasReporting }
}

/**
 * Merge model output with parsed structure. The parser wins for the types its sections covered and
 * for explicit reporting lines; the model contributes everything else (systems, ownership, flows).
 */
export function combineWithModel(model: Extraction, parsed: ParsedMinutes): Extraction {
  const replaced = (n: XNode) =>
    parsed.covers.has(n.type) ||
    parsed.nodes.some((p) => p.type === n.type && (normalize(p.label) === normalize(n.label) || similarity(p.label, n.label) >= 0.75)) ||
    // "Action item: Sarah Chen"-style junk labels
    /^(action items?|decision|blocker|risk|milestone)\s*[:\-]/i.test(n.label)
  const keptModelNodes = model.nodes.filter((n) => !replaced(n))
  const idMap = new Map<string, string>()
  // Model nodes that duplicate a parsed node (any type) are folded into it.
  for (const n of model.nodes) {
    const p = parsed.nodes.find((x) => normalize(x.label) === normalize(n.label)) ??
      parsed.nodes.find((x) => x.type === n.type && similarity(x.label, n.label) >= 0.75)
    if (p) idMap.set(n.temporaryId, p.temporaryId)
  }
  const nodes = [...keptModelNodes.filter((n) => !idMap.has(n.temporaryId)), ...parsed.nodes]
  const ids = new Set(nodes.map((n) => n.temporaryId))
  const remap = (id: string) => idMap.get(id) ?? id
  const modelEdges = model.edges
    .map((e) => ({ ...e, sourceTemporaryId: remap(e.sourceTemporaryId), targetTemporaryId: remap(e.targetTemporaryId) }))
    .filter((e) => ids.has(e.sourceTemporaryId) && ids.has(e.targetTemporaryId))
    .filter((e) => !(parsed.hasReporting && /REPORTS_TO|MANAGES/i.test(e.relationship)))
  return { ...model, nodes, edges: [...modelEdges, ...parsed.edges] }
}
