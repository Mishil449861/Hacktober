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

/**
 * `owners`: who a known TASK is assigned to, so "Linh finished testing" finds Linh's testing task.
 * `date`: its current due/target date, so "now due 2 days later" can be worked out.
 */
export interface KnownEntity { label: string; type: string; status?: string; date?: string; owners?: string[] }
export interface ParsedMinutes {
  nodes: XNode[]
  edges: XEdge[]
  /** Node types whose section was present, so model output for that type is replaced, not merged. */
  covers: Set<NodeType>
  /** True when reporting lines were stated explicitly ("X reports to Y"). */
  hasReporting: boolean
  /** Crossed-out items ("banner ads"): never to-dos, whichever reading or the model saw them. */
  struck: string[]
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

/** "Sarah", "Sarah + Mike", "Sarah, Mike and Alex": everyone a line hands an item to. */
const OWNERS = `${NAME}(?:\\s*(?:,|\\+|&|/|\\band\\b)\\s*${NAME})*`
const splitOwners = (s: string) => s.split(/\s*(?:,|\+|&|\/|\band\b)\s*/).filter(Boolean)
/** "Mike will review", "Alex to investigate", "Sam needs to book": a commitment, not a report. */
const COMMIT = '(?:to|will|needs? to|has to|should|must|is going to)'
/** "We need to fix the login bug": a to-do with nobody named yet. */
const NEED = /^(?:(?:we|someone|still)\s+)?(?:need|needs|have|has|must|should)\s+to\s+(.+)$/i
/** Words that end in -ed but are verbs to do, not things done. */
const NOT_PAST = new Set(['need', 'feed', 'seed', 'speed', 'proceed', 'embed', 'succeed', 'exceed', 'shred', 'wed'])

/** Events a meeting schedules, and the noun each makes a milestone of ("launch beta" -> "Beta launch"). */
const EVENT_NOUN: Record<string, string> = {
  launch: 'launch', release: 'release', demo: 'demo', 'kick off': 'kickoff', 'roll out': 'rollout', 'cut over': 'cutover',
  'go live': 'go-live', freeze: 'freeze', ship: '', deploy: '', deliver: '', present: '', start: '', finish: '', complete: '',
}
const EVENT = new RegExp(`\\b(?:agreed|decided|committed|plan(?:s|ned)?|aim(?:s|ing)?|going)\\s+to\\s+(${Object.keys(EVENT_NOUN).join('|').replace(/ /g, '[\\s-]')})\\s+(.*?)\\s*(?:\\b(?:on|by)\\s+)?(${DATE.source})`, 'i')

/** "finish the redesign", not "presented the shortlist" or "the budget is approved": the item asks for work. */
function asksForWork(body: string) {
  const first = body.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? ''
  if (!first || STOP.has(first) || /^(?:we|i|he|she|they|you|everyone|nothing|no|great|good|out|off|away|ok|okay)$/.test(first)) return false
  if (/ed$/.test(first) && !NOT_PAST.has(first)) return false
  if (IRREGULAR[first] && IRREGULAR[first] !== first) return false
  return !/\b(?:is|are|was|were|has been|have been)\b/i.test(body)
}

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .filter((t) => t && !STOP.has(t)).map((t) => (IRREGULAR[t] ?? t).slice(0, 5))

const BULLET = /^([-*•]|\d+[.)])\s+/
const BARE_LABEL = /^([A-Z][A-Za-z &/]{2,30}):$/
const headingOf = (line: string) =>
  line.match(/^#{1,6}\s+(.+)$/) ?? line.match(/^\*\*([^*]+)\*\*:?$/) ?? line.match(BARE_LABEL)

// ---------- handwritten / informal notes ----------
// Photographed notes are lists, not minutes: "Maya:" or "Maya → Design" over a few items, a "DUE: Oct 14"
// line under them, ✓ for done, "→ started" qualifying the item above. The layout carries the ownership.

/** Every way an arrow gets written or OCR'd ("->", "-->", "=>", "→") becomes " → ". */
const ARROW = /\s*(?:-+>|=+>|[—–]+>|[→⟶➔➙➜➝➞⇒])\s*/g
const tidy = (raw: string) => raw.replace(ARROW, ' → ')
const DONE_MARK = /^(?:[✓✔☑✅]|\[[xX✓✔]\])\s*/
const OPEN_MARK = /^(?:[☐□]|\[ \])\s*/
/** Crossed-out text (the vision transcript writes it as ~~text~~, with or without a bullet): not part of the notes. */
const STRUCK = /^(?:[-*•—–]\s*)?~~.+~~$/
/**
 * In a photo, the line through crossed-out text reads as a long dash glued to the first word: the vision
 * model wrote "—banner ads" and tesseract "—bommer—s" for "- banner ads" struck through, while plain
 * items read "- logo". Typed notes never get this rule: there a dash is just punctuation.
 */
const STRUCK_IN_PHOTO = /^[—–―](?=\p{L})/u
const struckText = (line: string) => clean(line.replace(/~~/g, '').replace(/^[-*•—–―\s]+/, ''))

/** A parse with its crossed-out items (from any reading of the same input) removed, nodes and edges. */
export function dropStruck(p: ParsedMinutes, struck: string[]): ParsedMinutes {
  const isStruck = (label: string) => struck.some((s) => normalize(s) === normalize(label) || similarity(s, label) >= 0.75)
  const gone = new Set(p.nodes.filter((n) => n.type !== 'PERSON' && n.type !== 'TEAM' && isStruck(n.label)).map((n) => n.temporaryId))
  return {
    ...p,
    nodes: p.nodes.filter((n) => !gone.has(n.temporaryId)),
    edges: p.edges.filter((e) => !gone.has(e.sourceTemporaryId) && !gone.has(e.targetTemporaryId)),
    struck: [...new Set([...p.struck, ...struck])],
  }
}
const ISO_ONLY = new RegExp(`^(?:due|by)?\\s*[:\\-–]?\\s*(${DATE.source})[\\s.]*$`, 'i')
const DUE_LINE = new RegExp(`^(?:due|by|deadline|until)\\s*[:\\-–]?\\s*(?:on\\s+)?(${DATE.source})[\\s.]*$`, 'i')
const DUE_INLINE = new RegExp(`[(\\[,;]?\\s*\\b(?:due|deadline)\\s*[:\\-–]?\\s*(?:on\\s+)?(${DATE.source})\\s*[)\\],;]?`, 'i')
/** "by 2026-10-30", "due on 2026-10-30", ", which is due 2026-10-29": an item's due date, with the words to cut from its label. */
export const DUE_ANY = new RegExp(`\\(?\\s*(?:,?\\s*(?:which|that)\\s+(?:is|are)\\s+)?\\b(?:due|by|deadline)\\s*[:\\-–]?\\s*(?:on\\s+)?(${DATE.source})\\s*\\)?`, 'i')
const OWNER_TYPES = new Set(['PERSON', 'TEAM'])
const STATUS_ONLY =/^(?:todo|to do|open|not started|done|complete[d]?|finished|in progress|wip|started|doing|halfway)$/i
/** "ALL → Oct 23": the whole group, not a person. */
const EVERYONE = /^(?:all|everyone|everybody|team|the team|all of us)$/i
/** Labels that sit on their own line like a name ("Notes:", "NEW:", "Design") but are not people. */
const NOT_NAMES = new Set([
  'project', 'projects', 'notes', 'note', 'new', 'need', 'needs', 'next', 'next meeting', 'next steps', 'next week', 'this week',
  'agenda', 'attendees', 'present', 'summary', 'overview', 'todo', 'done', 'doing', 'backlog', 'goals', 'goal', 'ideas', 'questions',
  'misc', 'other', 'others', 'all', 'everyone', 'team', 'general', 'kickoff', 'sync', 'weekly sync', 'standup', 'retro',
  'retrospective', 'planning', 'review', 'sprint', 'meeting', 'minutes', 'date', 'due', 'deadline', 'priority', 'priorities',
  'parking lot', 'fyi', 'wins', 'later', 'today', 'tomorrow', 'design', 'backend', 'frontend', 'research', 'marketing', 'sales',
  'engineering', 'product', 'ops', 'qa', 'legal', 'finance', 'it', 'hr', 'admin', 'budget', 'demo', 'launch', 'plan', 'scope',
  'context', 'background', 'problem', 'solution', 'results', 'outcome', 'outcomes', 'open', 'closed', 'completed', 'wip', 'topics',
  'discussion', 'intro', 'reminders', 'tbd', 'week',
])
const NAME_ONLY = new RegExp(`^${NAME}$`)
const NUMBER: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const COUNT = `(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)`
/** "2 days later", "a week earlier" / "pushed back by 3 days", "brought forward by a week": a date moved by an amount. */
const SHIFT = new RegExp(`\\b${COUNT}\\s+(days?|weeks?)\\s+(later|earlier|sooner|back|out)\\b|` +
  `\\b(pushed|moved|delayed|postponed|extended|slipped|brought forward|pulled in)\\s+(?:back\\s+|out\\s+|forward\\s+)?by\\s+${COUNT}\\s+(days?|weeks?)\\b`, 'i')
/** "Hackathon Project" on its own line: what the list below is about. */
const PROJECT_WORD = /\s(?:project|program|programme|initiative)$/i
const PROJECT_LINE = /^([A-Z][A-Za-z0-9&' -]{1,40}\s(?:Project|Program|Programme|Initiative))\s*:?$/
const NAME_HEAD = new RegExp(`^(?:#{1,6}\\s+)?\\**(${NAME})\\**\\s*(:?)\\**\\s*$`)

/** A person's or team's name, not a section word, month, weekday or all-caps title ("WEEKLY SYNC"). */
function isName(s: string) {
  const t = s.trim()
  if (!NAME_ONLY.test(t) || NOT_NAMES.has(t.toLowerCase())) return false
  if (SECTION.some(([re]) => re.test(t)) || new RegExp(`^(?:${MONTH}|${WEEKDAY})$`, 'i').test(t)) return false
  // "Hackathon Project", "Mobile Program": what a list is about, not who.
  if (PROJECT_WORD.test(t)) return false
  return !(t.includes(' ') && t === t.toUpperCase())
}
/** "MAYA" -> "Maya", so a name in block capitals matches the same person written normally. */
const displayName = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s)

/** "Maya:", "## Maya", "**Maya**" (explicit), or a bare "Maya" line (only a heading if the layout says so). */
function nameHeading(line: string): { name: string; explicit: boolean } | undefined {
  const m = line.match(NAME_HEAD)
  if (!m || !isName(m[1])) return undefined
  return { name: m[1], explicit: m[2] === ':' || /^[#*]/.test(line) }
}

const isSubItem = (raw: string) => /^\s+\S/.test(raw) || BULLET.test(raw.trim()) || DONE_MARK.test(raw.trim()) || OPEN_MARK.test(raw.trim())

/**
 * Names that head or own items somewhere in these notes: explicit headings ("Maya:"), arrow owners
 * ("Maya → API"), "(Maya)" suffixes, and a bare name line that starts a block and has items under it.
 * A bare "Sarah" under a sticky-note task is none of these, so it does not capture the next task.
 */
function ownerNames(lines: string[], arrowOwner: (parts: string[]) => boolean) {
  const names = new Set<string>()
  lines.forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return
    const head = nameHeading(line)
    if (head?.explicit) names.add(head.name.toLowerCase())
    const parts = line.replace(BULLET, '').split('→').map((p) => p.trim())
    if (parts[0] && arrowOwner(parts.filter(Boolean)) && !EVERYONE.test(parts[0])) names.add(parts[0].toLowerCase())
    const paren = line.match(new RegExp(`\\((${NAME})\\)\\s*$`))
    if (paren && isName(paren[1])) names.add(paren[1].toLowerCase())
    // A bare name heads a list when it starts a block, or when bulleted items follow it directly.
    const next = lines.slice(i + 1).find((l) => l.trim())
    if (head && !head.explicit && next && !nameHeading(next.trim()) && !headingOf(next.trim()) &&
        (!lines[i - 1]?.trim() || isSubItem(next))) names.add(head.name.toLowerCase())
  })
  return names
}

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
export function mentionScore(line: string, label: string) {
  const words = tokens(line), et = tokens(label)
  // "set up" for "setup", "log in" for "login": a pair of words written as one.
  const lt = [...words, ...words.slice(1).map((w, i) => (words[i] + w).slice(0, 5))]
  if (!et.length) return 0
  const hit = et.filter((t) => lt.some((l) => sameStem(l, t))).length
  return hit < Math.min(2, et.length) ? 0 : hit / et.length
}

const MONTH = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
const MONTH_NUM: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
/** Full names before abbreviations, so "tues" is not cut to "tue". */
const WEEKDAY = [...WEEKDAYS, 'sun', 'mon', 'tues', 'tue', 'wed', 'thurs', 'thur', 'thu', 'fri', 'sat'].join('|')
const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Rewrite dates the way people write them into YYYY-MM-DD, relative to the meeting date:
 * "Oct 10", "October 10th, 2026", "10 Oct", "by Friday", "DUE: Fri", "due tomorrow".
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
    .replace(new RegExp(`\\b(due|by)(?:\\s*[:\\-–]\\s*|\\s+)(?:on\\s+|next\\s+|this\\s+)?(${WEEKDAY})\\b\\.?`, 'gi'), (_m, kw, wd) => {
      const day = WEEKDAYS.findIndex((d) => d.startsWith(wd.slice(0, 3).toLowerCase()))
      const ahead = (day - base.getUTCDay() + 7) % 7 || 7
      return `${kw} ${plusDays(ahead)}`
    })
    .replace(/\b(due|by)(?:\s*[:\-–]\s*|\s+)(today|tomorrow)\b/gi, (_m, kw, w) => `${kw} ${plusDays(w.toLowerCase() === 'today' ? 0 : 1)}`)
    // "launch beta next Tuesday", "demo this Friday", "on Monday": the coming one, as with "by Tuesday".
    .replace(new RegExp(`\\b(next|this|coming|on)\\s+(?:coming\\s+)?(${WEEKDAY})\\b\\.?`, 'gi'), (_m, kw, wd) => {
      const day = WEEKDAYS.findIndex((d) => d.startsWith(wd.slice(0, 3).toLowerCase()))
      const ahead = (day - base.getUTCDay() + 7) % 7 || 7
      return `${kw.toLowerCase() === 'on' ? 'on ' : ''}${plusDays(ahead)}`
    })
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s\-–—:*→~]+|[\s.;,:→~]+$/g, '').trim()

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

/** Status words of a handwritten list item: "DONE", "~ halfway", "→ started", "TODO". */
function itemStatus(text: string, type: NodeType = 'TASK'): NodeStatus | undefined {
  if (/\b(halfway|half done|wip|doing)\b/i.test(text)) return type === 'TASK' ? 'IN_PROGRESS' : undefined
  return statusFrom(text, type) ?? (/\b(todo|to do|not started)\b/i.test(text) ? 'OPEN' : undefined)
}
const RESOLVED_WORDS = /\b(resolved|fixed|unblocked|cleared)\b/i
const stripStatus = (s: string) =>
  s.replace(/\b(?:(?:is|are)\s+)?(?:done|complete[d]?|finished|resolved|fixed|unblocked|in progress|wip|started|halfway|todo|to do)\b[.!]*/gi, ' ')

/** "Need API credentials" / "DB test account still broken" -> the subject, so a later "fixed" can resolve it. */
const blockerLabel = (s: string) => s
  .replace(/^(?:need(?:s|ed)?|waiting (?:on|for)|blocked (?:by|on)|no)\s+/i, '')
  .replace(/\s+(?:(?:is|are)\s+)?(?:still\s+)?(?:broken|not done|not working|down|failing|pending|missing|blocked|outstanding|not ready|unavailable)$/i, '') || s

export function parseMinutes(
  text: string,
  /** `photo`: the text was read from an image (vision transcript or OCR), see STRUCK_IN_PHOTO. */
  ctx: { meetingDate?: string; knownEntities?: KnownEntity[]; photo?: boolean } = {},
): ParsedMinutes {
  const nodes: XNode[] = []
  const edges: XEdge[] = []
  const covers = new Set<NodeType>()
  const struck: string[] = []
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
  const ownerNode = (name: string) => (/team$/i.test(name) ? addNode(name, 'TEAM') : person(displayName(name)))

  // List state for handwritten-style notes (see ownerNames / listItem).
  /**
   * The name whose items these are. `plain`: unmarked lines belong to it too ("Maya:" then "landing page"),
   * unless the list is `bulleted`: then an unbulleted line is no longer part of it.
   */
  let block: { owner: XNode; plain: boolean; bulleted?: boolean } | undefined
  /** Items since the last blank or DUE line: a "DUE: Oct 14" below them is their shared due date. */
  let group: XNode[] = []
  /** The item a continuation line ("→ started", "~ halfway") qualifies. */
  let last: XNode | undefined
  /** After a bare "DECISION:" / "BLOCKER:" label, unbulleted lines are its items (until a blank line). */
  let listMode = false
  /** Kanban column heading ("DONE:", "DOING:") giving the status of the items under it. */
  let columnStatus: NodeStatus | undefined
  /** Under "Hackathon Project": "- Shriya (design)" lines are its members and their roles (until a blank line). */
  let roster: XNode | undefined
  let blanks = 1

  /**
   * A line reporting that someone did a known to-do, in the to-do's own verb: "Linh has tested the database",
   * "Ben booked the venue", "Linh finished testing". The rest of the line says which to-do; when it names none
   * ("Linh finished testing"), the speaker's only to-do with that verb is the one.
   */
  const didTask = (line: string) => {
    if (NEGATION.test(line)) return undefined
    const m = line.match(new RegExp(`^(${OWNERS}|[Ww]e|[Tt]hey|I|[Hh]e|[Ss]he)\\s+(?:(?:has|have|had)\\s+)?` +
      `(?:(?:just|already|finally|now|also)\\s+)?(finished\\s+|completed\\s+|done with\\s+)?([a-z]+)\\b(.*)$`))
    if (!m) return undefined
    const [, who, finished, word, rest] = m
    const stem = IRREGULAR[word] ?? (finished && /ing$/.test(word) ? word.slice(0, -3)
      : /ed$/.test(word) && !NOT_PAST.has(word) && word !== 'started' ? word.replace(/ied$/, 'y').replace(/ed$/, '') : undefined)
    if (!stem || stem.length < 2) return undefined
    const verb = tokens(stem)[0] ?? stem
    const pool = [
      ...(ctx.knownEntities ?? []).filter((e) => e.type === 'TASK'),
      ...nodes.filter((x) => x.type === 'TASK').map((x) => ({ label: x.label, owners: undefined as string[] | undefined })),
    ].filter((e) => tokens(e.label).some((t) => sameStem(t, verb)))
    const byMention = pool.map((e) => ({ e, s: mentionScore(line, e.label) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s)[0]?.e
    if (byMention) return byMention
    // Nothing after the verb but "today" and the like: whose to-do it is decides.
    if (tokens(rest).some((t) => !/^(?:\d|today|yeste|earli|alrea|this|week|morni|after|eveni|last|night)/.test(t))) return undefined
    const names = splitOwners(who).map((n) => normalize(n).split(' ')[0])
    const theirs = pool.filter((e) => 'owners' in e && e.owners?.some((o) => names.includes(normalize(o).split(' ')[0])))
    return theirs.length === 1 ? theirs[0] : undefined
  }

  /** A "DUE ..." line or "→ Oct 23" applies to the open, undated items above it, else to the item just above. */
  const applyDue = (date: string) => {
    const open = group.filter((x) => x.type === 'TASK' && !x.date && x.status !== 'DONE')
    const targets = open.length ? open : last && !last.date && ['TASK', 'MILESTONE'].includes(last.type) ? [last] : []
    for (const t of targets) t.date = date
    group = []
  }
  /** "→ started", "~ halfway", "→ waiting on IT", "→ Oct 23": about the previous item, not a new one. */
  const qualify = (node: XNode, text: string, original: string) => {
    const d = text.match(ISO_ONLY)
    if (d) return applyDue(d[1])
    const status = node.type === 'TASK' || node.type === 'BLOCKER' ? itemStatus(text, node.type) : undefined
    if (status) node.status = status
    else node.description = (node.description ? `${node.description}; ${original}` : original).slice(0, 200)
  }
  /**
   * One line of a handwritten list: "✓ landing page DONE", "- set up API", "DB testing", "polish UI (Maya)".
   * The owner is the block's name (or an explicit "(Name)"); without one the item stays unassigned.
   */
  const listItem = (raw: string, item: string, owner?: XNode) => {
    const line = raw.trim().replace(BULLET, '')
    const done = DONE_MARK.test(line), unticked = OPEN_MARK.test(line)
    let body = item.replace(DONE_MARK, '').replace(OPEN_MARK, '')
    const due = body.match(DUE_INLINE)
    if (due) body = body.replace(due[0], ' ')
    const paren = body.match(new RegExp(`^(.+?)\\s*\\((${NAME})\\)\\s*$`))
    if (paren && isName(paren[2])) { owner = ownerNode(paren[2]); body = paren[1] }
    const resolved = RESOLVED_WORDS.test(body) && !NEGATION.test(body)
    const status = done ? 'DONE' : itemStatus(body) ?? (unticked ? 'OPEN' : undefined)
    const label = cap(clean(stripStatus(body)).slice(0, 80))
    if (label.length < 2 || ISO_ONLY.test(label)) return
    const marked = done || unticked || isSubItem(raw)
    // A sentence is a note about the person, not a to-do.
    if (!marked && label.split(/\s+/).length > 8) return
    // "✓ competitor research DONE" then "5 competitors added": the outcome of the finished item.
    if (!marked && !status && !due && last?.status === 'DONE' && /[a-z]{2,}ed$/i.test(label)) return qualify(last, label, label)
    const known = mentioned(body, ['TASK', 'BLOCKER'])
    const node = known
      // Restating a known item only changes what the line says (a later "✓ landing page" is a status update).
      ? addNode(known.label, known.type, { status: known.type === 'BLOCKER' ? (resolved || status === 'DONE' ? 'RESOLVED' : undefined) : status, date: due?.[1] })
      // "✓ API key issue RESOLVED": an issue that was fixed, not a to-do.
      : resolved && (!done || /\b(issues?|problems?|blockers?|bugs?|outages?|errors?)\b/i.test(label))
        ? addNode(blockerLabel(label), 'BLOCKER', { status: 'RESOLVED' })
        : addNode(label, 'TASK', { status: status ?? columnStatus ?? 'OPEN', date: due?.[1] })
    if (node.type === 'TASK') {
      covers.add('TASK')
      if (owner) addEdge(owner, node, 'RESPONSIBLE_FOR')
    }
    last = node
    group.push(node)
  }

  let section = ''
  const lines = splitProse(text).map(tidy)
  // Arrows also draw diagrams ("Order Received → Fraud Check → Payment Capture"). A step that is the
  // target of one arrow and the source of another is a flow, never a person handing out a task.
  const flows = lines.map((l) => l.trim().replace(BULLET, '').split('→').map((p) => p.trim()))
    .filter((p) => p.length >= 2 && p[0] && p.slice(1).some((x) => x && !ISO_ONLY.test(x) && !STATUS_ONLY.test(x)))
  const flowSources = new Set(flows.map((p) => normalize(p[0])))
  const flowTargets = new Set(flows.flatMap((p) => p.slice(1).map(normalize)))
  const knownAs = (name: string, asPerson: boolean) => (ctx.knownEntities ?? []).some((e) =>
    OWNER_TYPES.has(e.type) === asPerson &&
    (normalize(e.label) === normalize(name) || (asPerson && e.type === 'PERSON' && normalize(e.label).split(' ')[0] === normalize(name))))
  let names = new Set<string>()
  /** "Maya → item": a name (not a known system, not a step in a flow) assigning one item. */
  const assignment = (parts: string[]) => {
    if (parts.length < 2) return false
    const [who, ...rest] = parts
    if (EVERYONE.test(who)) return true
    if (!isName(who) || knownAs(who, false)) return false
    if (who.includes(' ') && !names.has(who.toLowerCase()) && !knownAs(who, true)) return false
    const meta = rest.some((p) => ISO_ONLY.test(p) || STATUS_ONLY.test(p))
    if (!meta && rest.length >= 2) return false
    return !flowTargets.has(normalize(who)) && !flowSources.has(normalize(rest[0]))
  }
  names = ownerNames(lines, assignment)
  const nextLine = (i: number) => lines.slice(i + 1).find((l) => l.trim())
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line) {
      // One blank line separates groups inside a person's list; a wider gap ends the list.
      if (++blanks >= 2) block = undefined
      group = []
      listMode = false
      roster = undefined
      continue
    }
    blanks = 0
    if (STRUCK.test(line) || (ctx.photo && STRUCK_IN_PHOTO.test(line))) {
      const what = struckText(line)
      if (what) struck.push(what)
      continue
    }

    // A name heading ("Maya:", "## Maya", or a bare "Maya" the layout marks as one) starts that person's list.
    const head = nameHeading(line)
    if (head && !knownAs(head.name, false) && (head.explicit || names.has(head.name.toLowerCase()))) {
      block = { owner: ownerNode(head.name), plain: true }
      section = 'owner'
      group = []
      last = undefined
      listMode = false
      columnStatus = undefined
      continue
    }

    // Headings: "## Action items", "**Decisions**", "Risks:".
    const heading = headingOf(line)
    if (heading) {
      const word = heading[1].trim().toLowerCase()
      // "NEW:" inside a person's list introduces more of their items.
      if (block && /^new(?: items?| tasks?)?$/.test(word)) continue
      block = undefined
      group = []
      last = undefined
      listMode = BARE_LABEL.test(line)
      const column = /^(?:done|completed?|finished)$/.test(word) ? 'DONE' : /^(?:doing|in progress|wip)$/.test(word) ? 'IN_PROGRESS'
        : /^(?:todo|to do|backlog)$/.test(word) ? 'OPEN' : undefined
      columnStatus = column
      section = column || /^(?:needs?|new(?: items?| tasks?)?)$/.test(word) ? 'actions'
        : SECTION.find(([re]) => re.test(heading[1]))?.[1] ?? 'notes'
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
    let structural = false
    for (const sentence of item.split(/(?<=\.)\s+/)) {
      const rep = sentence.match(new RegExp(`reports? to (${NAME})`))
      if (rep) {
        const subj = sentence.match(new RegExp(`^(?:The\\s+)?(${NAME})`))
        if (subj && subj[1] !== rep[1] && !/team$/i.test(subj[1])) {
          addEdge(person(subj[1]), person(rep[1]), 'REPORTS_TO')
          hasReporting = structural = true
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
      if (lead || join || own) structural = true
    }

    // "PROJECT: CampusConnect"
    const project = rawItem.match(/^project\s*[:\-–]\s*(.{2,60})$/i)
    if (project) { addNode(clean(project[1]), 'PROJECT'); continue }
    // "Hackathon Project" on its own line, then "- Shriya (design)": the project's members and their roles.
    const projectLine = !isItem && line.match(PROJECT_LINE)
    if (projectLine) {
      roster = addNode(clean(projectLine[1]), 'PROJECT')
      block = undefined
      section = ''
      continue
    }
    const member = isItem && roster && rawItem.match(new RegExp(`^(${NAME})\\s*\\(([^()]{2,40})\\)\\s*$`))
    // "- Logo (Ben)" would be Ben's to-do; a role is not a name.
    if (member && roster && isName(member[1]) && !isName(member[2].trim())) {
      addEdge(person(displayName(member[1]), clean(member[2])), roster, 'PART_OF')
      continue
    }

    // Inline "Decision: ..." anywhere.
    const inlineDecision = rawItem.match(/^decision\s*[:\-–]\s*(.+)$/i)
    if (inlineDecision || (section === 'decisions' && (isItem || listMode))) {
      const body = clean(inlineDecision ? inlineDecision[1] : rawItem)
      const label = cap(clean(body.split(/\s*[(,;]|\s+rather than\s+|\s+not\s+a\s+/i)[0]).slice(0, 70))
      last = addNode(label, 'DECISION', { description: body.length > label.length ? body : undefined, date: ctx.meetingDate })
      covers.add('DECISION')
      continue
    }
    // Inline "BLOCKER: waiting on API key" anywhere.
    const inlineBlocker = rawItem.match(/^(?:blockers?|blocked|risks?)\s*[:\-–]\s*(.{3,})$/i)
    if (inlineBlocker) {
      const detail = clean(inlineBlocker[1])
      last = addNode(cap(clean(blockerLabel(detail)).slice(0, 60)), 'BLOCKER', { description: detail.slice(0, 200), status: statusFrom(detail, 'BLOCKER') ?? 'OPEN' })
      continue
    }

    // ---- handwritten-style lists ----
    // "→ started", "~ halfway", "→ Linh waiting on access": a note on the item above.
    const cont = line.match(/^(?:→|~(?!~))\s*(.+)$/)
    if (cont) {
      if (last) qualify(last, normalizeDates(cont[1], ctx.meetingDate), clean(cont[1]))
      continue
    }
    // "Maya → Design homepage → Oct 14", "Linh → API → DONE", "Maya → Design" (over a list), "ALL → Oct 23".
    const parts = item.split('→').map((p) => p.trim()).filter(Boolean)
    if (assignment(parts)) {
      const owner = EVERYONE.test(parts[0]) ? undefined : ownerNode(parts[0])
      let date: string | undefined, status: NodeStatus | undefined
      const rest: string[] = []
      for (const p of parts.slice(1)) {
        const d = p.match(ISO_ONLY)
        const s = !d && STATUS_ONLY.test(p) ? itemStatus(p) : undefined
        if (d) date = d[1]
        else if (s) status = s
        else rest.push(p)
      }
      if (!rest.length) {
        if (date) applyDue(date)
        if (status && last?.type === 'TASK') last.status = status
        continue
      }
      const next = nextLine(i)
      if (owner && !date && !status && next && isSubItem(next)) {
        // "Maya → Design" over a list: Design is Maya's area; the items below are her tasks.
        if (!owner.description) owner.description = rest.join(' → ')
        block = { owner, plain: false }
        section = 'owner'
        group = []
        last = undefined
        continue
      }
      const said = rest.join(' → ')
      const known = mentioned(said, ['TASK'])
      // A restated known task is an update: it only changes what the line says (no silent re-open).
      const task = known
        ? addNode(known.label, 'TASK', { date, status })
        : addNode(cap(clean(stripStatus(said)).slice(0, 80)) || said, 'TASK', { date, status: status ?? 'OPEN' })
      covers.add('TASK')
      if (owner) addEdge(owner, task, 'RESPONSIBLE_FOR')
      // Sub-items under "Maya → polish UI" are Maya's too; unmarked lines after it are not.
      block = owner ? { owner, plain: false } : undefined
      section = owner ? 'owner' : section
      last = task
      group = [task]
      continue
    }
    // "DUE: Oct 14" on its own line: the due date of the items above it.
    const dueLine = item.match(DUE_LINE)
    if (dueLine) { applyDue(dueLine[1]); continue }
    // Items in a person's list.
    if (block && section === 'owner' && !structural) {
      if (/^\s+\S/.test(raw) || isItem) block.bulleted = true
      if (isSubItem(raw) || (block.plain && !block.bulleted)) { listItem(raw, item, block.owner); continue }
      // "Maya → Design" lists, and bulleted lists, end at the first unmarked line.
      block = undefined
      section = ''
    }
    // "Fix login" with "DUE Oct 20" under it: an action item, with nobody named.
    const below = nextLine(i)
    if (!block && !isItem && !listMode && !['decisions', 'risks', 'milestones'].includes(section) && below &&
        DUE_LINE.test(normalizeDates(below.trim(), ctx.meetingDate)) && line.split(/\s+/).length <= 8 && !headingOf(below.trim())) {
      listItem(raw, item)
      continue
    }

    // Status updates about existing action items / blockers / milestones (any section).
    const moved = item.match(/\bmove[sd]?\s+(?:from\s+(\d{4}-\d{2}-\d{2})\s+)?to\s+(\d{4}-\d{2}-\d{2})|\b(?:slips?|slipped|pushed|rescheduled|delayed)\s+to\s+(\d{4}-\d{2}-\d{2})/i)
    if (moved) {
      const target = mentioned(item, ['MILESTONE', 'TASK'])
      if (target) { addNode(target.label, target.type, { date: moved[2] ?? moved[3] }); continue }
    }
    // "API setup is now due 2 days later", "the launch was pushed back by a week": its known date, moved.
    const shift = item.match(SHIFT)
    if (shift) {
      const target = mentioned(item, ['MILESTONE', 'TASK'])
      const from = target && (ctx.knownEntities ?? []).find((e) => e.label === target.label)?.date
      if (target && from) {
        const [count, unit, dir] = shift[1] ? [shift[1], shift[2], shift[3]] : [shift[5], shift[6], shift[4]]
        const days = (NUMBER[count.toLowerCase()] ?? Number(count)) * (/^week/i.test(unit) ? 7 : 1) * (/earlier|sooner|forward|pulled in/i.test(dir) ? -1 : 1)
        addNode(target.label, target.type, { date: new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10) })
        continue
      }
    }
    // "Linh has completed all of her tasks": every open to-do of hers.
    const allDone = !NEGATION.test(item) && item.match(new RegExp(`^(${OWNERS})\\s+(?:has\\s+|have\\s+|is\\s+|are\\s+)?` +
      `(?:completed|finished|done(?: with)?|wrapped up)\\s+(?:all|every one|each)\\s+(?:of\\s+)?(?:her|his|their|the)?\\s*(?:tasks?|to-?dos?|action items?|items?|work)\\b`))
    if (allDone) {
      const names = splitOwners(allDone[1]).map((o) => normalize(o).split(' ')[0])
      const theirs = (ctx.knownEntities ?? []).filter((e) => e.type === 'TASK' && e.status !== 'DONE' &&
        e.owners?.some((o) => names.includes(normalize(o).split(' ')[0])))
      for (const t of theirs) addNode(t.label, 'TASK', { status: 'DONE' })
      if (theirs.length) continue
    }
    if (STATUS_WORDS.test(item) && (section === 'updates' || section === 'actions' || section === 'risks' || section === 'notes' || !section)) {
      const target = mentioned(item, ['TASK', 'BLOCKER', 'MILESTONE'])
      const status = target && statusFrom(item, target.type)
      if (target && status) { addNode(target.label, target.type, { status }); continue }
    }
    // "Linh has tested the database" / "Linh finished testing": done, said with the to-do's own verb.
    const did = !['decisions', 'milestones', 'risks'].includes(section) && didTask(item)
    if (did) { addNode(did.label, 'TASK', { status: 'DONE' }); continue }

    // "Team agreed to launch beta next Tuesday" / "We decided to release v2 on Oct 30": a dated event the
    // group committed to is a milestone ("Beta launch"), not anyone's to-do.
    const event = !['decisions', 'risks', 'milestones'].includes(section) && item.match(EVENT)
    if (event) {
      const what = clean(event[2].replace(/^(?:the|a|an|our)\s+/i, ''))
      const verb = event[1].toLowerCase().replace(/[\s-]+/g, ' ')
      const noun = EVENT_NOUN[verb]
      const label = cap(noun && what ? `${what} ${noun}` : clean(`${event[1]} ${event[2]}`)).slice(0, 70)
      last = addNode(label, 'MILESTONE', { date: event[3], status: 'OPEN' })
      continue
    }

    // Action items also appear without an "Action items" heading: "TODO: ...", "Action: ...", or a
    // bullet with an owner and a due date ("- Dana Kim: book the venue (due 2026-10-20)").
    const todo = item.match(/^(?:todo|to do|action(?: item)?|ai)\s*[:\-–]\s*(.+)$/i)
    const due = item.match(DUE_ANY)
    // "Ben: book the venue by Oct 10" or "Ben will book the venue by Friday"
    const colonOwner = item.match(new RegExp(`^(${OWNERS}|[A-Z][A-Za-z ]*Team)\\s*[:\\-–]\\s*(\\S.*)$`))
    const commitOwner = item.match(new RegExp(`^(${OWNERS}) ${COMMIT} (\\S.*)$`))
    const ownerFirst = !!colonOwner || !!commitOwner
    const listSection = !['milestones', 'risks', 'decisions', 'updates'].includes(section)
    // "Fix login, due Oct 20": a short line with an explicit "due" is an action item even with nobody named.
    const ownerlessDue = !!due && /\bdue\b/i.test(item) && item.split(/\s+/).length <= 10
    // A bullet that hands someone work is a to-do even without a date: "- Mike will review the new UI",
    // "- Sarah + Mike: prepare demo", "- Need to fix login bug". "- Dana: presented the shortlist" is a report.
    const named = (who: string) => /team$/i.test(who) || splitOwners(who).every(isName)
    // "New member (Jim) tasked with UI design", "Ham is tasked with running the demo", "Maya is in charge of the venue".
    const tasked = item.match(new RegExp(`(?:^|[\\s(])(${OWNERS})\\)?,?\\s+(?:is\\s+|has been\\s+|was\\s+|will be\\s+|gets\\s+)?(?:tasked with|in charge of)\\s+(\\S.*)$`))
    const taskedBy = tasked && named(tasked[1]) ? tasked : undefined
    const bulletTask = (!!taskedBy && listSection) || isItem && listSection && (
      (!!commitOwner && named(commitOwner[1]) && !/^be\b/i.test(commitOwner[2])) ||
      (!!colonOwner && named(colonOwner[1]) && asksForWork(colonOwner[2])) ||
      (NEED.test(item) && asksForWork(item.match(NEED)![1])))
    const looseTask = !!todo || bulletTask || (!!due && (ownerFirst || ownerlessDue) && listSection)

    if (!isItem && !looseTask && !listMode) continue

    if (section === 'actions' || looseTask) {
      // Explicit action items in the text: the parser's list is the to-do list (the model's guesses are replaced).
      covers.add('TASK')
      // "Raj Patel: draft the target architecture (due 2026-09-12)." / "Raj to draft ..." / "polish UI (Maya)"
      let body = (todo ? todo[1] : item).replace(due?.[0] ?? '', '').replace(DONE_MARK, '').replace(OPEN_MARK, '')
      let owners: string[] = []
      const colon = body.match(new RegExp(`^(${OWNERS}|[A-Z][A-Za-z ]*Team)\\s*[:\\-–]\\s*(.+)$`))
      const to = body.match(new RegExp(`^(${OWNERS}) ${COMMIT} (.+)$`))
      const paren = body.match(new RegExp(`^(.+?)\\s*\\((${OWNERS})\\)\\s*$`))
      const need = body.match(NEED)
      const team = (s: string) => (/team$/i.test(s) ? [s] : splitOwners(s))
      if (taskedBy) { owners = team(taskedBy[1]); body = taskedBy[2].replace(due?.[0] ?? '', '') }
      else if (colon && team(colon[1]).every((o) => isName(o) || /team$/i.test(o))) { owners = team(colon[1]); body = colon[2] }
      else if (to && splitOwners(to[1]).every(isName)) { owners = splitOwners(to[1]); body = to[2] }
      else if (paren && splitOwners(paren[2]).every(isName)) { owners = splitOwners(paren[2]); body = paren[1] }
      else if (need) body = need[1]
      const status = DONE_MARK.test(rawItem) ? 'DONE' : statusFrom(body, 'TASK')
      const label = cap(clean(body.replace(/\b(is|are)?\s*(done|in progress|completed?)\b.*$/i, '')).slice(0, 80))
      if (!label) continue
      const task = addNode(label, 'TASK', { date: due?.[1], status: status ?? columnStatus ?? 'OPEN' })
      for (const owner of owners) addEdge(ownerNode(owner), task, 'RESPONSIBLE_FOR')
      last = task
      group.push(task)
      continue
    }

    if (section === 'milestones') {
      // "Checkout launch: 2026-10-31." / "Dual-run cutover on 2026-12-15"
      const m = item.match(new RegExp(`^(.+?)\\s*(?:[:\\-–]|\\bon\\b|\\bby\\b)\\s*(${DATE.source})`))
      if (m) {
        last = addNode(cap(clean(m[1])), 'MILESTONE', { date: m[2], status: 'OPEN' })
        covers.add('MILESTONE')
      }
      continue
    }

    if (section === 'risks') {
      // "PCI audit: the audit has not been done. It blocks the Payments Service go-live." / "Need API credentials"
      const m = item.match(/^([^:]{3,60}?)\s*[:\-–]\s*(.+)$/)
      const label = cap(clean(m ? m[1] : blockerLabel(item.split(/[.,;]/)[0])).slice(0, 60))
      const detail = m ? clean(m[2]) : item
      const resolved = statusFrom(detail, 'BLOCKER')
      const blocker = addNode(label, 'BLOCKER', { description: detail.slice(0, 200), status: resolved ?? 'OPEN' })
      last = blocker
      covers.add('BLOCKER')
      for (const t of blockTargets(detail)) {
        const known = (ctx.knownEntities ?? []).find((e) => e.label === t)
        addEdge(blocker, findNode(t) ?? addNode(t, (known?.type as NodeType) ?? 'OTHER'), 'BLOCKS')
      }
    }
  }
  return { nodes, edges, covers, hasReporting, struck }
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
    /^(action items?|decision|blocker|risk|milestone)\s*[:\-]/i.test(n.label) ||
    // The model also reads crossed-out items; the notes say they are cancelled.
    (n.type !== 'PERSON' && n.type !== 'TEAM' && (parsed.struck ?? []).some((s) => normalize(s) === normalize(n.label) || similarity(s, n.label) >= 0.75))
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
