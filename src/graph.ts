import dagre from 'dagre'
import type { GraphEdge, GraphNode, NodeType } from './shared/schema'

export const NODE_W = 190
export const NODE_H = 64

export const TYPE_COLORS: Record<NodeType, string> = {
  PERSON: '#e8590c', TEAM: '#d6336c', PROJECT: '#7048e8', SYSTEM: '#1c7ed6', COMPONENT: '#1098ad',
  PROCESS: '#37b24d', DECISION: '#f59f00', MILESTONE: '#ae3ec9', BLOCKER: '#e03131', TASK: '#0c8599', DOCUMENT: '#868e96', OTHER: '#495057',
}

/** Left-to-right dagre layout. When `onlyMissing`, nodes the user already placed stay put. */
export function layout(nodes: GraphNode[], edges: GraphEdge[], onlyMissing: boolean) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 90, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  const out = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    if (onlyMissing && n.position) { out.set(n.id, n.position); continue }
    const p = g.node(n.id)
    out.set(n.id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 })
  }
  return out
}

export function toMermaid(nodes: GraphNode[], edges: GraphEdge[]) {
  const id = new Map(nodes.map((n, i) => [n.id, `n${i}`]))
  const esc = (s: string) => s.replace(/"/g, "'")
  return [
    'graph LR',
    ...nodes.map((n) => `  ${id.get(n.id)}["${esc(n.label)}<br/><small>${n.type}</small>"]`),
    ...edges.map((e) => `  ${id.get(e.source)} -->|${esc(e.label || e.relationship)}| ${id.get(e.target)}`),
  ].join('\n')
}

export function download(name: string, content: string, type = 'application/json') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([content], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}
