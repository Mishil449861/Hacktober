/**
 * End-to-end eval against the running API + local models.
 *
 *   npm run dev            (terminal 1)
 *   npm run test:eval      (terminal 2)   [-- --case alias-reconcile]
 *
 * Each case gets a fresh workspace; sources are added one at a time (incremental merge),
 * then the graph is scored against expected nodes / edges / no-duplicate constraints.
 */
import fs from 'node:fs'
import path from 'node:path'
import { similarity } from '../server/graph/reconcile.ts'
import type { GraphNode, WorkspaceState } from '../src/shared/schema.ts'

const API = process.env.ORGMAP_API ?? 'http://localhost:8787'
const DIR = path.resolve('tests/dataset')
const SRC_DIR = path.join(DIR, 'sources')
const MATCH = 0.8
const NODE_RECALL_MIN = 0.75
const EDGE_RECALL_MIN = 0.6

interface ExpNode { label: string; type?: string; aka?: string[] }
interface ExpEdge { from: string; to: string; rel: string[]; undirected?: boolean }
interface Case {
  id: string
  description: string
  sources: { kind: 'TEXT' | 'TEXT_FILE' | 'IMAGE'; text?: string; file?: string }[]
  expectNodes: ExpNode[]
  expectEdges: ExpEdge[]
  noDuplicates?: string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + url, init)
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}

async function addSource(wsId: string, s: Case['sources'][number]) {
  const fd = new FormData()
  if (s.kind === 'TEXT') fd.append('text', s.text!)
  else {
    const p = path.resolve(SRC_DIR, s.file!)
    const mime = s.kind === 'IMAGE' ? 'image/png' : 'text/markdown'
    fd.append('files', new Blob([fs.readFileSync(p)], { type: mime }), path.basename(p))
  }
  const [created] = await j<{ id: string }[]>(`/api/workspaces/${wsId}/sources`, { method: 'POST', body: fd })
  for (;;) {
    await sleep(2000)
    const st = await j<WorkspaceState>(`/api/workspaces/${wsId}`)
    const src = st.sources.find((x) => x.id === created.id)!
    if (src.status === 'DONE' || src.status === 'ERROR') return src
  }
}

const names = (n: GraphNode) => [n.label, ...n.aliases]
const nodeScore = (exp: ExpNode, n: GraphNode) =>
  Math.max(...[exp.label, ...(exp.aka ?? [])].flatMap((e) => names(n).map((g) => similarity(e, g))))

function score(c: Case, st: WorkspaceState) {
  const matches = new Map<string, GraphNode[]>() // expected label -> graph nodes that match
  const nodeRows = c.expectNodes.map((exp) => {
    const hits = st.nodes.filter((n) => nodeScore(exp, n) >= MATCH).sort((a, b) => nodeScore(exp, b) - nodeScore(exp, a))
    matches.set(exp.label, hits)
    const best = hits[0]
    return {
      expected: exp.label, found: best?.label ?? null,
      typeOk: !exp.type || best?.type === exp.type, gotType: best?.type,
    }
  })
  const label = new Map(st.nodes.map((n) => [n.id, n.label]))
  const edgeRows = c.expectEdges.map((exp) => {
    const from = new Set((matches.get(exp.from) ?? []).map((n) => n.id))
    const to = new Set((matches.get(exp.to) ?? []).map((n) => n.id))
    const fwd = st.edges.filter((e) => from.has(e.source) && to.has(e.target))
    const rev = exp.undirected ? st.edges.filter((e) => to.has(e.source) && from.has(e.target)) : []
    const relOk = [...fwd, ...rev].find((e) => exp.rel.includes(e.relationship))
    const any = fwd[0] ?? rev[0]
    const reversed = !exp.undirected && st.edges.find((e) => to.has(e.source) && from.has(e.target))
    return {
      expected: `${exp.from} -${exp.rel[0]}-> ${exp.to}`,
      status: relOk ? 'ok' : any ? `wrong rel (${any.relationship})` : reversed ? `reversed (${reversed.relationship})` : 'missing',
    }
  })
  const dupRows = (c.noDuplicates ?? []).map((lbl) => {
    const exp = c.expectNodes.find((e) => e.label === lbl) ?? { label: lbl }
    const hits = st.nodes.filter((n) => nodeScore(exp, n) >= MATCH)
    return { label: lbl, count: hits.length, nodes: hits.map((n) => n.label) }
  })
  const nodeRecall = nodeRows.filter((r) => r.found).length / nodeRows.length
  const edgeRecall = edgeRows.filter((r) => r.status === 'ok').length / (edgeRows.length || 1)
  const dupes = dupRows.filter((d) => d.count > 1).length
  const errors = st.sources.filter((s) => s.status === 'ERROR').map((s) => s.error)
  const pass = nodeRecall >= NODE_RECALL_MIN && edgeRecall >= EDGE_RECALL_MIN && dupes === 0 && errors.length === 0
  return {
    pass, nodeRecall, edgeRecall, dupes, errors, nodeRows, edgeRows, dupRows,
    graph: { nodes: st.nodes.map((n) => `${n.type} ${n.label}${n.aliases.length ? ` (aka ${n.aliases.join(', ')})` : ''}${n.possibleDuplicateOf ? ' [REVIEW]' : ''}`),
      edges: st.edges.map((e) => `${label.get(e.source)} -${e.relationship}-> ${label.get(e.target)}`) },
  }
}

async function main() {
  const only = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : undefined
  const cases = (JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8')) as Case[]).filter((c) => !only || c.id === only)
  const status = await j<{ textModel?: string; visionModel?: string; reachable: boolean }>('/api/status')
  if (!status.reachable) throw new Error('Local model runtime not reachable')
  console.log(`models: text=${status.textModel} vision=${status.visionModel ?? 'OCR fallback'}\n`)

  const results = []
  for (const c of cases) {
    const t0 = Date.now()
    const ws = await j<{ id: string }>('/api/workspaces', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `[eval] ${c.id}` }),
    })
    const timings: string[] = []
    for (const s of c.sources) {
      const t = Date.now()
      const src = await addSource(ws.id, s)
      timings.push(`${src.name.slice(0, 30)}: ${((Date.now() - t) / 1000).toFixed(0)}s via ${src.analyzedWith ?? '-'}`)
    }
    const st = await j<WorkspaceState>(`/api/workspaces/${ws.id}`)
    const r = score(c, st)
    results.push({ id: c.id, seconds: (Date.now() - t0) / 1000, timings, ...r })

    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${c.id}  nodes ${(r.nodeRecall * 100).toFixed(0)}%  edges ${(r.edgeRecall * 100).toFixed(0)}%  dupes ${r.dupes}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
    for (const t of timings) console.log(`      ${t}`)
    for (const n of r.nodeRows) if (!n.found || !n.typeOk) console.log(`      node ${n.found ? `type ${n.gotType}` : 'missing'}: ${n.expected}`)
    for (const e of r.edgeRows) if (e.status !== 'ok') console.log(`      edge ${e.status}: ${e.expected}`)
    for (const d of r.dupRows) if (d.count > 1) console.log(`      duplicate: ${d.label} -> ${d.nodes.join(' | ')}`)
    for (const e of r.errors) console.log(`      ERROR: ${e}`)
    if (!r.pass) for (const e of r.graph.edges) console.log(`        got: ${e}`)
  }

  const passed = results.filter((r) => r.pass).length
  const avg = (k: 'nodeRecall' | 'edgeRecall') => (results.reduce((a, r) => a + r[k], 0) / results.length * 100).toFixed(0)
  console.log(`\n${passed}/${results.length} cases passed · avg node recall ${avg('nodeRecall')}% · avg edge recall ${avg('edgeRecall')}%`)
  const out = path.resolve('tests/results')
  fs.mkdirSync(out, { recursive: true })
  const file = path.join(out, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify({ status, results }, null, 2))
  console.log(`report: ${path.relative(process.cwd(), file)}`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
