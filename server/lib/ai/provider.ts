/**
 * Local model abstraction. The rest of the app calls analyzeImage / analyzeText /
 * reconcileGraph and never touches a runtime directly. No hosted APIs.
 */
import type { z } from 'zod'
import {
  EXTRACTION_JSON_SCHEMA, ExtractionSchema, NODE_TYPES, RECONCILE_JSON_SCHEMA, RELATIONSHIP_TYPES,
  ReconcileSchema, type Extraction, type ReconcileResult,
} from '../../../src/shared/schema.ts'
import { createRuntime } from './runtimes.ts'
import { normalize, similarity } from '../../graph/text.ts'
import { combineWithModel, parseMinutes } from '../minutes.ts'
import { ocrImage } from './ocr.ts'

export const runtime = createRuntime()
const DEV = process.env.NODE_ENV !== 'production'

const EXTRACT_SYSTEM = `You extract an organizational / process knowledge graph.
Return ONLY JSON matching the schema. No prose.
Node types: ${NODE_TYPES.join(', ')}.
Relationship types (use these when they fit, otherwise RELATES_TO with a short "label"): ${RELATIONSHIP_TYPES.join(', ')}.
Rules:
- One node per distinct real-world entity; reuse its temporaryId in edges ("node_1", "node_2", ...).
- Edge direction: source -> target. "A depends on B" = A DEPENDS_ON B. "Sarah owns X" = Sarah OWNS X. "A calls B" = A CALLS B.
- Pick the relationship by node types: PROCESS/MILESTONE step -> next step = PRECEDES (or FEEDS_INTO); SYSTEM/COMPONENT -> SYSTEM/COMPONENT = CALLS / USES / DEPENDS_ON; BLOCKER -> thing it blocks = BLOCKS.
- REPORTS_TO always points from the subordinate to the manager: "Raj reports to Maria" = Raj REPORTS_TO Maria. Never the reverse.
  "Maria manages Raj" may be emitted as Maria MANAGES Raj (it is converted automatically).
- Keep labels short and canonical (e.g. "Authentication Service", not "the new authentication service we discussed").
- A property or problem of an entity is NOT a separate node. "Auth API latency is blocking Checkout" = Auth API BLOCKS Checkout with label "latency".
  Only create a BLOCKER node for a blocker that is not a property of a named entity (e.g. "PCI audit not done").
- confidence is 0..1. Lower it for guesses or illegible content.
- description: at most 12 words, only when it adds information beyond the label (role, purpose, date). Otherwise omit it.
- Action items ("Raj: draft the plan", "AI:", "TODO", "will do X by Friday") are TASK nodes. Label = short imperative (max 8 words, e.g. "Draft API Gateway architecture").
  Link the owner: owner RESPONSIBLE_FOR task. Put the due date in "date" (YYYY-MM-DD), resolving relative dates against the meeting date.
- status (optional): TASK = OPEN | IN_PROGRESS | DONE; BLOCKER = OPEN | RESOLVED; MILESTONE = OPEN | DONE. Set it only when the text states it
  ("done", "completed", "resolved", "in progress", "still blocked"). A newly raised blocker or action item is OPEN.
- Name blockers by their subject without negation ("PCI audit", not "PCI audit not done") so later meetings can resolve them; put the detail in description.
- MILESTONE: put its target date in "date" when given. If the meeting moves a milestone, emit the milestone with the NEW date.
- If the input mentions something from the "Known entities" list, reuse that exact label (this is how updates attach to existing items).
- Output ONLY entities that appear in this input. Never re-list known entities the input does not mention. Keep the output compact.
- temporaryId: short, like "n1", "n2".
- Put anything unclear (illegible words, ambiguous arrows) in "ambiguities".
- summary: one or two sentences.`

export interface AnalysisResult {
  extraction: Extraction
  model: string
  ocrText?: string
}

class ModelOutputError extends Error {}

/** Call the model, validate with Zod, retry once with a JSON-repair prompt, then fail gracefully. */
async function structured<T extends z.ZodTypeAny>(
  schema: T,
  jsonSchema: object,
  system: string,
  user: string,
  opts: { images?: string[]; vision?: boolean } = {},
): Promise<z.infer<T>> {
  const raw = await runtime.chat({ system, user, jsonSchema, ...opts })
  const first = tryParse(schema, raw)
  if (first.ok) return first.value

  if (DEV) console.warn('[ai] invalid model output, retrying with repair prompt:', first.error, raw.slice(0, 500))
  // The repair retry re-sends the original task (and images). Output is often truncated mid-string,
  // and "fixing" just the fragment would silently drop every entity after the cut.
  const repaired = await runtime.chat({
    system,
    user: `${user}\n\n---\nYour previous answer was invalid (${first.error.slice(0, 300)}). ` +
      `It began:\n${raw.slice(0, 1500)}\n---\nReturn the COMPLETE answer again as valid JSON matching the schema, covering the whole input.`,
    jsonSchema,
    ...opts,
  })
  const second = tryParse(schema, repaired)
  if (second.ok) return second.value
  if (DEV) console.error('[ai] repair failed:', second.error, repaired.slice(0, 500))
  throw new ModelOutputError('The local model returned output that could not be validated. See server logs.')
}

function tryParse<T extends z.ZodTypeAny>(schema: T, raw: string): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  try {
    const cleaned = raw.replace(/^[\s\S]*?(?=\{)/, '').replace(/<think>[\s\S]*?<\/think>/g, '')
    const res = schema.safeParse(JSON.parse(cleaned))
    return res.success ? { ok: true, value: res.data } : { ok: false, error: res.error.message.slice(0, 1500) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

const STEP_TYPES = new Set(['PROCESS', 'MILESTONE'])
const MANAGES = new Set(['MANAGES', 'MANAGER_OF', 'SUPERVISES', 'LEADS', 'HAS_REPORT', 'DIRECT_REPORT'])
const OWNERSHIP = new Set(['OWNS', 'RESPONSIBLE_FOR'])
const OWNERS = new Set(['PERSON', 'TEAM'])
const PASSIVE: Record<string, string> = {
  BLOCKED_BY: 'BLOCKS', OWNED_BY: 'OWNS', DEPENDED_ON_BY: 'DEPENDS_ON', CALLED_BY: 'CALLS', USED_BY: 'USES',
  PRODUCED_BY: 'PRODUCES', PRECEDED_BY: 'PRECEDES', MANAGED_BY: 'RESPONSIBLE_FOR',
}
const ATTRIBUTE = /^(.+?)\s+(latency|outages?|downtime|performance|slowness|errors?|error rate|instability|issues?|problems?|delays?|costs?|capacity|bugs?|reliability)$/i
const norm = normalize // abbreviation-aware: "Auth API latency" folds into "Authentication API"

/**
 * "Auth API latency" next to "Auth API" is a property, not an entity: fold it into the entity,
 * moving its edges over and keeping the attribute as the edge label.
 */
function foldAttributeNodes(input: Extraction, known: { label: string; type: string }[] = []): Extraction {
  let x = input
  // Base entity not in this output but already on the map ("Auth API latency" when "Authentication API"
  // is known): rename the attribute node to that entity so the BLOCKS edge lands on it.
  const renamed = new Map<string, string>()
  x = {
    ...x,
    nodes: x.nodes.map((n) => {
      const m = n.label.match(ATTRIBUTE)
      if (!m || x.nodes.some((o) => o !== n && norm(o.label) === norm(m[1]))) return n
      const k = known.find((e) => norm(e.label) === norm(m[1]))
      if (!k) return n
      renamed.set(n.temporaryId, m[2].toLowerCase())
      return { ...n, label: k.label, type: k.type as typeof n.type }
    }),
  }
  if (renamed.size) {
    x = { ...x, edges: x.edges.map((e) => ({ ...e, label: e.label || renamed.get(e.sourceTemporaryId) || renamed.get(e.targetTemporaryId) })) }
  }
  const byLabel = new Map(x.nodes.map((n) => [norm(n.label), n.temporaryId]))
  const fold = new Map<string, { into: string; attr: string }>()
  for (const n of x.nodes) {
    const m = n.label.match(ATTRIBUTE)
    const into = m && byLabel.get(norm(m[1]))
    if (m && into && into !== n.temporaryId) fold.set(n.temporaryId, { into, attr: m[2].toLowerCase() })
  }
  if (!fold.size) return x
  const edges = x.edges.flatMap((e) => {
    const s = fold.get(e.sourceTemporaryId), t = fold.get(e.targetTemporaryId)
    const source = s?.into ?? e.sourceTemporaryId, target = t?.into ?? e.targetTemporaryId
    if (source === target) return [] // the "entity RELATES_TO its own attribute" edge
    const attr = s?.attr ?? t?.attr
    return [{ ...e, sourceTemporaryId: source, targetTemporaryId: target, label: e.label || attr }]
  })
  return { ...x, nodes: x.nodes.filter((n) => !fold.has(n.temporaryId)), edges }
}

/**
 * Drop edges pointing at unknown temp ids and self loops, then apply type-aware fixes for
 * the mistakes local models make most often (verified by tests/eval.ts).
 */
export function sanitize(input: Extraction, known: { label: string; type: string }[] = []): Extraction {
  const x = foldAttributeNodes(input, known)
  const type = new Map(x.nodes.map((n) => [n.temporaryId, n.type]))
  const edges = x.edges
    .filter((e) => type.has(e.sourceTemporaryId) && type.has(e.targetTemporaryId) && e.sourceTemporaryId !== e.targetTemporaryId)
    .map((e) => {
      const rel = e.relationship.trim().toUpperCase().replace(/[\s-]+/g, '_')
      const s = type.get(e.sourceTemporaryId)!, t = type.get(e.targetTemporaryId)!
      // Passive forms point the wrong way: "A BLOCKED_BY B" is B BLOCKS A.
      if (PASSIVE[rel]) {
        return { ...e, relationship: PASSIVE[rel], sourceTemporaryId: e.targetTemporaryId, targetTemporaryId: e.sourceTemporaryId }
      }
      // Models read hierarchies top-down; store them in REPORTS_TO direction (report -> manager).
      if (MANAGES.has(rel) && s === 'PERSON' && t === 'PERSON') {
        return { ...e, relationship: 'REPORTS_TO', sourceTemporaryId: e.targetTemporaryId, targetTemporaryId: e.sourceTemporaryId }
      }
      // Only people and teams own / are responsible for things; "X is owned by Team" often comes back reversed.
      if (OWNERSHIP.has(rel) && !OWNERS.has(s) && OWNERS.has(t)) {
        return { ...e, sourceTemporaryId: e.targetTemporaryId, targetTemporaryId: e.sourceTemporaryId }
      }
      // A person does not "report to" a team; they belong to it.
      if (rel === 'REPORTS_TO' && s === 'PERSON' && t === 'TEAM') return { ...e, relationship: 'PART_OF' }
      // Process step -> process step is sequence, not an API call.
      if (rel === 'CALLS' && STEP_TYPES.has(s) && STEP_TYPES.has(t)) return { ...e, relationship: 'PRECEDES' }
      // "X BLOCKS <blocker>" is backwards: the blocker blocks X.
      if (rel === 'BLOCKS' && t === 'BLOCKER' && s !== 'BLOCKER') {
        return { ...e, sourceTemporaryId: e.targetTemporaryId, targetTemporaryId: e.sourceTemporaryId }
      }
      return e
    })
  return { ...x, edges }
}

/**
 * Models copy the meeting date into "date" for items that never stated one. Keep a date only if it
 * literally appears in the source text (or differs from the meeting date).
 */
export function dropLeakedDates(x: Extraction, sourceText: string, meetingDate?: string): Extraction {
  return {
    ...x,
    nodes: x.nodes.map((n) => (n.date && ((meetingDate && n.date === meetingDate) || !sourceText.includes(n.date)) && n.type !== 'DECISION'
      ? { ...n, date: undefined } : n)),
  }
}

export async function analyzeText(text: string, context?: string, ctx: AnalysisContext = {}): Promise<AnalysisResult> {
  const model = (await runtime.textModel()) ?? 'unknown'
  const pre = [context, contextBlock(ctx, text)].filter(Boolean).join('\n\n')
  // Structured parts of minutes (action items, decisions, risks, status updates, reporting lines)
  // come from the deterministic parser; the model fills in relationships from the prose.
  const parsed = parseMinutes(text, ctx)
  let raw: Extraction
  try {
    raw = await structured(ExtractionSchema, EXTRACTION_JSON_SCHEMA, EXTRACT_SYSTEM,
      `${pre ? pre + '\n\n' : ''}Extract the knowledge graph from this text:\n"""\n${text.slice(0, 24000)}\n"""`)
  } catch (e) {
    // Degrade instead of failing the whole source: the parser's output still updates the map.
    if (!parsed.nodes.length) throw e
    console.warn('[ai] model extraction failed, using minutes parser only:', (e as Error).message)
    return { extraction: sanitize(combineWithModel({ summary: '', nodes: [], edges: [], ambiguities: ['Model extraction failed; structured items only.'] }, parsed), ctx.knownEntities), model: 'minutes parser (model failed)' }
  }
  const extraction = combineWithModel(dropLeakedDates(raw, text, ctx.meetingDate), parsed, text)
  return { extraction: sanitize(extraction, ctx.knownEntities), model: parsed.nodes.length ? `${model} + minutes parser` : model }
}

const ANNOTATION = /^\s*(blockers?|blocked|risks?|decisions?|decided|todo|to do|action(?: item)?s?|ai|done)\s*[:\-–]\s*(.{3,100}?)\s*$/i

function annotationKind(word: string): { type: 'BLOCKER' | 'DECISION' | 'TASK'; status?: 'OPEN' | 'DONE' } {
  const w = word.toLowerCase()
  if (w.startsWith('decid') || w.startsWith('decision')) return { type: 'DECISION' }
  if (w === 'done') return { type: 'TASK', status: 'DONE' }
  if (w.startsWith('todo') || w.startsWith('to do') || w.startsWith('action') || w === 'ai') return { type: 'TASK', status: 'OPEN' }
  return { type: 'BLOCKER', status: 'OPEN' }
}

/**
 * Explicitly labeled whiteboard notes ("BLOCKER: PCI audit not done") are high-signal and OCR reads
 * them reliably, but the vision model sometimes skips them. Add any the model missed.
 */
export function addOcrAnnotations(x: Extraction, ocrText: string): Extraction {
  const nodes = [...x.nodes]
  for (const line of ocrText.split('\n')) {
    const m = line.match(ANNOTATION)
    if (!m) continue
    const raw = m[2].replace(/[.;,]+$/, '')
    // "PCI audit not done" -> blocker "PCI audit" (subject without negation, so a later "done" can resolve it)
    const label = raw.replace(/\s+(not done|not complete[d]?|pending|incomplete|missing|outstanding|blocked)$/i, '') || raw
    if (nodes.some((n) => similarity(n.label, label) >= 0.6 || similarity(n.label, raw) >= 0.6)) continue
    const { type, status } = annotationKind(m[1])
    nodes.push({ temporaryId: `ocr_${nodes.length + 1}`, label, type, confidence: 0.6, description: `Whiteboard note: ${raw}`, status })
  }
  return nodes.length === x.nodes.length ? x : { ...x, nodes }
}

export interface AnalysisContext {
  meetingDate?: string
  /** Labels already in the workspace graph, so the model reuses them for updates. */
  knownEntities?: { label: string; type: string; status?: string }[]
}

/**
 * Only the known entities this input plausibly mentions. Sending the whole workspace makes the prompt
 * grow every meeting, and small models start re-listing everything until the output overflows.
 */
export function relevantKnown(known: AnalysisContext['knownEntities'] = [], input: string, max = 40) {
  if (!input.trim()) return known.slice(0, max)
  const words = new Set(normalize(input).split(' ').filter((w) => w.length > 2))
  return known
    .map((e) => ({ e, hits: normalize(e.label).split(' ').filter((w) => words.has(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max)
    .map((x) => x.e)
}

export function contextBlock(ctx: AnalysisContext = {}, input = '') {
  const parts: string[] = []
  if (ctx.meetingDate) parts.push(`Meeting date: ${ctx.meetingDate}.`)
  const known = relevantKnown(ctx.knownEntities, input)
  if (known.length) {
    const list = known.map((e) => `${e.label} (${e.type}${e.status ? ', ' + e.status : ''})`).join('; ')
    parts.push(`Known entities from earlier meetings. When the input refers to one, reuse its exact label. ` +
      `Do NOT output known entities the input does not mention: ${list}`)
  }
  return parts.join('\n')
}

export async function analyzeImage(image: Buffer, name: string, ctx: AnalysisContext = {}): Promise<AnalysisResult> {
  const [ocrText, visionModel] = await Promise.all([ocrImage(image), runtime.visionModel().catch(() => undefined)])
  const known = contextBlock(ctx, ocrText)
  const ocrBlock = (ocrText ? `\n\nOCR text detected in the image (may contain errors, use it to read labels):\n"""\n${ocrText.slice(0, 6000)}\n"""` : '') +
    (known ? `\n\n${known}` : '')

  if (visionModel) {
    let extraction: Extraction
    try {
      extraction = await structured(ExtractionSchema, EXTRACTION_JSON_SCHEMA, EXTRACT_SYSTEM,
      `This image ("${name}") is a whiteboard photo, architecture diagram or slide.
Read boxes, labels, arrows, connectors, grouping/containment, swimlanes, handwritten notes and their spatial relationships.
Arrows become edges in the arrow's direction: the box at the arrow's tail is the source, the box at the arrowhead is the target. Trace each line from its start to where the arrowhead touches; do not assume a line connects to the nearest or most central box.
Boxes inside a group become PART_OF the group.
Org charts (tree lines without arrowheads, manager on top): for every line from an upper PERSON box down to a lower PERSON box, emit relationship "MANAGES" with source = the UPPER person (manager) and target = the LOWER person. A TEAM box directly under a person means that person RESPONSIBLE_FOR the team. Do not use REPORTS_TO for org-chart tree lines.
Sprint / kanban boards: each sticky note is a TASK; its column gives the status (TODO/BACKLOG = OPEN, DOING/IN PROGRESS = IN_PROGRESS, DONE = DONE); a name or initials on the note is the owner (owner RESPONSIBLE_FOR task).
Free-floating annotations (colored notes, "BLOCKER:", "TODO:", "Owner:") are knowledge too: "BLOCKER: X" becomes a BLOCKER node X that BLOCKS the box it points at or sits nearest to; "Owner: T" becomes T OWNS the box it labels.
Identify systems, components, teams, people, processes, dependencies, ownership, blockers and milestones.${ocrBlock}`,
      { images: [image.toString('base64')], vision: true })
    } catch (e) {
      // Vision output unusable: fall through to the OCR path rather than failing the photo.
      if (!ocrText) throw e
      console.warn('[ai] vision extraction failed, falling back to OCR + text:', (e as Error).message)
      const res = await analyzeText(ocrText, `Text OCR-extracted from a whiteboard / sprint board photo named "${name}".`, ctx)
      return { ...res, extraction: sanitize(addOcrAnnotations(res.extraction, ocrText), ctx.knownEntities), model: `tesseract + ${res.model} (vision failed)`, ocrText }
    }
    const cleaned = dropLeakedDates(addOcrAnnotations(extraction, ocrText), ocrText, ctx.meetingDate)
    return { extraction: sanitize(cleaned, ctx.knownEntities), model: visionModel + (ocrText ? ' + tesseract' : ''), ocrText }
  }

  // Fallback: OCR + local text LLM. Layout is lost, so the model infers structure from text order.
  if (!ocrText) throw new Error('No local vision model available and OCR found no text in the image.')
  const res = await analyzeText(ocrText,
    `The following text was OCR-extracted from a diagram/whiteboard image named "${name}". Arrows may appear as "->", ">", "-->" or be lost. Infer likely structure, keep confidence moderate.`, ctx)
  return { ...res, model: `tesseract + ${res.model}`, ocrText }
}

export interface ReconcileCandidate {
  temporaryId: string
  label: string
  type: string
  description?: string
  candidates: { id: string; label: string; type: string; aliases: string[] }[]
}

/** Ask the local model to adjudicate fuzzy matches the deterministic matcher could not settle. */
export async function reconcileGraph(items: ReconcileCandidate[]): Promise<ReconcileResult> {
  if (!items.length) return { decisions: [] }
  return structured(ReconcileSchema, RECONCILE_JSON_SCHEMA,
    `You deduplicate knowledge-graph entities. For each new entity decide:
MATCH_EXISTING (it is the same real-world thing as one candidate; set existingNodeId),
CREATE_NEW (it is clearly different from all candidates),
UNCERTAIN (cannot tell). Abbreviations like "Auth API" vs "Authentication API" usually match. Different scope (e.g. "Payments Team" vs "Payments Service") does NOT match. Return ONLY JSON.`,
    JSON.stringify(items, null, 1))
}

export async function systemInfo() {
  const reachable = await runtime.reachable()
  return {
    provider: runtime.name,
    reachable,
    textModel: reachable ? await runtime.textModel().catch(() => undefined) : undefined,
    visionModel: reachable ? await runtime.visionModel().catch(() => undefined) : undefined,
  }
}
