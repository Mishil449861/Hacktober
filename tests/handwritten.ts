/**
 * Handwritten notes end to end, against the running server and local model (photos go through Cloudinary
 * when it is configured): a first meeting, then a follow-up, as photos and as typed notes.
 *
 *   npm run dev                  (terminal 1)
 *   npm run test:handwritten     (terminal 2)   [-- --only photos|typed]
 *
 * For each source it prints what every stage produced (needs the extraction trace, on by default in
 * development), so a wrong to-do can be pinned on the stage that lost it: the vision model's reading,
 * the notes parser, cleanup, or the merge into the graph.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Views } from '../server/views.ts'
import type { WorkspaceState } from '../src/shared/schema.ts'
import { similarity } from '../server/graph/text.ts'

const API = process.env.ORGMAP_API ?? 'http://localhost:8787'
const DIR = path.resolve('tests/fixtures/handwritten')

interface Expect { label: string; owners: string[]; due?: string; status: string }
interface Flow { name: string; steps: { file: string; date: string }[]; today: string; expect: Expect[]; absent: string[]; blockers: string[]; decisions: string[] }

const FLOWS: Flow[] = [
  {
    name: 'photos',
    steps: [{ file: '01-sync-photo.png', date: '2026-10-06' }, { file: '02-follow-up-photo.png', date: '2026-10-13' }],
    today: '2026-10-13',
    expect: [
      { label: 'Landing page', owners: ['Maya'], due: '2026-10-09', status: 'DONE' },
      { label: 'Logo', owners: ['Maya'], due: '2026-10-09', status: 'OPEN' },
      { label: 'API integration', owners: ['Linh'], due: '2026-10-12', status: 'DONE' },
      { label: 'Competitor research', owners: ['Alex'], due: '2026-10-07', status: 'OPEN' },
      { label: 'Fix login', owners: [], due: '2026-10-20', status: 'OPEN' },
      { label: 'Privacy policy', owners: ['Maya'], due: '2026-10-21', status: 'IN_PROGRESS' },
      { label: 'DB testing', owners: ['Linh'], due: '2026-10-22', status: 'OPEN' },
      { label: 'Pricing research', owners: ['Alex'], due: '2026-10-23', status: 'OPEN' },
    ],
    absent: ['Banner ads'],
    blockers: ['API key'],
    decisions: ['Demo stays Oct 24'],
  },
  {
    name: 'typed',
    steps: [{ file: '01-kickoff.txt', date: '2026-10-07' }, { file: '02-weekly-sync.txt', date: '2026-10-10' }],
    today: '2026-10-10',
    expect: [
      { label: 'Wireframes', owners: ['Maya'], due: '2026-10-14', status: 'OPEN' },
      { label: 'Set up API', owners: ['Linh'], due: '2026-10-16', status: 'OPEN' },
      { label: 'Look at 5 competitors', owners: ['Alex'], due: '2026-10-13', status: 'OPEN' },
      { label: 'Landing page', owners: ['Maya'], status: 'DONE' },
      { label: 'Privacy policy', owners: ['Maya'], due: '2026-10-21', status: 'IN_PROGRESS' },
      { label: 'Competitor research', owners: ['Alex'], status: 'DONE' },
      { label: 'DB testing', owners: ['Linh'], due: '2026-10-22', status: 'IN_PROGRESS' },
      { label: 'Final QA before demo', owners: [], due: '2026-10-23', status: 'OPEN' },
      { label: 'Fix test account', owners: ['Linh'], due: '2026-10-20', status: 'OPEN' },
    ],
    absent: [],
    blockers: ['API credentials', 'DB test account'],
    decisions: ['React + Node', 'Demo stays Oct 24'],
  },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + url, init)
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}
const find = <T extends { label: string }>(list: T[], label: string) =>
  list.map((x) => ({ x, s: similarity(x.label, label) })).sort((a, b) => b.s - a.s).find((r) => r.s >= 0.7)?.x

type Stage = { stage: string; data: unknown }
type XNode = { temporaryId: string; label: string; type: string; date?: string; status?: string; owner?: string | null }
type X = { nodes: XNode[]; edges: { sourceTemporaryId: string; targetTemporaryId: string; relationship: string }[]; transcript?: string }

/** One line per stage: the tasks it holds, with owner, due date and status. */
function stageLines(trace: Stage[]) {
  const rows: string[] = []
  const fmt = (label: string, owner?: string, date?: string, status?: string) =>
    `${label}${owner ? ` <- ${owner}` : ''}${date ? ` @${date}` : ''}${status ? ` [${status}]` : ''}`
  const tasksOf = (x: X) => x.nodes.filter((n) => n.type === 'TASK').map((t) => fmt(t.label,
    t.owner ?? x.edges.filter((e) => e.targetTemporaryId === t.temporaryId && /OWNS|RESPONSIBLE_FOR/.test(e.relationship))
      .map((e) => x.nodes.find((n) => n.temporaryId === e.sourceTemporaryId)?.label).join(',') ?? undefined, t.date, t.status))
  for (const s of trace) {
    if (s.stage === 'model.validated') {
      const x = s.data as X
      if (x.transcript) rows.push(`  vision transcript   ${x.transcript.replace(/\n/g, ' ⏎ ').slice(0, 400)}`)
      rows.push(`  model               ${tasksOf(x).join(' | ') || '(no tasks)'}`)
    } else if (s.stage === 'notes-parser') {
      const p = s.data as { input: string; nodes: string[]; edges: string[] }
      const owner = (label: string) => p.edges.filter((e) => e.endsWith(`-RESPONSIBLE_FOR-> ${label}`)).map((e) => e.split(' -')[0]).join(',')
      rows.push(`  parser (${p.input})`.padEnd(22) + (p.nodes.filter((n) => n.startsWith('TASK ')).map((n) => {
        const label = n.slice(5).replace(/ @\S+| \[\w+\]/g, '')
        return `${n.slice(5)}${owner(label) ? ` <- ${owner(label)}` : ''}`
      }).join(' | ') || '(no tasks)'))
    } else if (s.stage === 'final') {
      rows.push(`  after cleanup       ${tasksOf(s.data as X).join(' | ') || '(no tasks)'}`)
    } else if (s.stage === 'views.actionItems') {
      rows.push(`  to-do list          ${(s.data as { label: string; owners: string[]; due: string | null; status: string }[])
        .map((a) => fmt(a.label, a.owners.join(','), a.due ?? undefined, a.status)).join(' | ') || '(none)'}`)
    } else if (s.stage === 'error') rows.push(`  ERROR               ${String(s.data)}`)
  }
  return rows
}

async function run(flow: Flow) {
  console.log(`\n=== ${flow.name}`)
  const ws = await j<{ id: string }>('/api/workspaces', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `[handwritten] ${flow.name}` }),
  })
  for (const step of flow.steps) {
    const t0 = Date.now()
    const fd = new FormData()
    fd.append('date', step.date)
    const file = path.join(DIR, step.file)
    if (step.file.endsWith('.png')) fd.append('files', new Blob([fs.readFileSync(file)], { type: 'image/png' }), step.file)
    else { fd.append('text', fs.readFileSync(file, 'utf8')); fd.append('name', step.file) }
    const [src] = await j<{ id: string }[]>(`/api/workspaces/${ws.id}/sources`, { method: 'POST', body: fd })
    let s: WorkspaceState['sources'][number]
    for (;;) {
      await sleep(1500)
      s = (await j<WorkspaceState>(`/api/workspaces/${ws.id}`)).sources.find((y) => y.id === src.id)!
      if (s.status === 'DONE' || s.status === 'ERROR') break
    }
    console.log(`${s.status.padEnd(5)} ${step.date} ${step.file} (${((Date.now() - t0) / 1000).toFixed(0)}s) via ${s.analyzedWith ?? '-'}${s.error ? ' ' + s.error : ''}`)
    if (s.cloudinary) console.log(`  cloudinary          ${s.cloudinary.publicId} -> model read the prepared copy`)
    const trace = await j<Stage[]>(`/api/sources/${src.id}/trace`).catch(() => undefined)
    if (trace) for (const r of stageLines(trace)) console.log(r)
    else console.log('  (no trace: set ORGMAP_DEBUG=true on the server to see each stage)')
  }

  const v = await j<Views>(`/api/workspaces/${ws.id}/views?today=${flow.today}`)
  const checks: [string, boolean, string][] = []
  for (const e of flow.expect) {
    const a = find(v.actionItems, e.label)
    const got = a ? `${a.label} | ${a.owners.join(',') || '-'} | ${a.due ?? '-'} | ${a.status}` : 'missing'
    checks.push([`${e.label} -> ${e.owners.join(',') || 'unassigned'}`, !!a && a.owners.join(',') === e.owners.join(','), got])
    checks.push([`${e.label} due ${e.due ?? 'none'}`, !!a && (a.due ?? undefined) === e.due, got])
    checks.push([`${e.label} is ${e.status}`, !!a && a.status === e.status, got])
    checks.push([`${e.label} appears once`, v.actionItems.filter((x) => similarity(x.label, e.label) >= 0.85).length === 1,
      v.actionItems.filter((x) => similarity(x.label, e.label) >= 0.85).map((x) => x.label).join(', ')])
  }
  for (const l of flow.absent) checks.push([`no "${l}" (crossed out)`, !find(v.actionItems, l), find(v.actionItems, l)?.label ?? ''])
  for (const b of flow.blockers) checks.push([`blocker "${b}"`, !!find(v.blockers, b), v.blockers.map((x) => x.label).join(', ')])
  for (const d of flow.decisions) checks.push([`decision "${d}"`, !!find(v.decisions, d), v.decisions.map((x) => x.label).join(', ')])
  const people = v.orgChart.nodes.filter((n) => n.type === 'PERSON').map((n) => n.label).sort()
  checks.push(['people are exactly Alex, Linh, Maya', people.join(',') === 'Alex,Linh,Maya', people.join(', ')])

  console.log('\n  To-do list:')
  for (const a of v.actionItems) console.log(`    ${a.status.padEnd(11)} ${a.label} | ${a.owners.join(', ') || 'nobody yet'} | ${a.due ?? 'no date'}`)
  console.log('')
  for (const [name, ok, got] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   (got: ${got})`}`)
  const passed = checks.filter(([, ok]) => ok).length
  console.log(`\n  ${flow.name}: ${passed}/${checks.length} checks passed · workspace ${ws.id}`)
  return passed === checks.length
}

async function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
  const status = await j<{ reachable: boolean; visionModel?: string; cloudinary: boolean }>('/api/status')
  if (!status.reachable) throw new Error('Local model runtime not reachable')
  console.log(`vision model: ${status.visionModel ?? 'none (OCR fallback)'} · cloudinary: ${status.cloudinary ? 'on' : 'off'}`)
  let ok = true
  for (const f of FLOWS.filter((x) => !only || x.name === only)) ok = (await run(f)) && ok
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
