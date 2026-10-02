// Deterministic tests (no model calls): npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compatibleTypes, normalize, similarity, toRelationship } from '../server/graph/reconcile.ts'
import { ExtractionSchema } from '../src/shared/schema.ts'
import { addOcrAnnotations, sanitize } from '../server/lib/ai/provider.ts'

test('normalize expands abbreviations and drops filler', () => {
  assert.equal(normalize('Auth API'), normalize('Authentication API'))
  assert.equal(normalize('Postgres DB'), normalize('Postgres Database'))
  assert.equal(normalize('The new Authentication Service'), normalize('authentication'))
})

test('similarity: same entity scores high, different scope scores low', () => {
  assert.ok(similarity('Auth API', 'Authentication API') >= 0.9)
  assert.ok(similarity('API Gateway', 'api-gateway') >= 0.9)
  assert.ok(similarity('Payments Team', 'Payments Service') < 0.9, 'team vs service must not auto-match')
  assert.ok(similarity('Frontend', 'Database') < 0.5)
})

test('compatibleTypes: tasks never merge into systems, decisions never into milestones', () => {
  assert.equal(compatibleTypes('TASK', 'COMPONENT'), false)
  assert.equal(compatibleTypes('DECISION', 'MILESTONE'), false)
  assert.equal(compatibleTypes('PERSON', 'TEAM'), false)
  assert.equal(compatibleTypes('SYSTEM', 'COMPONENT'), true)
  assert.equal(compatibleTypes('OTHER', 'SYSTEM'), true)
  assert.equal(compatibleTypes('OTHER', 'TASK'), false, 'an untyped node must not swallow an action item')
})

test('toRelationship maps known types and keeps free-form labels', () => {
  assert.deepEqual(toRelationship('depends on'), { relationship: 'DEPENDS_ON' })
  assert.deepEqual(toRelationship('Reports-To'), { relationship: 'REPORTS_TO' })
  assert.deepEqual(toRelationship('stores data in'), { relationship: 'RELATES_TO', label: 'stores data in' })
})

test('ExtractionSchema coerces sloppy model output instead of trusting it', () => {
  const r = ExtractionSchema.parse({
    summary: 'x',
    nodes: [{ temporaryId: 1, label: ' API ', type: 'service', confidence: 'high' }],
    edges: 'oops',
    ambiguities: null,
  })
  assert.equal(r.nodes[0].temporaryId, '1')
  assert.equal(r.nodes[0].label, 'API')
  assert.equal(r.nodes[0].type, 'OTHER')
  assert.equal(r.nodes[0].confidence, 0.5)
  assert.deepEqual(r.edges, [])
  assert.deepEqual(r.ambiguities, [])
})

test('sanitize fixes step CALLS -> PRECEDES and reversed BLOCKS, drops dangling edges', () => {
  const x = sanitize({
    summary: '',
    ambiguities: [],
    nodes: [
      { temporaryId: 'a', label: 'Order Received', type: 'PROCESS', confidence: 1 },
      { temporaryId: 'b', label: 'Fraud Check', type: 'PROCESS', confidence: 1 },
      { temporaryId: 'c', label: 'Rate limits', type: 'BLOCKER', confidence: 1 },
      { temporaryId: 'd', label: 'API', type: 'SYSTEM', confidence: 1 },
      { temporaryId: 'e', label: 'DB', type: 'SYSTEM', confidence: 1 },
    ],
    edges: [
      { sourceTemporaryId: 'a', targetTemporaryId: 'b', relationship: 'CALLS', confidence: 1 },
      { sourceTemporaryId: 'b', targetTemporaryId: 'c', relationship: 'BLOCKS', confidence: 1 },
      { sourceTemporaryId: 'd', targetTemporaryId: 'e', relationship: 'CALLS', confidence: 1 },
      { sourceTemporaryId: 'd', targetTemporaryId: 'zzz', relationship: 'USES', confidence: 1 },
    ],
  })
  assert.equal(x.edges.length, 3)
  assert.equal(x.edges[0].relationship, 'PRECEDES')
  assert.deepEqual([x.edges[1].sourceTemporaryId, x.edges[1].targetTemporaryId], ['c', 'b'])
  assert.equal(x.edges[2].relationship, 'CALLS', 'system -> system CALLS is left alone')
})

test('sanitize folds "<entity> latency" into the entity and keeps the attribute as edge label', () => {
  const x = sanitize({
    summary: '', ambiguities: [],
    nodes: [
      { temporaryId: 'a', label: 'Auth API', type: 'SYSTEM', confidence: 1 },
      { temporaryId: 'b', label: 'Auth API latency', type: 'BLOCKER', confidence: 1 },
      { temporaryId: 'c', label: 'Checkout launch', type: 'MILESTONE', confidence: 1 },
      { temporaryId: 'd', label: 'Ledger API rate limits', type: 'BLOCKER', confidence: 1 },
    ],
    edges: [
      { sourceTemporaryId: 'a', targetTemporaryId: 'b', relationship: 'RELATES_TO', confidence: 1 },
      { sourceTemporaryId: 'b', targetTemporaryId: 'c', relationship: 'BLOCKS', confidence: 1 },
    ],
  })
  assert.deepEqual(x.nodes.map((n) => n.label), ['Auth API', 'Checkout launch', 'Ledger API rate limits'])
  assert.equal(x.edges.length, 1)
  assert.deepEqual([x.edges[0].sourceTemporaryId, x.edges[0].targetTemporaryId, x.edges[0].relationship, x.edges[0].label], ['a', 'c', 'BLOCKS', 'latency'])
})

test('sanitize turns person MANAGES person into reversed REPORTS_TO', () => {
  const x = sanitize({
    summary: '', ambiguities: [],
    nodes: [
      { temporaryId: 'm', label: 'Maria Lopez', type: 'PERSON', confidence: 1 },
      { temporaryId: 'r', label: 'Raj Patel', type: 'PERSON', confidence: 1 },
      { temporaryId: 't', label: 'Platform Team', type: 'TEAM', confidence: 1 },
    ],
    edges: [
      { sourceTemporaryId: 'm', targetTemporaryId: 'r', relationship: 'manages', confidence: 1 },
      { sourceTemporaryId: 'r', targetTemporaryId: 't', relationship: 'LEADS', confidence: 1 },
    ],
  })
  assert.deepEqual([x.edges[0].sourceTemporaryId, x.edges[0].relationship, x.edges[0].targetTemporaryId], ['r', 'REPORTS_TO', 'm'])
  assert.equal(x.edges[1].relationship, 'LEADS', 'person LEADS team is not a reporting line')
})

test('sanitize reverses ownership that points from a system to a team, keeps team->team', () => {
  const x = sanitize({
    summary: '', ambiguities: [],
    nodes: [
      { temporaryId: 'api', label: 'Authentication API', type: 'SYSTEM', confidence: 1 },
      { temporaryId: 'idt', label: 'Identity Team', type: 'TEAM', confidence: 1 },
      { temporaryId: 'org', label: 'Platform Org', type: 'TEAM', confidence: 1 },
    ],
    edges: [
      { sourceTemporaryId: 'api', targetTemporaryId: 'idt', relationship: 'OWNS', confidence: 1 },
      { sourceTemporaryId: 'org', targetTemporaryId: 'idt', relationship: 'OWNS', confidence: 1 },
    ],
  })
  assert.deepEqual([x.edges[0].sourceTemporaryId, x.edges[0].targetTemporaryId], ['idt', 'api'])
  assert.deepEqual([x.edges[1].sourceTemporaryId, x.edges[1].targetTemporaryId], ['org', 'idt'])
})

test('addOcrAnnotations adds labeled whiteboard notes the model missed, without duplicating', () => {
  const base = { summary: '', ambiguities: [], edges: [], nodes: [{ temporaryId: 'n1', label: 'Payments Service', type: 'SYSTEM' as const, confidence: 1 }] }
  const ocr = 'Payments Platform\nBLOCKER: PCI audit not done\nDecision - keep legacy Ledger\nOwner: Web Team\nTODO: load-test Redis cache\nDONE: ledger inventory'
  const x = addOcrAnnotations(base, ocr)
  assert.deepEqual(x.nodes.map((n) => [n.label, n.type, n.status]), [
    ['Payments Service', 'SYSTEM', undefined], ['PCI audit', 'BLOCKER', 'OPEN'], ['keep legacy Ledger', 'DECISION', undefined],
    ['load-test Redis cache', 'TASK', 'OPEN'], ['ledger inventory', 'TASK', 'DONE'],
  ])
  const again = addOcrAnnotations(x, ocr)
  assert.equal(again.nodes.length, 5, 'already-present annotations are not added twice')
})

test('ExtractionSchema rejects structurally invalid output', () => {
  assert.equal(ExtractionSchema.safeParse({ summary: 'x', nodes: 'nope' }).success, false)
  assert.equal(ExtractionSchema.safeParse({ summary: 'x', nodes: [{ temporaryId: 'a', label: '' }] }).success, false)
})
