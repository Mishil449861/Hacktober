/**
 * Derived "corporate" views over one workspace graph: KPIs, action items, blockers, decisions,
 * milestones (with slips), org chart, ownership matrix, dependencies, per-meeting trends and
 * change log, plus a Markdown status report. Pure functions of WorkspaceState: every new
 * photo or edited minutes changes the graph, and every view follows automatically.
 */
import type { GraphEdge, GraphNode, NodeStatus, Source, WorkspaceState } from '../src/shared/schema.ts'

const OWNER_TYPES = new Set(['PERSON', 'TEAM'])
const ASSET_TYPES = new Set(['SYSTEM', 'COMPONENT', 'PROJECT', 'PROCESS', 'DOCUMENT'])
const FLOW_RELS = new Set(['CALLS', 'DEPENDS_ON', 'USES', 'FEEDS_INTO', 'PRECEDES', 'PRODUCES'])
const DONE = new Set<NodeStatus>(['DONE', 'RESOLVED', 'CANCELLED'])

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

export function buildViews(st: WorkspaceState, todayOverride?: string) {
  const today = todayOverride ?? new Date().toISOString().slice(0, 10)
  const node = new Map(st.nodes.map((n) => [n.id, n]))
  const srcDate = (s: Source) => s.meetingDate ?? s.cloudinary?.createdAt?.slice(0, 10) ?? s.createdAt.slice(0, 10)
  const sources = [...st.sources].sort((a, b) => srcDate(a).localeCompare(srcDate(b)) || a.createdAt.localeCompare(b.createdAt))
  const sourceById = new Map(sources.map((s) => [s.id, s]))
  const dateOf = (sourceId: string) => { const s = sourceById.get(sourceId); return s ? srcDate(s) : undefined }
  const nameOf = (sourceId: string) => sourceById.get(sourceId)?.name ?? (sourceId === 'manual' ? 'edited in app' : 'removed source')

  /** Earliest meeting that mentioned the node. */
  const firstSeen = (n: GraphNode) => {
    const dates = [...(n.history ?? []).map((h) => h.asOf), ...n.sourceIds.map(dateOf).filter(Boolean) as string[]]
    return dates.sort()[0] ?? n.createdAt.slice(0, 10)
  }
  const firstSource = (n: GraphNode) => [...n.sourceIds].sort((a, b) => (dateOf(a) ?? '').localeCompare(dateOf(b) ?? ''))[0]
  /** status/date as of a given day (latest statement on or before it). */
  const asOf = (n: GraphNode, day: string) => {
    const h = (n.history ?? []).map((e, i) => ({ e, i })).filter((x) => x.e.asOf <= day)
      .sort((a, b) => a.e.asOf.localeCompare(b.e.asOf) || a.i - b.i)
    return { status: h.filter((x) => x.e.status).at(-1)?.e.status, date: h.filter((x) => x.e.date).at(-1)?.e.date }
  }
  const linked = (id: string, rels: string[], dir: 'in' | 'out') => st.edges
    .filter((e) => rels.includes(e.relationship) && (dir === 'in' ? e.target === id : e.source === id))
    .map((e) => node.get(dir === 'in' ? e.source : e.target)!).filter(Boolean)
  /** Owners: people/teams pointing at the item with OWNS/RESPONSIBLE_FOR (tolerating reversed edges). */
  const ownersOf = (id: string) => [...new Set([
    ...linked(id, ['OWNS', 'RESPONSIBLE_FOR'], 'in'),
    ...linked(id, ['OWNS', 'RESPONSIBLE_FOR', 'RELATES_TO'], 'out'),
  ].filter((o) => OWNER_TYPES.has(o.type)).map((o) => o.label))]
  const lastUpdate = (n: GraphNode) => {
    const h = [...(n.history ?? [])].sort((a, b) => a.asOf.localeCompare(b.asOf)).at(-1)
    return h ? { on: h.asOf, in: nameOf(h.sourceId) } : undefined
  }
  const byType = (t: string) => st.nodes.filter((n) => n.type === t)

  // ---------- action items ----------
  const actionItems = byType('TASK').map((n) => {
    const status = n.status ?? 'OPEN'
    return {
      id: n.id, label: n.label, description: n.description, owners: ownersOf(n.id), due: n.date, status,
      overdue: !!n.date && n.date < today && !DONE.has(status),
      raisedOn: firstSeen(n), raisedIn: nameOf(firstSource(n) ?? ''), lastUpdate: lastUpdate(n),
      meetings: n.sourceIds.map(nameOf),
    }
  }).sort((a, b) => Number(DONE.has(a.status)) - Number(DONE.has(b.status)) || (a.due ?? '9999').localeCompare(b.due ?? '9999'))

  // ---------- blockers & risks ----------
  const resolvedOn = (n: GraphNode) => (n.history ?? []).filter((h) => h.status && DONE.has(h.status)).map((h) => h.asOf).sort()[0]
  const blockers = [
    ...byType('BLOCKER').map((n) => {
      const status = n.status ?? 'OPEN'
      const raised = firstSeen(n), resolved = DONE.has(status) ? resolvedOn(n) : undefined
      return {
        id: n.id, label: n.label, description: n.description, status,
        blocks: linked(n.id, ['BLOCKS'], 'out').map((x) => x.label), owners: ownersOf(n.id),
        raisedOn: raised, raisedIn: nameOf(firstSource(n) ?? ''), resolvedOn: resolved,
        ageDays: daysBetween(raised, resolved ?? today), kind: 'blocker' as const,
      }
    }),
    // "Auth API BLOCKS Checkout (latency)": a property of a system blocking something.
    ...st.edges.filter((e) => e.relationship === 'BLOCKS' && node.get(e.source)?.type !== 'BLOCKER').map((e: GraphEdge) => {
      const src = node.get(e.source)!, raised = e.sourceIds.map(dateOf).filter(Boolean).sort()[0] as string ?? e.createdAt.slice(0, 10)
      return {
        id: e.id, label: `${src.label}${e.label ? ` (${e.label})` : ''}`, description: undefined, status: 'OPEN' as NodeStatus,
        blocks: [node.get(e.target)?.label ?? '?'], owners: ownersOf(src.id), raisedOn: raised,
        raisedIn: nameOf(e.sourceIds[0] ?? ''), resolvedOn: undefined, ageDays: daysBetween(raised, today), kind: 'dependency' as const,
      }
    }),
  ].sort((a, b) => Number(DONE.has(a.status)) - Number(DONE.has(b.status)) || b.ageDays - a.ageDays)

  // ---------- decisions ----------
  const decisions = byType('DECISION').map((n) => ({
    id: n.id, label: n.label, description: n.description, date: n.date ?? firstSeen(n), meeting: nameOf(firstSource(n) ?? ''),
    affects: [...linked(n.id, ['RELATES_TO', 'USES', 'DEPENDS_ON', 'BLOCKS', 'PRODUCES'], 'out'), ...linked(n.id, ['RELATES_TO'], 'in')].map((x) => x.label),
  })).sort((a, b) => b.date.localeCompare(a.date))

  // ---------- milestones (with slips) ----------
  const milestones = byType('MILESTONE').map((n) => {
    const dated = (n.history ?? []).filter((h) => h.date).sort((a, b) => a.asOf.localeCompare(b.asOf))
    const slips = dated.slice(1).map((h, i) => ({ asOf: h.asOf, in: nameOf(h.sourceId), from: dated[i].date!, to: h.date! }))
      .filter((s) => s.from !== s.to)
    const status = n.status ?? 'OPEN'
    return {
      id: n.id, label: n.label, description: n.description, date: n.date, originalDate: dated[0]?.date, status, slips,
      slipDays: n.date && dated[0]?.date ? daysBetween(dated[0].date, n.date) : 0,
      daysLeft: n.date ? daysBetween(today, n.date) : undefined, owners: ownersOf(n.id),
      blockedBy: linked(n.id, ['BLOCKS'], 'in').map((x) => x.label),
    }
  }).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))

  // ---------- org chart ----------
  const orgNodes = st.nodes.filter((n) => OWNER_TYPES.has(n.type))
  const orgIds = new Set(orgNodes.map((n) => n.id))
  const orgChart = {
    nodes: orgNodes.map((n) => ({ id: n.id, label: n.label, type: n.type, role: n.description })),
    edges: st.edges.filter((e) => orgIds.has(e.source) && orgIds.has(e.target) && ['REPORTS_TO', 'PART_OF', 'RESPONSIBLE_FOR', 'OWNS'].includes(e.relationship))
      .map((e) => ({ source: e.source, target: e.target, relationship: e.relationship })),
  }

  // ---------- ownership matrix ----------
  const cells: { owner: string; asset: string; assetType: string; relationship: string }[] = []
  for (const e of st.edges) {
    if (!['OWNS', 'RESPONSIBLE_FOR'].includes(e.relationship)) continue
    let o = node.get(e.source), a = node.get(e.target)
    if (o && a && !OWNER_TYPES.has(o.type) && OWNER_TYPES.has(a.type)) [o, a] = [a, o]
    if (o && a && OWNER_TYPES.has(o.type) && ASSET_TYPES.has(a.type)) cells.push({ owner: o.label, asset: a.label, assetType: a.type, relationship: e.relationship })
  }
  const ownedAssets = new Set(cells.map((c) => c.asset))
  const ownership = {
    owners: [...new Set(cells.map((c) => c.owner))].sort(),
    assets: [...ownedAssets].sort(),
    cells,
    unowned: st.nodes.filter((n) => ['SYSTEM', 'COMPONENT', 'PROJECT'].includes(n.type) && !ownedAssets.has(n.label)).map((n) => n.label),
  }

  // ---------- systems & dependencies ----------
  const sysIds = new Set(st.nodes.filter((n) => ['SYSTEM', 'COMPONENT', 'PROCESS'].includes(n.type)).map((n) => n.id))
  const dependencies = {
    nodes: st.nodes.filter((n) => sysIds.has(n.id)).map((n) => ({
      id: n.id, label: n.label, type: n.type, owners: ownersOf(n.id),
      blocked: blockers.some((b) => !DONE.has(b.status) && b.blocks.includes(n.label)),
    })),
    edges: st.edges.filter((e) => sysIds.has(e.source) && sysIds.has(e.target) && FLOW_RELS.has(e.relationship))
      .map((e) => ({ source: e.source, target: e.target, relationship: e.relationship, label: e.label })),
  }

  // ---------- trends: the project as of each meeting ----------
  const meetingDays = [...new Set(sources.map(srcDate))].sort()
  const trend = meetingDays.map((d) => {
    const exists = (n: GraphNode) => firstSeen(n) <= d
    const tasks = byType('TASK').filter(exists).map((n) => asOf(n, d).status ?? 'OPEN')
    const blk = byType('BLOCKER').filter(exists).map((n) => asOf(n, d).status ?? 'OPEN')
    return {
      date: d,
      meetings: sources.filter((s) => srcDate(s) === d).map((s) => s.name),
      openActions: tasks.filter((s) => !DONE.has(s)).length,
      doneActions: tasks.filter((s) => DONE.has(s)).length,
      openBlockers: blk.filter((s) => !DONE.has(s)).length,
      resolvedBlockers: blk.filter((s) => DONE.has(s)).length,
      decisions: byType('DECISION').filter(exists).length,
      entities: st.nodes.filter(exists).length,
    }
  })

  // ---------- change log per source ----------
  const changes = sources.map((s) => {
    const created = st.nodes.filter((n) => firstSource(n) === s.id).map((n) => ({ label: n.label, type: n.type }))
    const statusChanges: { label: string; type: string; from?: string; to: string }[] = []
    const dateChanges: { label: string; from?: string; to: string }[] = []
    for (const n of st.nodes) {
      const h = [...(n.history ?? [])].sort((a, b) => a.asOf.localeCompare(b.asOf))
      h.forEach((e, i) => {
        if (e.sourceId !== s.id) return
        const prevStatus = h.slice(0, i).filter((x) => x.status).at(-1)?.status
        const prevDate = h.slice(0, i).filter((x) => x.date).at(-1)?.date
        if (e.status && prevStatus && e.status !== prevStatus) statusChanges.push({ label: n.label, type: n.type, from: prevStatus, to: e.status })
        if (e.date && prevDate && e.date !== prevDate) dateChanges.push({ label: n.label, from: prevDate, to: e.date })
      })
    }
    return { sourceId: s.id, name: s.name, date: srcDate(s), type: s.type, origin: s.origin, status: s.status, summary: s.summary, created, statusChanges, dateChanges }
  })

  const openActions = actionItems.filter((a) => !DONE.has(a.status))
  const kpis = {
    meetings: sources.filter((s) => s.type !== 'IMAGE').length,
    photos: sources.filter((s) => s.type === 'IMAGE').length,
    people: byType('PERSON').length,
    teams: byType('TEAM').length,
    systems: st.nodes.filter((n) => ['SYSTEM', 'COMPONENT'].includes(n.type)).length,
    openActions: openActions.length,
    overdueActions: openActions.filter((a) => a.overdue).length,
    doneActions: actionItems.length - openActions.length,
    openBlockers: blockers.filter((b) => !DONE.has(b.status)).length,
    resolvedBlockers: blockers.filter((b) => DONE.has(b.status)).length,
    decisions: decisions.length,
    milestones: milestones.length,
    slippedMilestones: milestones.filter((m) => m.slipDays > 0).length,
    unownedSystems: ownership.unowned.length,
    analyzing: st.sources.filter((s) => s.status === 'ANALYZING' || s.status === 'PENDING').length,
  }

  return {
    workspace: st.workspace, today, kpis, actionItems, blockers, decisions, milestones,
    orgChart, ownership, dependencies, trend, changes,
  }
}

export type Views = ReturnType<typeof buildViews>

/** Markdown status report, ready to paste into email / Confluence / Teams. */
export function buildReport(st: WorkspaceState, todayOverride?: string) {
  const v = buildViews(st, todayOverride)
  const k = v.kpis
  const L: string[] = []
  const latest = v.changes.filter((c) => c.status === 'DONE').at(-1)
  L.push(`# ${v.workspace.name}: status report`, '', `_As of ${v.today} · built from ${k.meetings} meeting(s) and ${k.photos} photo(s)_`, '')
  L.push('## Summary', '',
    `| Open actions | Overdue | Open blockers | Decisions | Milestones slipped |`,
    `|---|---|---|---|---|`,
    `| ${k.openActions} | ${k.overdueActions} | ${k.openBlockers} | ${k.decisions} | ${k.slippedMilestones} |`, '')
  if (latest) {
    L.push(`## What changed in the latest update: ${latest.name} (${latest.date})`, '')
    if (latest.summary) L.push(latest.summary, '')
    for (const c of latest.statusChanges) L.push(`- **${c.label}**: ${c.from} → **${c.to}**`)
    for (const c of latest.dateChanges) L.push(`- **${c.label}** moved ${c.from} → **${c.to}**`)
    if (latest.created.length) L.push(`- New: ${latest.created.map((c) => `${c.label} (${c.type.toLowerCase()})`).join(', ')}`)
    L.push('')
  }
  L.push('## Action items', '', '| Status | Action | Owner | Due | Raised |', '|---|---|---|---|---|')
  for (const a of v.actionItems) {
    const st = a.overdue ? '🔴 OVERDUE' : a.status === 'DONE' ? '✅ DONE' : a.status === 'IN_PROGRESS' ? '🟡 IN PROGRESS' : '⚪ OPEN'
    L.push(`| ${st} | ${a.label} | ${a.owners.join(', ') || '_unassigned_'} | ${a.due ?? '-'} | ${a.raisedOn} |`)
  }
  if (!v.actionItems.length) L.push('| | _none recorded_ | | | |')
  L.push('', '## Blockers & risks', '')
  for (const b of v.blockers) {
    const head = DONE.has(b.status) ? `✅ ~~${b.label}~~ (resolved ${b.resolvedOn ?? ''})` : `🔴 **${b.label}** (open ${b.ageDays}d)`
    L.push(`- ${head}${b.blocks.length ? `, blocks ${b.blocks.join(', ')}` : ''}${b.owners.length ? `, owner ${b.owners.join(', ')}` : ''}`)
  }
  if (!v.blockers.length) L.push('- _none recorded_')
  L.push('', '## Milestones', '')
  for (const m of v.milestones) {
    const slip = m.slips.length ? `, ⚠️ slipped ${m.slipDays}d (was ${m.originalDate})` : ''
    L.push(`- **${m.label}**: ${m.date ?? 'no date'} · ${m.status}${slip}${m.blockedBy.length ? `, blocked by ${m.blockedBy.join(', ')}` : ''}`)
  }
  if (!v.milestones.length) L.push('- _none recorded_')
  L.push('', '## Decision log', '')
  for (const d of v.decisions) L.push(`- ${d.date}: **${d.label}**${d.description ? `: ${d.description}` : ''} _(${d.meeting})_`)
  if (!v.decisions.length) L.push('- _none recorded_')
  L.push('', '## Ownership', '')
  for (const o of v.ownership.owners) L.push(`- **${o}**: ${v.ownership.cells.filter((c) => c.owner === o).map((c) => c.asset).join(', ')}`)
  if (v.ownership.unowned.length) L.push(`- ⚠️ No owner recorded: ${v.ownership.unowned.join(', ')}`)
  return L.join('\n')
}
