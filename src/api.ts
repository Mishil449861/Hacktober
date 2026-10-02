import type { GraphEdge, GraphNode, Source, SystemStatus, Workspace, WorkspaceState } from './shared/schema'

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body as T
}
const json = (method: string, body?: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
})

export const api = {
  status: () => req<SystemStatus>('/api/status'),
  workspaces: () => req<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string) => req<Workspace>('/api/workspaces', json('POST', { name })),
  deleteWorkspace: (id: string) => req('/api/workspaces/' + id, json('DELETE')),
  state: (id: string) => req<WorkspaceState>('/api/workspaces/' + id),
  addSources: (id: string, files: File[], text?: string, name?: string) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    if (text) fd.append('text', text)
    if (name) fd.append('name', name)
    return req<Source[]>(`/api/workspaces/${id}/sources`, { method: 'POST', body: fd })
  },
  analyzeSource: (id: string) => req<Source>(`/api/sources/${id}/analyze`, json('POST')),
  analyzePending: (wsId: string) => req<{ queued: number }>(`/api/workspaces/${wsId}/analyze`, json('POST')),
  updateSource: (id: string, body: { text?: string; name?: string }) => req<Source>('/api/sources/' + id, json('PATCH', body)),
  deleteSource: (id: string) => req('/api/sources/' + id, json('DELETE')),
  addNode: (wsId: string, body: Partial<GraphNode>) => req<GraphNode>(`/api/workspaces/${wsId}/nodes`, json('POST', body)),
  updateNode: (id: string, body: Partial<GraphNode> & { dismissDuplicate?: boolean }) => req<GraphNode>('/api/nodes/' + id, json('PATCH', body)),
  deleteNode: (id: string) => req('/api/nodes/' + id, json('DELETE')),
  mergeNode: (fromId: string, intoId: string) => req(`/api/nodes/${fromId}/merge`, json('POST', { intoId })),
  savePositions: (positions: { id: string; x: number; y: number }[]) => req('/api/positions', json('POST', { positions })),
  addEdge: (wsId: string, body: Partial<GraphEdge>) => req<GraphEdge>(`/api/workspaces/${wsId}/edges`, json('POST', body)),
  updateEdge: (id: string, body: Partial<GraphEdge>) => req<GraphEdge>('/api/edges/' + id, json('PATCH', body)),
  deleteEdge: (id: string) => req('/api/edges/' + id, json('DELETE')),
}
