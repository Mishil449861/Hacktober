// Deterministic tests for the minutes parser, run against the real demo minutes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseMinutes, type KnownEntity } from '../server/lib/minutes.ts'

const read = (f: string) => fs.readFileSync(`demo/minutes/${f}`, 'utf8')
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
