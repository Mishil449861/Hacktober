// Handwritten meeting notes: who owns which task, due dates, statuses, follow-up meetings.
// Deterministic (no model calls): the notes parser, owner/date cleanup, merge into the graph, to-do view.
// The model-dependent path (photo -> vision model) is checked by `npm run test:handwritten`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The merge step stores to DATA_DIR and may ask the local model about fuzzy matches: point both
// somewhere harmless before the server modules load, so the tests never touch data/db.json or Ollama.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orgmap-test-'))
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9'
process.env.OCR_ENABLED = 'false'
const { parseMinutes, combineWithModel, dropStruck } = await import('../server/lib/minutes.ts')
const { addStatedDates, applyOwners, dropLeakedDates, sanitize } = await import('../server/lib/ai/provider.ts')
const { mergeExtraction } = await import('../server/graph/reconcile.ts')
const { buildViews } = await import('../server/views.ts')
const { store } = await import('../server/store.ts')
type Extraction = import('../src/shared/schema.ts').Extraction

const fixture = (f: string) => fs.readFileSync(`tests/fixtures/handwritten/${f}`, 'utf8')

/** What the parser makes of a note: one row per task, "label | owners | due | status". */
function tasks(text: string, meetingDate = '2026-10-10', knownEntities: { label: string; type: string }[] = []) {
  const p = parseMinutes(text, { meetingDate, knownEntities })
  const label = (id: string) => p.nodes.find((n) => n.temporaryId === id)?.label
  return p.nodes.filter((n) => n.type === 'TASK').map((t) => [
    t.label,
    p.edges.filter((e) => e.targetTemporaryId === t.temporaryId && e.relationship === 'RESPONSIBLE_FOR').map((e) => label(e.sourceTemporaryId)).join(','),
    t.date ?? '',
    t.status ?? '',
  ].join(' | '))
}
const ofType = (text: string, type: string, meetingDate = '2026-10-10') =>
  parseMinutes(text, { meetingDate }).nodes.filter((n) => n.type === type).map((n) => `${n.label}${n.status ? ` [${n.status}]` : ''}`)

// ---------------------------------------------------------------- ownership

test('1. explicit assignment: "Name → task → date" keeps each task with its own person', () => {
  assert.deepEqual(tasks('Maya → Design homepage → Oct 14\nLinh → Build API → Oct 16\nAlex → Research competitors → Oct 18'), [
    'Design homepage | Maya | 2026-10-14 | OPEN',
    'Build API | Linh | 2026-10-16 | OPEN',
    'Research competitors | Alex | 2026-10-18 | OPEN',
  ])
  // Same without dates, and with OCR-style ASCII arrows.
  assert.deepEqual(tasks('Maya -> Design homepage\nLinh --> Build API\nAlex => Research competitors'), [
    'Design homepage | Maya |  | OPEN', 'Build API | Linh |  | OPEN', 'Research competitors | Alex |  | OPEN',
  ])
})

test('2. name heading: every item listed under a name belongs to that name, until the next name', () => {
  const expected = ['Design homepage | Maya |  | OPEN', 'Create logo | Maya |  | OPEN', 'Build API | Linh |  | OPEN']
  assert.deepEqual(tasks('Maya\n- Design homepage\n- Create logo\n\nLinh\n- Build API'), expected, 'bare name over bullets')
  assert.deepEqual(tasks('Maya:\nDesign homepage\nCreate logo\nLinh:\nBuild API'), expected, '"Name:" over unbulleted lines')
  assert.deepEqual(tasks('MAYA\n- Design homepage\n- Create logo\n\nLINH\n- Build API'), expected, 'names in block capitals')
  // "Maya → Design" over a list: Design is her area, the items are her tasks, the DUE line is theirs.
  assert.deepEqual(tasks('Maya → Design\n- wireframes\n- homepage\nDUE: Oct 14\n\nLinh → Backend\n- set up API\nDUE: Oct 16'), [
    'Wireframes | Maya | 2026-10-14 | OPEN', 'Homepage | Maya | 2026-10-14 | OPEN', 'Set up API | Linh | 2026-10-16 | OPEN',
  ])
  const p = parseMinutes('Maya → Design\n- wireframes', {})
  assert.equal(p.nodes.find((n) => n.label === 'Maya')?.description, 'Design')
  assert.equal(p.nodes.some((n) => n.label === 'Design'), false, 'the area is not a task or a person')
})

test('2b. a "DUE" line belongs to its own group, not to the next person', () => {
  assert.deepEqual(tasks('Maya\n- Design homepage\n- Create logo\nDUE: Oct 14\n\nLinh\n- Build API\nDUE Oct 16'), [
    'Design homepage | Maya | 2026-10-14 | OPEN', 'Create logo | Maya | 2026-10-14 | OPEN', 'Build API | Linh | 2026-10-16 | OPEN',
  ])
  // Weekday due dates, with and without a colon, resolved against the meeting date (Sat 2026-10-10).
  assert.deepEqual(tasks('Maya\nlanding page\nDUE Friday\n\nLinh\nAPI integration\nDUE: Mon'), [
    'Landing page | Maya | 2026-10-16 | OPEN', 'API integration | Linh | 2026-10-12 | OPEN',
  ])
})

test('3. missing owner: a task with no name stays unassigned (no guess, no crash)', () => {
  assert.deepEqual(tasks('Fix login\nDUE Oct 20'), ['Fix login |  | 2026-10-20 | OPEN'])
  assert.deepEqual(tasks('Fix login, due Oct 20'), ['Fix login |  | 2026-10-20 | OPEN'])
  // A name elsewhere in the notes does not adopt it.
  assert.deepEqual(tasks('Maya → Design homepage\n\n\nFix login\nDUE Oct 20'), [
    'Design homepage | Maya |  | OPEN', 'Fix login |  | 2026-10-20 | OPEN',
  ])
})

test('status written after an arrow on the item line: "privacy policy → started"', () => {
  assert.deepEqual(tasks('Maya:\n✓ landing page DONE\nprivacy policy → started\nDUE Oct 21'), [
    'Landing page | Maya |  | DONE', 'Privacy policy | Maya | 2026-10-21 | IN_PROGRESS',
  ])
})

test('a vision transcript without blank lines: bulleted items under bare names, an unbulleted item after them', () => {
  // Verbatim from qwen2.5vl:7b reading tests/fixtures/handwritten/01-sync-photo.png (crossed-out line removed).
  const transcript = 'weekly sync Oct 6\nMaya\n- landing page\n- logo\nDUE Fri\nLinh → API integration\nDUE Mon\nAlex\n- competitor research\nDUE Wed\nFix login\nDUE Oct 20\nBLOCKER: waiting on API key'
  assert.deepEqual(tasks(transcript, '2026-10-06'), [
    'Landing page | Maya | 2026-10-09 | OPEN',
    'Logo | Maya | 2026-10-09 | OPEN',
    'API integration | Linh | 2026-10-12 | OPEN',
    'Competitor research | Alex | 2026-10-07 | OPEN',
    'Fix login |  | 2026-10-20 | OPEN',
  ])
})

test('4. missing due date: a valid task with no date', () => {
  assert.deepEqual(tasks('Maya\n- Fix login'), ['Fix login | Maya |  | OPEN'])
  assert.equal(parseMinutes('Maya\n- Fix login', {}).nodes.find((n) => n.type === 'TASK')?.date, undefined)
})

test('5. mixed meeting: 3 people, dates, an unassigned task, a done task, a blocker, a decision', () => {
  const note = [
    'SPRINT SYNC',
    '',
    'Maya:',
    '- landing page',
    '- ✓ logo DONE',
    'DUE: Oct 14',
    '',
    'Linh → Build API → Oct 16',
    '',
    'Alex',
    '- competitor research',
    '- pricing page (Linh)',
    'DUE Fri',
    '',
    '',
    'Fix login',
    'DUE Oct 20',
    '',
    'BLOCKER:',
    'waiting on API key',
    '',
    'DECISION:',
    'Launch stays Oct 31',
  ].join('\n')
  assert.deepEqual(tasks(note), [
    'Landing page | Maya | 2026-10-14 | OPEN',
    'Logo | Maya |  | DONE',
    'Build API | Linh | 2026-10-16 | OPEN',
    'Competitor research | Alex | 2026-10-16 | OPEN',
    'Pricing page | Linh | 2026-10-16 | OPEN',
    'Fix login |  | 2026-10-20 | OPEN',
  ])
  assert.deepEqual(ofType(note, 'BLOCKER'), ['API key [OPEN]'])
  assert.deepEqual(ofType(note, 'DECISION'), ['Launch stays Oct 31'])
  assert.deepEqual(ofType(note, 'PERSON').sort(), ['Alex', 'Linh', 'Maya'])
})

test('real notes, kickoff: owners, group due dates, decision and blocker', () => {
  const note = fixture('01-kickoff.txt')
  assert.deepEqual(tasks(note, '2026-10-07'), [
    'Wireframes | Maya | 2026-10-14 | OPEN',
    'Homepage | Maya | 2026-10-14 | OPEN',
    'Set up API | Linh | 2026-10-16 | OPEN',
    'Connect DB | Linh | 2026-10-16 | OPEN',
    'Look at 5 competitors | Alex | 2026-10-13 | OPEN',
  ])
  assert.deepEqual(ofType(note, 'DECISION'), ['React + Node'])
  assert.deepEqual(ofType(note, 'BLOCKER'), ['API credentials [OPEN]'])
  assert.deepEqual(ofType(note, 'PROJECT'), ['CampusConnect'])
  assert.equal(ofType(note, 'MILESTONE').length, 0, '"NEXT MEETING: Oct 17" is not a deliverable')
})

test('real notes, weekly sync: ✓ / DONE / "→ started" / "~ halfway", NEW items, ALL → date', () => {
  const note = fixture('02-weekly-sync.txt')
  assert.deepEqual(tasks(note), [
    'Landing page | Maya |  | DONE',
    'Logo | Maya |  | DONE',
    'Privacy policy | Maya | 2026-10-21 | IN_PROGRESS',
    'API integration | Linh |  | DONE',
    'DB testing | Linh | 2026-10-22 | IN_PROGRESS',
    'Competitor research | Alex |  | DONE',
    'Pricing research | Alex | 2026-10-23 | OPEN',
    'Final QA before demo |  | 2026-10-23 | OPEN',
    'Polish UI | Maya | 2026-10-22 | OPEN',
    'Fix test account | Linh | 2026-10-20 | OPEN',
  ])
  assert.deepEqual(ofType(note, 'BLOCKER'), ['API key issue [RESOLVED]', 'DB test account [OPEN]'])
  assert.deepEqual(ofType(note, 'DECISION'), ['Demo stays Oct 24'])
  const p = parseMinutes(note, { meetingDate: '2026-10-10' })
  assert.equal(p.nodes.find((n) => n.label === 'Competitor research')?.description, '5 competitors added', 'an outcome line is not a new task')
  assert.equal(p.nodes.some((n) => n.type === 'PERSON' && /^(all|new|need)$/i.test(n.label)), false)
})

test('the desired outcome: names over items, DUE weekdays, a blocker', () => {
  const note = 'WEEKLY SYNC\n\nMaya\nlanding page\nDUE Friday\n\nLinh\nAPI integration\nDUE Monday\n\nAlex\ncompetitor research\nDUE Wednesday\n\nBLOCKER:\nwaiting on API key'
  assert.deepEqual(tasks(note), [
    'Landing page | Maya | 2026-10-16 | OPEN', 'API integration | Linh | 2026-10-12 | OPEN', 'Competitor research | Alex | 2026-10-14 | OPEN',
  ])
  assert.deepEqual(ofType(note, 'BLOCKER'), ['API key [OPEN]'])
  assert.deepEqual(ofType(note, 'PERSON'), ['Maya', 'Linh', 'Alex'])
})

test('not people: process-flow arrows, a sticky-note name under its task, crossed-out items, section words', () => {
  const flow = 'Order Received -> Fraud Check\nFraud Check -> Payment Capture\nPayment Capture -> Ledger Posting'
  assert.deepEqual(parseMinutes(flow, {}).nodes, [], 'a diagram is not a list of assignments')
  assert.deepEqual(parseMinutes('Checkout → Payments → Ledger', {}).nodes, [], 'a chain of arrows is a flow')
  // OCR of a sticky note: the name sits under the task, then the next note follows.
  const sticky = 'Renew fraud vendor contract\nSarah\nWrite Checkout launch runbook\nPriya'
  assert.deepEqual(tasks(sticky), [], 'no owner block is guessed from a name between two notes')
  assert.deepEqual(tasks('Maya:\n- landing page\n~~- old logo~~\n- privacy policy'), ['Landing page | Maya |  | OPEN', 'Privacy policy | Maya |  | OPEN'])
  assert.equal(ofType('Design\n- wireframes', 'PERSON').length, 0, '"Design" is an area, not a person')
  // A known system is never an owner, whatever the arrow says.
  assert.deepEqual(parseMinutes('Checkout → retry logic', { knownEntities: [{ label: 'Checkout', type: 'SYSTEM' }] }).nodes, [])
})

// ---------------------------------------------------------------- model output cleanup

const model = (nodes: Extraction['nodes'], edges: Extraction['edges'] = []): Extraction => ({ summary: '', ambiguities: [], nodes, edges })

test('dates the model resolves from "Oct 14" / "DUE Fri" are kept; the meeting date leaking in is not', () => {
  const x = dropLeakedDates(model([
    { temporaryId: 't1', label: 'Wireframes', type: 'TASK', confidence: 1, date: '2026-10-14' },
    { temporaryId: 't2', label: 'Landing page', type: 'TASK', confidence: 1, date: '2026-10-16' },
    { temporaryId: 't3', label: 'Logo', type: 'TASK', confidence: 1, date: '2026-10-10' },
    { temporaryId: 't4', label: 'Invented', type: 'TASK', confidence: 1, date: '2026-12-01' },
  ]), 'Maya\n- wireframes\nDUE: Oct 14\nlanding page\nDUE Fri\nlogo', '2026-10-10')
  assert.deepEqual(x.nodes.map((n) => n.date), ['2026-10-14', '2026-10-16', undefined, undefined])
})

test('a due date on the meeting day is kept when the text says so, and filled in when the model left it out', () => {
  const text = '- New member on the team (Jim) tasked with UI design due on Oct 24, 2026\n- Ham: run live demo tests due next thursday'
  const x = addStatedDates(dropLeakedDates(model([
    { temporaryId: 't1', label: 'UI design', type: 'TASK', confidence: 1, date: '2026-10-24' },
    { temporaryId: 't2', label: 'Run live demo tests', type: 'TASK', confidence: 1 },
    { temporaryId: 't3', label: 'Write the agenda', type: 'TASK', confidence: 1 },
  ]), text, '2026-10-24'), text, '2026-10-24')
  assert.deepEqual(x.nodes.map((n) => n.date), ['2026-10-24', '2026-10-29', undefined])
  assert.equal(addStatedDates(model([{ temporaryId: 't1', label: 'UI design', type: 'TASK', confidence: 1 }]), text, '2026-10-24').nodes[0].date, '2026-10-24')
})

test('owner field: becomes the ownership edge, overrides a conflicting guessed edge, never invents a person', () => {
  const x = applyOwners(model([
    { temporaryId: 'p1', label: 'Linh', type: 'PERSON', confidence: 1 },
    { temporaryId: 't1', label: 'Competitor research', type: 'TASK', confidence: 1, owner: 'Alex' },
    { temporaryId: 't2', label: 'Fix login', type: 'TASK', confidence: 1, owner: null },
    { temporaryId: 't3', label: 'Final QA', type: 'TASK', confidence: 1, owner: 'ALL' },
    { temporaryId: 't4', label: 'Polish UI', type: 'TASK', confidence: 1, owner: 'Jordan' },
  ], [{ sourceTemporaryId: 'p1', targetTemporaryId: 't1', relationship: 'RESPONSIBLE_FOR', confidence: 0.7 }]),
  'Alex: competitor research\nLinh\nFix login\nALL → final QA\npolish UI')
  const label = (id: string) => x.nodes.find((n) => n.temporaryId === id)?.label
  assert.deepEqual(x.edges.map((e) => `${label(e.sourceTemporaryId)} -${e.relationship}-> ${label(e.targetTemporaryId)}`), [
    'Alex -RESPONSIBLE_FOR-> Competitor research',
  ])
  assert.ok(x.ambiguities.some((a) => a.includes('Jordan')), 'an owner who is not in the notes is reported, not assigned')
  assert.equal(x.nodes.some((n) => 'owner' in n), false, 'ownership lives in the graph only')
})

test('owner field given as the person node\'s temporaryId ("n2") is that person', () => {
  const x = applyOwners(model([
    { temporaryId: 'n2', label: 'Maya', type: 'PERSON', confidence: 1 },
    { temporaryId: 'n3', label: 'landing page', type: 'TASK', confidence: 1, owner: 'n2' },
    { temporaryId: 'n4', label: 'logo', type: 'TASK', confidence: 1, owner: 'n9' },
  ]), 'Maya\n- landing page\n- logo')
  assert.deepEqual(x.edges.map((e) => `${e.sourceTemporaryId} -${e.relationship}-> ${e.targetTemporaryId}`), ['n2 -RESPONSIBLE_FOR-> n3'])
  assert.deepEqual(x.ambiguities, ['"logo": owner "n9" is not in the notes, left unassigned.'], 'an id that is no person stays unassigned')
})

test('sanitize: "Maya → Design" read as REPORTS_TO is not a reporting line', () => {
  const x = sanitize(model([
    { temporaryId: 'm', label: 'Maya', type: 'PERSON', confidence: 1 },
    { temporaryId: 'd', label: 'Design', type: 'PROCESS', confidence: 1 },
    { temporaryId: 't', label: 'Landing page', type: 'TASK', confidence: 1 },
  ], [
    { sourceTemporaryId: 'm', targetTemporaryId: 'd', relationship: 'REPORTS_TO', confidence: 1 },
    { sourceTemporaryId: 'm', targetTemporaryId: 't', relationship: 'REPORTS_TO', confidence: 1 },
  ]))
  assert.deepEqual(x.edges.map((e) => e.relationship), ['PART_OF', 'RESPONSIBLE_FOR'])
})

test('a section heading the parser cannot read does not erase what the model found there', () => {
  const text = '## Decisions\nWe talked about the stack for a while and settled on React.'
  const x = combineWithModel(model([{ temporaryId: 'd', label: 'Use React', type: 'DECISION', confidence: 0.9 }]), parseMinutes(text, {}), text)
  assert.deepEqual(x.nodes.map((n) => n.label), ['Use React'])
})

// ---------------------------------------------------------------- graph + to-do view, across meetings

let n = 0
/** One meeting through the deterministic path: notes parser -> cleanup -> merge -> views. */
async function meeting(ws: string, text: string, date: string) {
  const knownEntities = store.db.nodes.filter((x) => x.workspaceId === ws).map((x) => ({ label: x.label, type: x.type, status: x.status }))
  const parsed = parseMinutes(text, { meetingDate: date, knownEntities })
  const extraction = sanitize(combineWithModel(model([]), parsed, text), knownEntities)
  const id = `src${++n}`
  store.db.sources.push({ id, workspaceId: ws, type: 'TEXT', name: `Meeting ${date}`, status: 'DONE', meetingDate: date, text, createdAt: `${date}T10:00:00Z` })
  await mergeExtraction(ws, id, extraction, date)
  return buildViews(store.state(ws)!, '2026-10-12')
}
const row = (a: { label: string; owners: string[]; due: string | null; status: string }) => `${a.label} | ${a.owners.join(',')} | ${a.due ?? ''} | ${a.status}`

test('6. follow-up meeting updates existing tasks (no duplicates), keeps owners, adds the new task', async () => {
  const ws = store.createWorkspace('follow-up').id
  await meeting(ws, 'Maya → landing page → TODO\nLinh → API → TODO', '2026-10-01')
  const v = await meeting(ws, 'Maya → landing page → DONE\nLinh → API → DONE\nMaya → privacy policy → TODO', '2026-10-08')
  assert.deepEqual(v.actionItems.map(row).sort(), [
    'API | Linh |  | DONE', 'Landing page | Maya |  | DONE', 'Privacy policy | Maya |  | OPEN',
  ])
  assert.equal(v.kpis.people, 2)
  const latest = v.changes.at(-1)!
  assert.deepEqual(latest.statusChanges.map((c) => `${c.label}: ${c.from} -> ${c.to}`).sort(), ['API: OPEN -> DONE', 'Landing page: OPEN -> DONE'])
})

test('6b. handwritten follow-up: "✓ landing page DONE" ticks off the task, "DB testing / DUE" goes to Linh', async () => {
  const ws = store.createWorkspace('handwritten follow-up').id
  await meeting(ws, 'Maya\n- landing page\n- logo\nDUE Oct 9\n\nLinh\n- API integration', '2026-10-01')
  const v = await meeting(ws, 'Maya:\n✓ landing page DONE\n\nLinh:\nDB testing\nDUE Oct 22', '2026-10-08')
  assert.deepEqual(v.actionItems.map(row).sort(), [
    'API integration | Linh |  | OPEN',
    'DB testing | Linh | 2026-10-22 | OPEN',
    'Landing page | Maya | 2026-10-09 | DONE',
    'Logo | Maya | 2026-10-09 | OPEN',
  ])
  assert.equal(v.actionItems.filter((a) => /landing page/i.test(a.label)).length, 1, 'no "Landing page DONE" duplicate')
})

test('6c. the two real meetings in sequence: kickoff then weekly sync', async () => {
  const ws = store.createWorkspace('real').id
  await meeting(ws, fixture('01-kickoff.txt'), '2026-10-07')
  const v = await meeting(ws, fixture('02-weekly-sync.txt'), '2026-10-10')
  const byLabel = (l: string) => v.actionItems.find((a) => a.label === l)
  assert.deepEqual(byLabel('Competitor research')?.owners, ['Alex'], 'not Linh (the bug seen in data/db.json)')
  assert.deepEqual(byLabel('DB testing')?.owners, ['Linh'])
  assert.equal(byLabel('Wireframes')?.due, '2026-10-14', 'kickoff due dates survive into the to-do list')
  assert.equal(v.actionItems.filter((a) => a.owners.length === 0).map((a) => a.label).join(), 'Final QA before demo')
  for (const a of v.actionItems) assert.ok(a.label && Array.isArray(a.owners) && 'due' in a && a.status, `${a.label} has the full shape`)
})


// ---------------------------------------------------------------- crossed-out items

test('7a. crossed-out items are never to-dos: ~~text~~, with or without a bullet', () => {
  const expected = ['Landing page | Maya |  | OPEN', 'Logo | Maya |  | OPEN']
  assert.deepEqual(tasks('Maya\n- landing page\n- ~~banner ads~~\n- logo'), expected, 'bulleted (what the vision prompt asks for)')
  assert.deepEqual(tasks('Maya\n- landing page\n~~banner ads~~\n- logo'), expected, 'bare')
  assert.deepEqual(parseMinutes('Maya\n- landing page\n- ~~banner ads~~').struck, ['banner ads'])
})

test('7b. in a photo, a long dash glued to the word is the strike line; typed notes keep their dashes', () => {
  // What qwen2.5vl (transcript) and tesseract (OCR) actually produced for "- banner ads" struck through.
  const transcript = 'Maya\n- landing page\n- logo\n—banner ads\nDUE Fri'
  const photo = parseMinutes(transcript, { meetingDate: '2026-10-06', photo: true })
  assert.deepEqual(photo.nodes.filter((n) => n.type === 'TASK').map((n) => n.label), ['Landing page', 'Logo'])
  assert.deepEqual(photo.struck, ['banner ads'])
  assert.deepEqual(parseMinutes('Maya\n- logo\n—bommer—s', { photo: true }).struck, ['bommer—s'], 'garbled OCR of the same line')
  assert.deepEqual(parseMinutes('Maya\n— logo\n– landing page', { photo: true }).struck, [], 'a dash and a space is a bullet, not a strike')
  assert.deepEqual(parseMinutes(transcript, { meetingDate: '2026-10-06' }).struck, [], 'typed notes: the rule is off')
})

test('7c. an item crossed out in one reading is dropped from the other reading and from the model', () => {
  // OCR missed the strike-through and reads a plain item; the transcript marked it.
  const ocr = parseMinutes('Maya\n- landing page\n- banner ads', { photo: true })
  assert.ok(ocr.nodes.some((n) => n.label === 'Banner ads'), 'precondition: OCR alone keeps it')
  const cleaned = dropStruck(ocr, ['banner ads'])
  assert.deepEqual(cleaned.nodes.filter((n) => n.type === 'TASK').map((n) => n.label), ['Landing page'])
  assert.ok(cleaned.edges.every((e) => cleaned.nodes.some((n) => n.temporaryId === e.targetTemporaryId)), 'its owner edge goes too')
  assert.ok(cleaned.nodes.some((n) => n.label === 'Maya'), 'the person stays')

  // The model read it as a task even though the notes parser found no other to-do to replace its tasks with.
  const parsed = parseMinutes('- ~~banner ads~~', { photo: true })
  const model: Extraction = {
    summary: '', ambiguities: [],
    nodes: [
      { temporaryId: 'm', label: 'Maya', type: 'PERSON', confidence: 1 },
      { temporaryId: 'b', label: 'Banner ads', type: 'TASK', confidence: 1 },
      { temporaryId: 'w', label: 'Website', type: 'SYSTEM', confidence: 1 },
    ],
    edges: [{ sourceTemporaryId: 'm', targetTemporaryId: 'b', relationship: 'RESPONSIBLE_FOR', confidence: 1 }],
  }
  const x = combineWithModel(model, parsed)
  assert.deepEqual(x.nodes.map((n) => n.label).sort(), ['Maya', 'Website'])
  assert.deepEqual(x.edges, [], 'the edge to the dropped task goes too')
})

test('7d. crossing off a to-do the board already has ticks it off (the same photo uploaded again, updated)', () => {
  // The hackathon board: IMG_5705.JPG read first, then a new photo of the same page with items crossed off.
  const known = [
    { label: 'Linh', type: 'PERSON' }, { label: 'Jen', type: 'PERSON' },
    { label: 'Test database', type: 'TASK', status: 'OPEN', owners: ['Linh'] },
    { label: 'Product research', type: 'TASK', status: 'OPEN', owners: ['Jen'] },
    { label: 'Find 2 similar products', type: 'TASK', status: 'OPEN', owners: ['Jen'] },
    { label: 'Payment API outage', type: 'BLOCKER', status: 'OPEN' },
  ]
  const update = 'Linh:\n- ~~Test database~~\n\nJen:\n✓ Product research\n- Find 2 similar products\n- Write pitch\n—Payment API outage'
  assert.deepEqual(tasks(update, '2026-10-27', known), [
    'Test database | Linh |  | DONE',
    'Product research | Jen |  | DONE',
    'Find 2 similar products | Jen |  | ',
    'Write pitch | Jen |  | OPEN',
  ])
  const photo = parseMinutes(update, { meetingDate: '2026-10-27', knownEntities: known, photo: true })
  assert.equal(photo.nodes.find((n) => n.label === 'Payment API outage')?.status, 'RESOLVED', 'a crossed-off known blocker is resolved')
  assert.deepEqual(photo.struck, [], 'nothing on the board was cancelled')

  // Still cancelled: crossed out but not on the board.
  assert.deepEqual(parseMinutes('Jen:\n- ~~banner ads~~', { knownEntities: known }).struck, ['banner ads'])
  assert.deepEqual(tasks('Jen:\n- ~~banner ads~~', '2026-10-27', known), [])

  // The other reading saw the strike as garbled text: the to-do stays ticked off, not dropped.
  const cleaned = dropStruck(photo, ['Test dotabase'])
  assert.equal(cleaned.nodes.find((n) => n.label === 'Test database')?.status, 'DONE')
})

test('7e. a bare line over "- due: Friday" is a to-do, not a person; "NOTE: … meeting on Sunday" is a dated event', () => {
  // The vision transcript of IMG_5705.JPG (2026-10-26, a Monday). "API Setup" used to become a person owning
  // "NOTE: Full team meeting on 2026-11-01" as a to-do, and the Friday due date was lost.
  const transcript = 'Hackathon Project\nLinh (frontend)\nJen (product)\nSophia (research)\nMishil (backend)\nShriya (design)\n\n' +
    'Linh:\n- Test database\n\nJen:\n- Product research\n- Find 2 similar products\n\nAPI Setup\n- due: Friday\n\nNOTE: Full team meeting on Sunday\n'
  const p = parseMinutes(transcript, { meetingDate: '2026-10-26', photo: true })
  assert.deepEqual(tasks(transcript, '2026-10-26'), [
    'Test database | Linh |  | OPEN',
    'Product research | Jen |  | OPEN',
    'Find 2 similar products | Jen |  | OPEN',
    'API Setup |  | 2026-10-30 | OPEN',
  ])
  assert.ok(!p.nodes.some((n) => n.type === 'PERSON' && n.label === 'API Setup'))
  assert.deepEqual(ofType(transcript, 'MILESTONE', '2026-10-26'), ['Full team meeting [OPEN]'])
  assert.equal(p.nodes.find((n) => n.type === 'MILESTONE')?.date, '2026-11-01')
  // The roster, unbulleted: members with roles.
  assert.deepEqual(p.nodes.filter((n) => n.type === 'PERSON').map((n) => `${n.label} (${n.description})`),
    ['Linh (frontend)', 'Jen (product)', 'Sophia (research)', 'Mishil (backend)', 'Shriya (design)'])

  // Still a person: a bare name over items with no due line.
  assert.deepEqual(tasks('Maya\n- landing page\n- logo'), ['Landing page | Maya |  | OPEN', 'Logo | Maya |  | OPEN'])
  // Still to-dos: a meeting someone has to arrange.
  assert.deepEqual(tasks('- Ben will book the team meeting on Friday', '2026-10-26'), ['Book the team meeting on 2026-10-30 | Ben |  | OPEN'])
  assert.deepEqual(tasks('Ben: schedule the team meeting by Friday', '2026-10-26'), ['Schedule the team meeting | Ben | 2026-10-30 | OPEN'])
  assert.deepEqual(ofType('Ben will book the team meeting on Friday', 'MILESTONE', '2026-10-26'), [])
  // The notes' own title ("weekly sync Oct 6" on Oct 6) is not an upcoming event.
  assert.deepEqual(ofType('weekly sync Oct 6\nMaya\n- logo', 'MILESTONE', '2026-10-06'), [])
})

test('7f. a hyphenated word is not "Name - task": "Load-test …" is not Load\'s to-do', () => {
  // The sprint-board transcript: this one line used to be the only to-do read, replacing the model's five.
  assert.deepEqual(tasks('- Load-test Auth Service with Redis Cache (Tom)\n- Follow-up with the vendor'), [])
  assert.deepEqual(tasks('- Ben - book the venue\n- Ana: print badges'), ['Book the venue | Ben |  | OPEN', 'Print badges | Ana |  | OPEN'])
})