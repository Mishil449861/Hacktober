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

/** Past forms that share no prefix with the verb, so "has sent the invitations" finds "Send the invitations". */
const IRREGULAR: Record<string, string> = {
  sent: 'send', wrote: 'write', written: 'write', made: 'make', built: 'build', bought: 'buy', paid: 'pay',
  ran: 'run', gave: 'give', given: 'give', got: 'get', took: 'take', taken: 'take', held: 'hold', met: 'meet',
  chose: 'choose', chosen: 'choose', spoke: 'speak', spoken: 'speak', told: 'tell', found: 'find', kept: 'keep',
  drew: 'draw', drawn: 'draw', sold: 'sell', taught: 'teach', brought: 'bring', set: 'set', led: 'lead', did: 'do',
}

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .filter((t) => t && !STOP.has(t)).map((t) => (IRREGULAR[t] ?? t).slice(0, 5))

const BULLET = /^([-*•]|\d+[.)])\s+/
const headingOf = (line: string) =>
  line.match(/^#{1,6}\s+(.+)$/) ?? line.match(/^\*\*([^*]+)\*\*:?$/) ?? line.match(/^([A-Z][A-Za-z &/]{2,30}):$/)

/**
 * People type several sentences on one line ("Sam will write the agenda by Friday. Maya has sent the
 * invitations. Done."). Outside structured sections, give each sentence its own line, keeping a short
 * status fragment ("Done.") with the sentence it finishes. Bullets and structured sections stay whole.
 */
function splitProse(text: string): string[] {
  const out: string[] = []
  let structured = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = line && headingOf(line)
    if (heading) structured = SECTION.some(([re]) => re.test(heading[1]))
    if (!line || heading || structured || BULLET.test(line) || /^\**attendees/i.test(line)) { out.push(raw); continue }
    const sentences: string[] = []
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const fragment = s.split(/\s+/).length <= 3 && STATUS_WORDS.test(s)
      if (fragment && sentences.length) sentences[sentences.length - 1] += ' ' + s
      else sentences.push(s)
    }
    out.push(...sentences)
  }
  return out
}

/** "book" ~ "booke(d)" ~ "booki(ng)": stems match when one is a prefix of the other (4+ letters). */
const sameStem = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)))

/** Share of an entity's content words that appear in a line (prefix-stemmed). */
function mentionScore(line: string, label: string) {
  const lt = tokens(line), et = tokens(label)
  if (!et.length) return 0
  const hit = et.filter((t) => lt.some((l) => sameStem(l, t))).length
  return hit < Math.min(2, et.length) ? 0 : hit / et.length
}

const MONTH = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
const MONTH_NUM: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Rewrite dates the way people write them into YYYY-MM-DD, relative to the meeting date:
 * "Oct 10", "October 10th, 2026", "10 Oct", "by Friday", "due tomorrow".
 */
export function normalizeDates(line: string, meetingDate?: string): string {
  const base = new Date(`${meetingDate ?? iso(new Date())}T00:00:00Z`)
  const fromParts = (mon: string, day: string, year?: string) => {
    const d = new Date(Date.UTC(year ? Number(year) : base.getUTCFullYear(), MONTH_NUM[mon.slice(0, 3).toLowerCase()] - 1, Number(day)))
    // No year given and the date is long past: they mean next year ("Jan 15" said in November).
    if (!year && base.getTime() - d.getTime() > 180 * 86_400_000) d.setUTCFullYear(d.getUTCFullYear() + 1)
    return iso(d)
  }
  const plusDays = (n: number) => iso(new Date(base.getTime() + n * 86_400_000))
  return line
    .replace(new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'g'), (_m, mon, day, year) => fromParts(mon, day, year))
    .replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\.?(?:,?\\s+(\\d{4}))?\\b`, 'g'), (_m, day, mon, year) => fromParts(mon, day, year))
    .replace(new RegExp(`\\b(due|by)\\s+(?:on\\s+|next\\s+|this\\s+)?(${WEEKDAYS.join('|')})\\b`, 'gi'), (_m, kw, wd) => {
      const ahead = (WEEKDAYS.indexOf(wd.toLowerCase()) - base.getUTCDay() + 7) % 7 || 7
      return `${kw} ${plusDays(ahead)}`
    })
    .replace(/\b(due|by)\s+(today|tomorrow)\b/gi, (_m, kw, w) => `${kw} ${plusDays(w.toLowerCase() === 'today' ? 0 : 1)}`)
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
  const lines = splitProse(text)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    // Headings: "## Action items", "**Decisions**", "Risks:".
    const heading = headingOf(line)
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

    const rawItem = line.replace(BULLET, '')
    const isItem = rawItem !== line
    // Dates as people write them ("by Oct 10", "by Friday") become ISO for parsing; labels keep the original wording.
    const item = normalizeDates(rawItem, ctx.meetingDate)

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
    const inlineDecision = rawItem.match(/^decision\s*[:\-–]\s*(.+)$/i)
    if (inlineDecision || (section === 'decisions' && isItem)) {
      const body = clean(inlineDecision ? inlineDecision[1] : rawItem)
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

    // Action items also appear without an "Action items" heading: "TODO: ...", "Action: ...", or a
    // bullet with an owner and a due date ("- Dana Kim: book the venue (due 2026-10-20)").
    const todo = item.match(/^(?:todo|to do|action(?: item)?|ai)\s*[:\-–]\s*(.+)$/i)
    const due = item.match(new RegExp(`\\(?\\s*(?:due|by)\\s*(${DATE.source})\\s*\\)?`, 'i'))
    // "Ben: book the venue by Oct 10" or "Ben will book the venue by Friday"
    const ownerFirst = new RegExp(`^(?:(${NAME}|[A-Z][A-Za-z ]*Team)\\s*[:\\-–]\\s*\\S|(${NAME}) (?:to|will) \\S)`).test(item)
    const looseTask = !!todo || (!!due && ownerFirst && !['milestones', 'risks', 'decisions', 'updates'].includes(section))

    if (!isItem && !looseTask) continue

    if (section === 'actions' || looseTask) {
      // Explicit action items in the text: the parser's list is the to-do list (the model's guesses are replaced).
      covers.add('TASK')
      // "Raj Patel: draft the target architecture (due 2026-09-12)." / "Raj to draft ..."
      let body = (todo ? todo[1] : item).replace(due?.[0] ?? '', '')
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
export function combineWithModel(model: Extraction, parsed: ParsedMinutes, sourceText = ''): Extraction {
  const hasDecisionLanguage = !sourceText || /\b(decid\w*|decisions?|agreed|we will|going with|chose|chosen)\b/i.test(sourceText)
  const replaced = (n: XNode) =>
    parsed.covers.has(n.type) ||
    // The model turns status updates into "decisions"; keep its decisions only if the text has decision language.
    (n.type === 'DECISION' && !hasDecisionLanguage) ||
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
  // Who owns a parsed action item comes from the notes ("Maya: send the invitations"), never from the
  // model: it sometimes links a second person who merely appears nearby.
  const parsedTasks = new Set(parsed.nodes.filter((n) => n.type === 'TASK').map((n) => n.temporaryId))
  const ownerTypes = new Map(nodes.filter((n) => n.type === 'PERSON' || n.type === 'TEAM').map((n) => [n.temporaryId, n.type]))
  const guessesTaskOwner = (e: XEdge) =>
    (parsedTasks.has(e.sourceTemporaryId) && ownerTypes.has(e.targetTemporaryId)) ||
    (parsedTasks.has(e.targetTemporaryId) && ownerTypes.has(e.sourceTemporaryId))
  const modelEdges = model.edges
    .map((e) => ({ ...e, sourceTemporaryId: remap(e.sourceTemporaryId), targetTemporaryId: remap(e.targetTemporaryId) }))
    .filter((e) => ids.has(e.sourceTemporaryId) && ids.has(e.targetTemporaryId))
    .filter((e) => !(parsed.hasReporting && /REPORTS_TO|MANAGES/i.test(e.relationship)))
    .filter((e) => !guessesTaskOwner(e))
  return { ...model, nodes, edges: [...modelEdges, ...parsed.edges] }
}
