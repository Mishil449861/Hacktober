/**
 * End-to-end scenario: plays the Northwind "Payments Platform Migration" meetings (demo/scenarios/payments-migration)
 * in order against a running server, then checks that the corporate views tell the right story.
 *
 *   npm run dev                 (terminal 1)
 *   npm run test:scenario       (terminal 2)
 */
import fs from 'node:fs'
import path from 'node:path'
import type { WorkspaceState } from '../src/shared/schema.ts'
import type { Views } from '../server/views.ts'
import { similarity } from '../server/graph/text.ts'

const API = process.env.ORGMAP_API ?? 'http://localhost:8787'
const DIR = path.resolve('demo/scenarios/payments-migration')
const TODAY = '2026-10-02'

export const SCENARIO: { name: string; date: string; text?: string; photo?: string }[] = [
  { name: 'Kickoff', date: '2026-09-08', text: '01-kickoff.md' },
  { name: 'Architecture review', date: '2026-09-15', text: '02-architecture-review.md' },
  { name: 'Architecture review (whiteboard)', date: '2026-09-15', photo: '02-whiteboard.png' },
  { name: 'Weekly sync', date: '2026-09-22', text: '03-weekly-sync.md' },
  { name: 'Steering committee', date: '2026-09-29', text: '04-steering-committee.md' },
  { name: 'Steering committee (sprint board)', date: '2026-09-29', photo: '04-sprint-board.png' },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + url, init)
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}

async function main() {
  const ws = await j<{ id: string }>('/api/workspaces', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `[scenario] Payments Platform Migration` }),
  })
  for (const step of SCENARIO) {
    const t0 = Date.now()
    const fd = new FormData()
    fd.append('date', step.date)
    if (step.text) { fd.append('text', fs.readFileSync(path.join(DIR, step.text), 'utf8')); fd.append('name', `${step.date} · ${step.name}`) }
    if (step.photo) fd.append('files', new Blob([fs.readFileSync(path.join(DIR, step.photo))], { type: 'image/png' }), `${step.date} · ${step.name}.png`)
    const [src] = await j<{ id: string }[]>(`/api/workspaces/${ws.id}/sources`, { method: 'POST', body: fd })
    let s: WorkspaceState
    for (;;) {
      await sleep(1500)
      s = await j<WorkspaceState>(`/api/workspaces/${ws.id}`)
      const x = s.sources.find((y) => y.id === src.id)!
      if (x.status === 'DONE' || x.status === 'ERROR') { console.log(`${x.status.padEnd(5)} ${step.date} ${step.name} (${((Date.now() - t0) / 1000).toFixed(0)}s)${x.error ? ' ' + x.error : ''}`); break }
    }
  }

  const v = await j<Views>(`/api/workspaces/${ws.id}/views?today=${TODAY}`)
  const find = <T extends { label: string }>(list: T[], label: string) =>
    list.map((x) => ({ x, s: similarity(x.label, label) })).sort((a, b) => b.s - a.s).find((r) => r.s >= 0.5)?.x

  console.log('\nKPIs', JSON.stringify(v.kpis))
  console.log('\nAction items:'); for (const a of v.actionItems) console.log(`  ${a.overdue ? 'OVERDUE' : a.status.padEnd(11)} ${a.label} | ${a.owners.join(', ') || '-'} | due ${a.due ?? '-'}`)
  console.log('Blockers:'); for (const b of v.blockers) console.log(`  ${b.status.padEnd(9)} ${b.label} -> ${b.blocks.join(', ')}`)
  console.log('Milestones:'); for (const m of v.milestones) console.log(`  ${m.label}: ${m.date} (orig ${m.originalDate}, slip ${m.slipDays}d)`)
  console.log('Decisions:'); for (const d of v.decisions) console.log(`  ${d.date} ${d.label}`)
  console.log('Org:', v.orgChart.edges.filter((e) => e.relationship === 'REPORTS_TO').map((e) => `${v.orgChart.nodes.find((n) => n.id === e.source)?.label} -> ${v.orgChart.nodes.find((n) => n.id === e.target)?.label}`).join('; '))
  console.log('Trend:', v.trend.map((t) => `${t.date}: open ${t.openActions}/done ${t.doneActions}, blockers ${t.openBlockers}/${t.resolvedBlockers}`).join(' | '))

  const checks: [string, boolean][] = []
  const pci = find(v.blockers, 'PCI audit')
  checks.push(['PCI audit blocker raised then RESOLVED', pci?.status === 'RESOLVED'])
  const launch = find(v.milestones, 'Checkout launch')
  checks.push(['Checkout launch moved to 2026-11-15', launch?.date === '2026-11-15'])
  checks.push(['Checkout launch shows a slip', (launch?.slipDays ?? 0) > 0])
  for (const [label, status] of [['Draft target architecture for the API Gateway', 'DONE'], ['Inventory legacy Ledger integrations', 'DONE'], ['Confirm migration budget with Finance', 'DONE'], ['Renew fraud vendor contract', 'OPEN']] as const) {
    const a = find(v.actionItems, label)
    checks.push([`Action "${label}" is ${status}`, !!a && (status === 'DONE' ? a.status === 'DONE' : a.status !== 'DONE')])
  }
  const lt = find(v.actionItems, 'Load-test Auth Service with Redis Cache')
  checks.push(['Load-test action is overdue (due 09-30, not done)', !!lt?.overdue])
  checks.push(['Fraud vendor contract is an open risk', !!v.blockers.find((b) => similarity(b.label, 'Fraud vendor contract') >= 0.5 && b.status !== 'RESOLVED')])
  checks.push(['At least 3 decisions logged', v.decisions.length >= 3])
  const reports = v.orgChart.edges.filter((e) => e.relationship === 'REPORTS_TO').map((e) => `${v.orgChart.nodes.find((n) => n.id === e.source)?.label}>${v.orgChart.nodes.find((n) => n.id === e.target)?.label}`)
  checks.push(['Org chart: Raj reports to Sarah', reports.some((r) => /Raj/.test(r.split('>')[0]) && /Sarah/.test(r.split('>')[1]))])
  checks.push(['Org chart: Priya reports to Ana', reports.some((r) => /Priya/.test(r.split('>')[0]) && /Ana/.test(r.split('>')[1]))])
  checks.push(['No duplicate people', new Set(v.orgChart.nodes.filter((n) => n.type === 'PERSON').map((n) => n.label.split(' ')[0])).size === v.orgChart.nodes.filter((n) => n.type === 'PERSON').length])

  console.log('')
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  const passed = checks.filter(([, ok]) => ok).length
  console.log(`\n${passed}/${checks.length} scenario checks passed · workspace ${ws.id}`)
  process.exit(passed === checks.length ? 0 : 1)
}

if (process.argv[1]?.endsWith('scenario.ts')) main().catch((e) => { console.error(e); process.exit(2) })
