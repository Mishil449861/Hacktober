// Deterministic tests for the minutes parser, run against the real demo minutes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { combineWithModel, normalizeDates, parseMinutes, type KnownEntity } from '../server/lib/minutes.ts'

const read = (f: string) => fs.readFileSync(`tests/fixtures/scenarios/payments-migration/${f}`, 'utf8')
const labels = (p: ReturnType<typeof parseMinutes>, type: string) => p.nodes.filter((n) => n.type === type)
const edge = (p: ReturnType<typeof parseMinutes>, from: string, rel: string, to: string) => p.edges.some((e) =>
  e.relationship === rel &&
  p.nodes.find((n) => n.temporaryId === e.sourceTemporaryId)?.label === from &&
  p.nodes.find((n) => n.temporaryId === e.targetTemporaryId)?.label === to)

test('kickoff: actions with owners + due dates, decision, milestones, reporting lines, attendees', () => {
  const p = parseMinutes(read('01-kickoff.md'), { meetingDate: '2026-09-08' })
  const tasks = labels(p, 'TASK')
  assert.deepEqual(tasks.map((t) => [t.label, t.date, t.status]), [
    ['Draft the target architecture for the API Gateway', '2026-09-12', 'OPEN'],
    ['Inventory the legacy Ledger integrations', '2026-09-19', 'OPEN'],
    ['Confirm the migration budget with Finance', '2026-09-15', 'OPEN'],
  ])
  assert.ok(edge(p, 'Raj Patel', 'RESPONSIBLE_FOR', 'Draft the target architecture for the API Gateway'))
  assert.deepEqual(labels(p, 'DECISION').map((d) => d.label), ['Migrate service by service'])
  assert.deepEqual(labels(p, 'MILESTONE').map((m) => [m.label, m.date]), [['Checkout launch', '2026-10-31'], ['Dual-run cutover', '2026-12-15']])
  assert.ok(edge(p, 'Sarah Chen', 'REPORTS_TO', 'Maria Lopez'))
  assert.ok(edge(p, 'Raj Patel', 'REPORTS_TO', 'Sarah Chen'))
  assert.ok(edge(p, 'Ana Silva', 'REPORTS_TO', 'Sarah Chen'))
  assert.ok(edge(p, 'Raj Patel', 'RESPONSIBLE_FOR', 'Platform Team'))
  assert.equal(p.nodes.find((n) => n.label === 'Maria Lopez')?.description, 'CTO')
  assert.ok(p.hasReporting)
})

const afterKickoff: KnownEntity[] = [
  { label: 'Draft the target architecture for the API Gateway', type: 'TASK', status: 'OPEN' },
  { label: 'Inventory the legacy Ledger integrations', type: 'TASK', status: 'OPEN' },
  { label: 'Confirm the migration budget with Finance', type: 'TASK', status: 'OPEN' },
  { label: 'Checkout launch', type: 'MILESTONE', status: 'OPEN' },
  { label: 'Dual-run cutover', type: 'MILESTONE', status: 'OPEN' },
  { label: 'Payments Service', type: 'SYSTEM' },
  { label: 'API Gateway', type: 'SYSTEM' },
]

test('architecture review: closes Raj\'s task, raises PCI blocker with targets, budget in progress', () => {
  const p = parseMinutes(read('02-architecture-review.md'), { meetingDate: '2026-09-15', knownEntities: afterKickoff })
  const byLabel = (l: string) => p.nodes.find((n) => n.label === l)
  assert.equal(byLabel('Draft the target architecture for the API Gateway')?.status, 'DONE')
  assert.equal(byLabel('Confirm the migration budget with Finance')?.status, 'IN_PROGRESS')
  const pci = byLabel('PCI audit')!
  assert.equal(pci.type, 'BLOCKER')
  assert.equal(pci.status, 'OPEN', '"has not been done" must not count as done')
  assert.ok(edge(p, 'PCI audit', 'BLOCKS', 'Payments Service'))
  assert.ok(edge(p, 'PCI audit', 'BLOCKS', 'Checkout launch'))
  assert.deepEqual(labels(p, 'TASK').filter((t) => t.date).map((t) => [t.label, t.date]), [['Schedule the PCI audit with the external assessor', '2026-09-26']])
  assert.ok(edge(p, 'Mei Wong', 'RESPONSIBLE_FOR', 'Security Team'))
})

test('steering committee: resolves blocker, closes tasks, slips milestone, new risk + reporting line', () => {
  const known: KnownEntity[] = [...afterKickoff,
    { label: 'PCI audit', type: 'BLOCKER', status: 'OPEN' },
    { label: 'Fraud Check', type: 'PROCESS' },
  ]
  const p = parseMinutes(read('04-steering-committee.md'), { meetingDate: '2026-09-29', knownEntities: known })
  const byLabel = (l: string) => p.nodes.find((n) => n.label === l)
  assert.equal(byLabel('PCI audit')?.status, 'RESOLVED')
  assert.equal(byLabel('Confirm the migration budget with Finance')?.status, 'DONE')
  assert.equal(byLabel('Inventory the legacy Ledger integrations')?.status, 'DONE')
  assert.equal(byLabel('Checkout launch')?.date, '2026-11-15')
  const fraud = byLabel('Fraud vendor contract')!
  assert.equal(fraud.type, 'BLOCKER')
  assert.equal(fraud.status, 'OPEN', '"not renewed yet" is still open')
  assert.ok(edge(p, 'Fraud vendor contract', 'BLOCKS', 'Fraud Check'))
  assert.ok(edge(p, 'Priya Shah', 'REPORTS_TO', 'Ana Silva'))
  assert.ok(edge(p, 'Priya Shah', 'PART_OF', 'Payments Team'))
  assert.deepEqual(labels(p, 'TASK').filter((t) => t.date).map((t) => [t.label, t.date]), [
    ['Renew the fraud vendor contract', '2026-10-10'], ['Write the Checkout launch runbook', '2026-11-01'],
  ])
  assert.equal(labels(p, 'DECISION').length, 1)
})

test('free-form notes without headings: owner + due date bullets and TODO lines are action items', () => {
  const p = parseMinutes([
    'Dana Kim owns the Q4 Launch project.',
    '- Dana Kim: book the launch venue (due 2026-10-20)',
    'TODO: Leo Marsh: draft the press release',
    '- Dana Kim: presented the venue shortlist',
    '- Decision: launch in Berlin.',
    'Leo Marsh reports to Dana Kim.',
  ].join('\n'), { meetingDate: '2026-10-04' })
  assert.deepEqual(labels(p, 'TASK').map((t) => [t.label, t.date, t.status]), [
    ['Book the launch venue', '2026-10-20', 'OPEN'],
    ['Draft the press release', undefined, 'OPEN'],
  ], 'a bullet with an owner but no due date and no TODO prefix is not assumed to be a task')
  assert.ok(edge(p, 'Dana Kim', 'RESPONSIBLE_FOR', 'Book the launch venue'))
  assert.ok(edge(p, 'Leo Marsh', 'RESPONSIBLE_FOR', 'Draft the press release'))
  assert.ok(edge(p, 'Dana Kim', 'OWNS', 'Q4 Launch'))
  assert.ok(edge(p, 'Leo Marsh', 'REPORTS_TO', 'Dana Kim'))
  assert.deepEqual(labels(p, 'DECISION').map((d) => d.label), ['Launch in Berlin'])
})

test('normalizeDates: month names, weekdays and relative days become ISO dates', () => {
  const on = (s: string) => normalizeDates(s, '2026-10-06') // a Tuesday
  assert.equal(on('book the venue by Oct 10'), 'book the venue by 2026-10-10')
  assert.equal(on('due October 24th'), 'due 2026-10-24')
  assert.equal(on('by 3 Nov 2027'), 'by 2027-11-03')
  assert.equal(on('send it by Friday'), 'send it by 2026-10-09')
  assert.equal(on('by Tuesday'), 'by 2026-10-13', 'the same weekday means next week')
  assert.equal(on('due tomorrow'), 'due 2026-10-07')
  assert.equal(on('kick-off is Jan 15'), 'kick-off is 2027-01-15', 'a long-past month means next year')
  assert.equal(on('Maya may send 5 invites'), 'Maya may send 5 invites', 'lowercase "may" is not a month')
})

test('plain everyday notes: natural dates, "X will ...", and a later "has booked ... Done." update', () => {
  const first = parseMinutes([
    'Maya is planning the team offsite. Ben reports to Maya.',
    '- Ben: book the venue by Oct 10',
    '- Maya will send the invitations by Friday',
    '- Decision: the offsite is on Oct 24.',
  ].join('\n'), { meetingDate: '2026-10-06' })
  assert.deepEqual(labels(first, 'TASK').map((t) => [t.label, t.date, t.status]), [
    ['Book the venue', '2026-10-10', 'OPEN'],
    ['Send the invitations', '2026-10-09', 'OPEN'],
  ])
  assert.ok(edge(first, 'Ben', 'RESPONSIBLE_FOR', 'Book the venue'))
  assert.ok(edge(first, 'Maya', 'RESPONSIBLE_FOR', 'Send the invitations'))
  assert.ok(edge(first, 'Ben', 'REPORTS_TO', 'Maya'))
  assert.deepEqual(labels(first, 'DECISION').map((d) => d.label), ['The offsite is on Oct 24'], 'labels keep the original wording')
  assert.ok(first.covers.has('TASK'), 'explicit action items make the parser the source of truth for tasks')

  const known: KnownEntity[] = [
    { label: 'Book the venue', type: 'TASK', status: 'OPEN' },
    { label: 'Send the invitations', type: 'TASK', status: 'OPEN' },
  ]
  const second = parseMinutes([
    'Ben has booked the venue. Done.',
    'Chloe joins the team and reports to Maya.',
    '- Chloe: order the catering by Oct 17',
  ].join('\n'), { meetingDate: '2026-10-09', knownEntities: known })
  assert.equal(second.nodes.find((n) => n.label === 'Book the venue')?.status, 'DONE')
  assert.equal(second.nodes.find((n) => n.label === 'Send the invitations'), undefined, 'untouched tasks are not restated')
  assert.deepEqual(labels(second, 'TASK').filter((t) => t.status === 'OPEN').map((t) => [t.label, t.date]), [['Order the catering', '2026-10-17']])
  assert.ok(edge(second, 'Chloe', 'REPORTS_TO', 'Maya'))

  // What a live audience types: several sentences on one line, an irregular verb ("sent" for "send").
  const third = parseMinutes('Sam will write the agenda by Friday. Maya has sent the invitations. Done.',
    { meetingDate: '2026-10-09', knownEntities: known })
  assert.deepEqual(third.nodes.filter((n) => n.type === 'TASK').map((t) => [t.label, t.date, t.status]), [
    ['Write the agenda', '2026-10-16', 'OPEN'],
    ['Send the invitations', undefined, 'DONE'],
  ])
  assert.ok(edge(third, 'Sam', 'RESPONSIBLE_FOR', 'Write the agenda'))
})

test('combineWithModel: the model cannot add owners to an action item the notes already assign', () => {
  const text = 'Ben reports to Maya.\n- Maya: send the invitations by Oct 10'
  const parsed = parseMinutes(text, { meetingDate: '2026-10-06' })
  const model = {
    summary: '', ambiguities: [],
    nodes: [
      { temporaryId: 'n1', label: 'Ben', type: 'PERSON' as const, confidence: 0.9 },
      { temporaryId: 'n2', label: 'Send the invitations', type: 'TASK' as const, confidence: 0.9 },
      { temporaryId: 'n3', label: 'Team offsite', type: 'PROJECT' as const, confidence: 0.9 },
    ],
    edges: [
      { sourceTemporaryId: 'n1', targetTemporaryId: 'n2', relationship: 'RESPONSIBLE_FOR', confidence: 0.8 },
      { sourceTemporaryId: 'n1', targetTemporaryId: 'n3', relationship: 'PART_OF', confidence: 0.8 },
    ],
  }
  const x = combineWithModel(model, parsed, text)
  const name = (id: string) => x.nodes.find((n) => n.temporaryId === id)!.label
  const owners = x.edges.filter((e) => name(e.targetTemporaryId) === 'Send the invitations').map((e) => name(e.sourceTemporaryId))
  assert.deepEqual(owners, ['Maya'])
  assert.ok(x.edges.some((e) => name(e.sourceTemporaryId) === 'Ben' && name(e.targetTemporaryId) === 'Team offsite'), 'other model edges are kept')
})

test('structured bullets are not split into sentences (the second sentence qualifies the first)', () => {
  const p = parseMinutes('## Updates\n- Building permit: issued by the city. The blocker is resolved.',
    { knownEntities: [{ label: 'Building permit', type: 'BLOCKER', status: 'OPEN' }] })
  assert.equal(p.nodes.find((n) => n.label === 'Building permit')?.status, 'RESOLVED')
})

test('combineWithModel: model "decisions" are dropped when the text has no decision language', () => {
  const model = {
    summary: '', ambiguities: [], edges: [],
    nodes: [
      { temporaryId: 'n1', label: 'Budget approved', type: 'DECISION' as const, confidence: 0.8 },
      { temporaryId: 'n2', label: 'Network Setup', type: 'SYSTEM' as const, confidence: 0.9 },
    ],
  }
  const updates = '## Updates\n- Victor Ruiz: the relocation budget is approved. Done.'
  assert.deepEqual(combineWithModel(model, parseMinutes(updates), updates).nodes.map((n) => n.label), ['Network Setup'])
  const prose = 'We agreed to move everyone in one weekend.'
  assert.deepEqual(combineWithModel(model, parseMinutes(prose), prose).nodes.map((n) => n.label), ['Budget approved', 'Network Setup'])
})

test('second domain (office relocation): updates resolve the permit, slip the move, close tasks', () => {
  const dir = 'tests/fixtures/scenarios/office-relocation/'
  const known: KnownEntity[] = [
    { label: 'Get three quotes from moving companies', type: 'TASK', status: 'DONE' },
    { label: 'Approve the relocation budget', type: 'TASK', status: 'IN_PROGRESS' },
    { label: 'Sign the contract with Swift Movers', type: 'TASK', status: 'OPEN' },
    { label: 'Order the network equipment', type: 'TASK', status: 'OPEN' },
    { label: 'Building permit', type: 'BLOCKER', status: 'OPEN' },
    { label: 'Move weekend', type: 'MILESTONE', status: 'OPEN' },
    { label: 'Network Setup', type: 'SYSTEM' },
  ]
  const p = parseMinutes(fs.readFileSync(dir + '03-go-no-go.md', 'utf8'), { meetingDate: '2026-09-30', knownEntities: known })
  const byLabel = (l: string) => p.nodes.find((n) => n.label === l)
  assert.equal(byLabel('Building permit')?.status, 'RESOLVED')
  assert.equal(byLabel('Approve the relocation budget')?.status, 'DONE')
  assert.equal(byLabel('Sign the contract with Swift Movers')?.status, 'DONE')
  assert.equal(byLabel('Move weekend')?.date, '2026-11-07')
  assert.equal(byLabel('Order the network equipment'), undefined, 'the delayed-equipment sentence must not touch the order task')
  assert.equal(byLabel('Network equipment delivery')?.status, 'OPEN', '"has not confirmed" is not a completion')
  assert.deepEqual(labels(p, 'TASK').filter((t) => t.date).map((t) => t.label), [
    'Escalate the network equipment delivery with the supplier', 'Prepare the desk-by-desk seating plan',
  ])
  assert.ok(edge(p, 'Nina Brandt', 'REPORTS_TO', 'Grace Liu'))
})
