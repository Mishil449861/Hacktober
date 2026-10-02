import { useEffect, useMemo } from 'react'
import {
  Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, useEdgesState, useNodesState,
  useReactFlow, type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import type { GraphEdge, GraphNode } from '../shared/schema'
import { layout, NODE_W, TYPE_COLORS } from '../graph'

type NodeData = { node: GraphNode; highlighted: boolean; dimmed: boolean }

function OrgNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const n = data.node
  const color = TYPE_COLORS[n.type]
  return (
    <div
      className={`org-node${selected ? ' selected' : ''}${data.highlighted ? ' hit' : ''}${data.dimmed ? ' dim' : ''}${n.possibleDuplicateOf ? ' review' : ''}`}
      style={{ width: NODE_W, borderColor: color }}
      title={n.description}
    >
      <Handle type="target" position={Position.Left} />
      <div className="org-node-type" style={{ background: color }}>{n.type}</div>
      <div className="org-node-label">{n.label}</div>
      {n.possibleDuplicateOf && <div className="org-node-flag">possible duplicate</div>}
      {n.sourceIds.length > 1 && <div className="org-node-count" title="Supporting sources">{n.sourceIds.length}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
const nodeTypes = { org: OrgNode }

interface Props {
  nodes: GraphNode[]
  edges: GraphEdge[]
  search: string
  layoutTick: number
  fitTick: number
  focusId?: string
  onSelectNode: (id?: string) => void
  onSelectEdge: (id?: string) => void
  onConnect: (c: Connection) => void
  onPositions: (p: { id: string; x: number; y: number }[]) => void
}

export function GraphView(p: Props) {
  const rf = useReactFlow()
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<NodeData>>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])
  const q = p.search.trim().toLowerCase()

  const hits = useMemo(() => new Set(q ? p.nodes.filter((n) =>
    [n.label, ...n.aliases, n.description ?? ''].some((s) => s.toLowerCase().includes(q))).map((n) => n.id) : []), [p.nodes, q])

  // Sync server graph -> flow, preserving positions the user dragged; lay out only new nodes.
  useEffect(() => {
    const pos = layout(p.nodes, p.edges, true)
    const missing = p.nodes.filter((n) => !n.position)
    setRfNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]))
      return p.nodes.map((n) => ({
        id: n.id, type: 'org',
        position: n.position ?? prevPos.get(n.id) ?? pos.get(n.id)!,
        selected: prev.find((x) => x.id === n.id)?.selected,
        data: { node: n, highlighted: hits.has(n.id), dimmed: q !== '' && !hits.has(n.id) },
      }))
    })
    if (missing.length) p.onPositions(missing.map((n) => ({ id: n.id, ...pos.get(n.id)! })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.nodes, hits, q])

  useEffect(() => {
    setRfEdges(p.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      label: e.label ? `${e.relationship.replace(/_/g, ' ').toLowerCase()}: ${e.label}` : e.relationship.replace(/_/g, ' ').toLowerCase(),
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: e.relationship === 'BLOCKS',
      style: { stroke: e.relationship === 'BLOCKS' ? '#e03131' : undefined, opacity: 0.4 + 0.6 * e.confidence },
      labelBgPadding: [4, 2] as [number, number],
      labelBgStyle: { fill: 'var(--panel)' },
      labelStyle: { fill: 'var(--muted)', fontSize: 10 },
    })))
  }, [p.edges, setRfEdges])

  // Full auto layout on demand.
  useEffect(() => {
    if (!p.layoutTick) return
    const pos = layout(p.nodes, p.edges, false)
    setRfNodes((prev) => prev.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })))
    p.onPositions([...pos.entries()].map(([id, v]) => ({ id, ...v })))
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 400 }), 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.layoutTick])

  useEffect(() => { if (p.fitTick) rf.fitView({ padding: 0.15, duration: 400 }) }, [p.fitTick, rf])

  useEffect(() => {
    if (!p.focusId) return
    const n = rf.getNode(p.focusId)
    if (n) rf.setCenter(n.position.x + NODE_W / 2, n.position.y + 30, { zoom: 1.2, duration: 500 })
  }, [p.focusId, rf])

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, n) => p.onSelectNode(n.id)}
      onEdgeClick={(_, e) => p.onSelectEdge(e.id)}
      onPaneClick={() => { p.onSelectNode(undefined); p.onSelectEdge(undefined) }}
      onConnect={p.onConnect}
      onNodeDragStop={(_, _n, nodes) => p.onPositions(nodes.map((n) => ({ id: n.id, ...n.position })))}
      deleteKeyCode={null}
      fitView
      minZoom={0.1}
    >
      <Background gap={20} />
      <Controls />
      <MiniMap nodeColor={(n) => TYPE_COLORS[(n.data as NodeData).node.type]} pannable zoomable />
    </ReactFlow>
  )
}
