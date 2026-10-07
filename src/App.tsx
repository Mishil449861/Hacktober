import { useCallback, useEffect, useRef, useState } from 'react'
import { ReactFlowProvider, type Connection } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'
import { api } from './api'
import { download, toMermaid } from './graph'
import type { SystemStatus, Workspace, WorkspaceState } from './shared/schema'
import { GraphView } from './components/GraphView'
import { AddSourceDialog, EdgeDetails, NodeDetails, setCloudName, SourceDetails, SourcesPanel } from './components/Panels'

type Selection = { kind: 'node' | 'edge' | 'source'; id: string } | undefined

export default function App() {
  const [status, setStatus] = useState<SystemStatus>()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [wsId, setWsId] = useState<string>(() => localStorage.getItem('orgmap.ws') ?? '')
  const [state, setState] = useState<WorkspaceState>()
  const [sel, setSel] = useState<Selection>()
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [layoutTick, setLayoutTick] = useState(0)
  const [fitTick, setFitTick] = useState(0)
  const [focusId, setFocusId] = useState<string>()
  const [toast, setToast] = useState('')

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }
  const fail = (e: unknown) => flash((e as Error).message)

  useEffect(() => {
    api.status().then((s) => { setStatus(s); setCloudName(s.cloudName) }).catch(fail)
    api.workspaces().then((ws) => {
      setWorkspaces(ws)
      if (!ws.find((w) => w.id === wsId)) setWsId(ws[0]?.id ?? '')
    }).catch(fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Only replace state when the payload changed, so live polling does not re-render the graph needlessly.
  const lastJson = useRef('')
  const refresh = useCallback(() => {
    if (!wsId) return Promise.resolve(setState(undefined))
    return api.state(wsId).then((s) => {
      const j = JSON.stringify(s)
      if (j !== lastJson.current) { lastJson.current = j; setState(s) }
    }).catch(fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId])
  useEffect(() => { localStorage.setItem('orgmap.ws', wsId); setSel(undefined); lastJson.current = ''; refresh() }, [wsId, refresh])

  // Live: photos arrive from the Cloudinary inbox at any time, so always poll (faster while analyzing).
  const analyzing = state?.sources.some((s) => s.status === 'ANALYZING' || s.status === 'PENDING')
  useEffect(() => {
    const t = setInterval(refresh, analyzing ? 2000 : 4000)
    return () => clearInterval(t)
  }, [analyzing, refresh])

  // Toast when a new inbox photo shows up.
  const seenSources = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!state) return
    const fresh = state.sources.filter((s) => s.origin === 'inbox' && !seenSources.current.has(s.id))
    if (seenSources.current.size && fresh.length) flash(`New photo from Cloudinary inbox: ${fresh[0].name}`)
    for (const s of state.sources) seenSources.current.add(s.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const createWorkspace = async () => {
    const name = prompt('Workspace name', 'Payments Platform Migration')
    if (!name) return
    const ws = await api.createWorkspace(name)
    setWorkspaces((w) => [...w, ws])
    setWsId(ws.id)
  }

  const act = (fn: () => Promise<unknown>) => () => fn().then(refresh).catch(fail)

  const runSearch = () => {
    const q = search.trim().toLowerCase()
    const hit = q && state?.nodes.find((n) => [n.label, ...n.aliases].some((s) => s.toLowerCase().includes(q)))
    if (hit) { setFocusId(undefined); setTimeout(() => setFocusId(hit.id)); setSel({ kind: 'node', id: hit.id }) }
    else if (q) flash('No matching node')
  }

  const exportGraph = (kind: 'json' | 'mermaid') => {
    if (!state) return
    const slug = state.workspace.name.toLowerCase().replace(/\W+/g, '-')
    if (kind === 'json') download(`${slug}.json`, JSON.stringify(state, null, 2))
    else download(`${slug}.mmd`, toMermaid(state.nodes, state.edges), 'text/plain')
  }

  const node = sel?.kind === 'node' ? state?.nodes.find((n) => n.id === sel.id) : undefined
  const edge = sel?.kind === 'edge' ? state?.edges.find((e) => e.id === sel.id) : undefined
  const source = sel?.kind === 'source' ? state?.sources.find((s) => s.id === sel.id) : undefined
  const reviewCount = state?.nodes.filter((n) => n.possibleDuplicateOf).length ?? 0

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">OrgMap <span>AI</span></div>
        <select value={wsId} onChange={(e) => setWsId(e.target.value)}>
          {!workspaces.length && <option value="">No workspace</option>}
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button onClick={createWorkspace}>New workspace</button>
        <span className="sep" />
        <button className="primary" disabled={!wsId} onClick={() => setAdding(true)}>+ Add Source</button>
        <button disabled={!wsId} onClick={act(async () => flash(`Queued ${(await api.analyzePending(wsId)).queued} source(s)`))}>Analyze</button>
        <button disabled={!state?.nodes.length} onClick={() => setLayoutTick((t) => t + 1)}>Auto Layout</button>
        <input className="search" placeholder="Search nodes…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
        <button onClick={() => setFitTick((t) => t + 1)}>Fit View</button>
        <div className="dropdown">
          <button disabled={!state}>Export ▾</button>
          <div className="menu">
            <button onClick={() => exportGraph('json')}>JSON</button>
            <button onClick={() => exportGraph('mermaid')}>Mermaid</button>
          </div>
        </div>
        <span className="grow" />
        {status?.inbox?.enabled && (
          <a className="capture-link" href={status.inbox.captureUrls[0]} target="_blank" rel="noreferrer"
            title={`Open on a phone (same Wi-Fi):\n${status.inbox.captureUrls.join('\n')}\n\nOr drop photos into Cloudinary folder ${status.inbox.root}/<workspace>`}>
            Phone capture
          </a>
        )}
        {status && (
          <div className={`model-status ${status.reachable ? 'ok' : 'bad'}`} title={status.notes.join('\n')}>
            <b>{status.provider}</b> {status.reachable ? `text: ${status.textModel ?? '—'} · vision: ${status.visionModel ?? 'OCR fallback'}` : 'offline'}
            {' · '}{status.cloudinary ? `Cloudinary: ${status.cloudName}` : 'local storage'}
          </div>
        )}
      </header>

      <main className="layout">
        <SourcesPanel sources={state?.sources ?? []} selectedId={source?.id} onSelect={(id) => setSel({ kind: 'source', id })} onAdd={() => wsId ? setAdding(true) : createWorkspace()} />

        <section className="canvas">
          {!wsId ? (
            <div className="empty"><h2>Create a workspace to start</h2><button className="primary" onClick={createWorkspace}>New workspace</button></div>
          ) : (
            <>
              {!state?.nodes.length && <div className="empty overlay"><p>Add sources to build the map.<br />Each new source is merged into the existing graph.</p></div>}
              <ReactFlowProvider>
                <GraphView
                  nodes={state?.nodes ?? []}
                  edges={state?.edges ?? []}
                  search={search}
                  layoutTick={layoutTick}
                  fitTick={fitTick}
                  focusId={focusId}
                  onSelectNode={(id) => setSel(id ? { kind: 'node', id } : undefined)}
                  onSelectEdge={(id) => setSel(id ? { kind: 'edge', id } : undefined)}
                  onConnect={(c: Connection) => { api.addEdge(wsId, { source: c.source!, target: c.target!, relationship: 'RELATES_TO' }).then(refresh).catch(fail) }}
                  onPositions={(p) => { api.savePositions(p).catch(fail) }}
                />
              </ReactFlowProvider>
              {state && (
                <div className="stats">
                  {state.nodes.length} nodes · {state.edges.length} edges · {state.sources.length} sources
                  {reviewCount > 0 && <span className="warn"> · {reviewCount} to review</span>}
                  {analyzing && <span className="pulse"> · analyzing locally…</span>}
                </div>
              )}
            </>
          )}
        </section>

        <aside className="panel right">
          {node && state ? (
            <NodeDetails
              node={node} nodes={state.nodes} edges={state.edges} sources={state.sources}
              onSave={(patch) => act(() => api.updateNode(node.id, patch))()}
              onDelete={() => confirm(`Delete "${node.label}"?`) && act(() => api.deleteNode(node.id))().then(() => setSel(undefined))}
              onMerge={(intoId) => act(() => api.mergeNode(node.id, intoId))().then(() => setSel({ kind: 'node', id: intoId }))}
              onKeepSeparate={() => act(() => api.updateNode(node.id, { dismissDuplicate: true }))()}
              onSelectNode={(id) => { setSel({ kind: 'node', id }); setFocusId(id) }}
              onSelectSource={(id) => setSel({ kind: 'source', id })}
            />
          ) : edge && state ? (
            <EdgeDetails edge={edge} nodes={state.nodes}
              onSave={(patch) => act(() => api.updateEdge(edge.id, patch))()}
              onDelete={() => act(() => api.deleteEdge(edge.id))().then(() => setSel(undefined))} />
          ) : source ? (
            <SourceDetails s={source}
              onAnalyze={act(() => api.analyzeSource(source.id))}
              onUpdateText={(text) => act(() => api.updateSource(source.id, { text }))()}
              onDelete={() => confirm(`Remove "${source.name}"? Nodes supported only by this source are removed too.`) && act(() => api.deleteSource(source.id))().then(() => setSel(undefined))} />
          ) : (
            <div className="details muted">
              <h3>Details</h3>
              <p>Select a node, relationship or source.</p>
              <p className="small">Drag from a node's right handle to another node to add a relationship. Nodes with a dashed outline may duplicate an existing node and need review.</p>
              {status?.notes.map((n, i) => <p key={i} className="small warn">{n}</p>)}
            </div>
          )}
        </aside>
      </main>

      {adding && wsId && (
        <AddSourceDialog onClose={() => setAdding(false)} onSubmit={async (files, text, name) => { await api.addSources(wsId, files, text, name); await refresh() }} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
