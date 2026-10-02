// Deterministic tests for status history + corporate views (no model calls).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GraphNode, WorkspaceState } from '../src/shared/schema.ts'
import { deriveState } from '../server/graph/reconcile.ts'
import { buildReport, buildViews } from '../server/views.ts'

const ws = { id: 'w', name: 'Demo', createdAt: '2026-09-01T00:00:00Z' }
const src = (id: string, date: string) => ({ id, workspaceId: 'w', type: 'TEXT' as const, name: `Meeting ${date}`, status: 'DONE' as const, meetingDate: date, createdAt: `${date}T10:00:00Z` })
const node = (id: string, label: string, type: GraphNode['type'], sourceIds: string[], history: GraphNode['history'] = []): GraphNode => {
  const n: GraphNode = { id, workspaceId: 'w', label, type, aliases: [], confidence: 1, sourceIds, history, createdAt: '', updatedAt: '' }
  deriveState(n)
  return n
}

const state: WorkspaceState = {
  workspace: ws,
  sources: [src('m1', '2026-09-08'), src('m2', '2026-09-15'), src('m3', '2026-09-22')],
  nodes: [
    node('raj', 'Raj Patel', 'PERSON', ['m1']),
    node('maria', 'Maria Lopez', 'PERSON', ['m1']),
    node('api', 'API Gateway', 'SYSTEM', ['m1']),
    node('t1', 'Draft gateway architecture', 'TASK', ['m1', 'm2'], [
      { sourceId: 'm1', asOf: '2026-09-08', status: 'OPEN', date: '2026-09-12' },
      { sourceId: 'm2', asOf: '2026-09-15', status: 'DONE' },
    ]),
    node('t2', 'Inventory ledger integrations', 'TASK', ['m1'], [{ sourceId: 'm1', asOf: '2026-09-08', status: 'OPEN', date: '2026-09-14' }]),
    node('pci', 'PCI audit', 'BLOCKER', ['m2', 'm3'], [
      { sourceId: 'm2', asOf: '2026-09-15', status: 'OPEN' },
      { sourceId: 'm3', asOf: '2026-09-22', status: 'RESOLVED' },
    ]),
    node('ms', 'Checkout launch', 'MILESTONE', ['m1', 'm3'], [
      { sourceId: 'm1', asOf: '2026-09-08', status: 'OPEN', date: '2026-10-31' },
      { sourceId: 'm3', asOf: '2026-09-22', date: '2026-11-15' },
    ]),
    node('dec', 'Strangler migration', 'DECISION', ['m1']),
  ],
  edges: [
    { id: 'e1', workspaceId: 'w', source: 'raj', target: 't1', relationship: 'RESPONSIBLE_FOR', confidence: 1, sourceIds: ['m1'], createdAt: '' },
    { id: 'e2', workspaceId: 'w', source: 'raj', target: 'maria', relationship: 'REPORTS_TO', confidence: 1, sourceIds: ['m1'], createdAt: '' },
    { id: 'e3', workspaceId: 'w', source: 'raj', target: 'api', relationship: 'OWNS', confidence: 1, sourceIds: ['m1'], createdAt: '' },
    { id: 'e4', workspaceId: 'w', source: 'pci', target: 'ms', relationship: 'BLOCKS', confidence: 1, sourceIds: ['m2'], createdAt: '' },
  ],
}

test('deriveState: latest meeting wins, regardless of insertion order', () => {
  const n = node('x', 'X', 'TASK', [], [
    { sourceId: 'b', asOf: '2026-09-15', status: 'DONE' },
    { sourceId: 'a', asOf: '2026-09-08', status: 'OPEN', date: '2026-09-10' },
  ])
  assert.equal(n.status, 'DONE')
  assert.equal(n.date, '2026-09-10')
})

test('views: action items, overdue, owners', () => {
  const v = buildViews(state, '2026-09-25')
  const t1 = v.actionItems.find((a) => a.id === 't1')!
  const t2 = v.actionItems.find((a) => a.id === 't2')!
  assert.equal(t1.status, 'DONE')
  assert.deepEqual(t1.owners, ['Raj Patel'])
  assert.equal(t1.overdue, false, 'done items are never overdue')
  assert.equal(t2.overdue, true)
  assert.equal(v.kpis.openActions, 1)
  assert.equal(v.kpis.overdueActions, 1)
})

test('views: blocker lifecycle, milestone slip, ownership, org chart', () => {
  const v = buildViews(state, '2026-09-25')
  const pci = v.blockers.find((b) => b.id === 'pci')!
  assert.equal(pci.status, 'RESOLVED')
  assert.equal(pci.resolvedOn, '2026-09-22')
  assert.deepEqual(pci.blocks, ['Checkout launch'])
  const ms = v.milestones[0]
  assert.equal(ms.date, '2026-11-15')
  assert.equal(ms.originalDate, '2026-10-31')
  assert.equal(ms.slipDays, 15)
  assert.deepEqual(v.ownership.cells.map((c) => [c.owner, c.asset]), [['Raj Patel', 'API Gateway']])
  assert.equal(v.orgChart.edges.filter((e) => e.relationship === 'REPORTS_TO').length, 1)
})

test('views: trend is computed as of each meeting', () => {
  const v = buildViews(state, '2026-09-25')
  assert.deepEqual(v.trend.map((t) => [t.date, t.openActions, t.doneActions, t.openBlockers, t.resolvedBlockers]), [
    ['2026-09-08', 2, 0, 0, 0],
    ['2026-09-15', 1, 1, 1, 0],
    ['2026-09-22', 1, 1, 0, 1],
  ])
  const m3 = v.changes.find((c) => c.sourceId === 'm3')!
  assert.deepEqual(m3.statusChanges.map((c) => [c.label, c.from, c.to]), [['PCI audit', 'OPEN', 'RESOLVED']])
  assert.deepEqual(m3.dateChanges.map((c) => [c.label, c.from, c.to]), [['Checkout launch', '2026-10-31', '2026-11-15']])
})

test('report: markdown includes changes, overdue and slips', () => {
  const md = buildReport(state, '2026-09-25')
  assert.match(md, /PCI audit\*\*: OPEN → \*\*RESOLVED/)
  assert.match(md, /OVERDUE \| Inventory ledger integrations/)
  assert.match(md, /slipped 15d \(was 2026-10-31\)/)
})
