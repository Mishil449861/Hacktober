import { useEffect, useState } from 'react'
import { AdvancedImage } from '@cloudinary/react'
import { Cloudinary } from '@cloudinary/url-gen'
import { fill } from '@cloudinary/url-gen/actions/resize'
import { autoGravity } from '@cloudinary/url-gen/qualifiers/gravity'
import { format, quality } from '@cloudinary/url-gen/actions/delivery'
import { auto } from '@cloudinary/url-gen/qualifiers/format'
import { auto as autoQ } from '@cloudinary/url-gen/qualifiers/quality'
import { limitFit } from '@cloudinary/url-gen/actions/resize'
import {
  NODE_TYPES, RELATIONSHIP_TYPES, type GraphEdge, type GraphNode, type NodeType, type RelationshipType, type Source,
} from '../shared/schema'
import { TYPE_COLORS } from '../graph'

let cld: Cloudinary | undefined
export function setCloudName(name?: string) {
  cld = name ? new Cloudinary({ cloud: { cloudName: name } }) : undefined
}

function SourceImage({ s, size }: { s: Source; size: 'thumb' | 'preview' }) {
  if (cld && s.cloudinary) {
    const img = cld.image(s.cloudinary.publicId)
    if (size === 'thumb') img.resize(fill().width(96).height(72).gravity(autoGravity()))
    else img.resize(limitFit().width(800))
    img.delivery(format(auto())).delivery(quality(autoQ()))
    return <AdvancedImage cldImg={img} className={size} alt={s.name} />
  }
  const url = size === 'thumb' ? s.thumbUrl : s.previewUrl
  return url ? <img src={url} className={size} alt={s.name} /> : null
}

const STATUS_ICON: Record<Source['status'], string> = { PENDING: '○', ANALYZING: '◌', DONE: '✓', ERROR: '✕' }

export function SourcesPanel(p: {
  sources: Source[]
  selectedId?: string
  onSelect: (id: string) => void
  onAdd: () => void
}) {
  return (
    <aside className="panel left">
      <div className="panel-head">
        <h2>Sources</h2>
        <button className="primary small" onClick={p.onAdd}>+ Add Source</button>
      </div>
      {p.sources.length === 0 && <p className="muted pad">No sources yet. Add a whiteboard photo, diagram, slide or notes.</p>}
      <ul className="source-list">
        {[...p.sources].reverse().map((s) => (
          <li key={s.id} className={s.id === p.selectedId ? 'active' : ''} onClick={() => p.onSelect(s.id)}>
            <span className={`status ${s.status.toLowerCase()}`} title={s.status}>{STATUS_ICON[s.status]}</span>
            {s.type === 'IMAGE' ? <SourceImage s={s} size="thumb" /> : <span className="doc-icon">{s.type === 'TEXT' ? '¶' : 'MD'}</span>}
            <span className="source-name" title={s.name}>{s.name}</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}

export function SourceDetails({ s, onAnalyze, onDelete, onUpdateText }: {
  s: Source; onAnalyze: () => void; onDelete: () => void; onUpdateText: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(s.text ?? '')
  useEffect(() => { setEditing(false); setDraft(s.text ?? '') }, [s.id, s.text])
  return (
    <div className="details">
      <div className="eyebrow">{s.type.replace('_', ' ')} source</div>
      <h3>{s.name}</h3>
      <div className={`badge ${s.status.toLowerCase()}`}>{s.status}</div>
      {s.type === 'IMAGE' && <SourceImage s={s} size="preview" />}
      {s.cloudinary && (
        <dl className="meta">
          <dt>Public ID</dt><dd>{s.cloudinary.publicId}</dd>
          <dt>Size</dt><dd>{s.cloudinary.width}×{s.cloudinary.height} {s.cloudinary.format}</dd>
          <dt>Original</dt><dd><a href={s.cloudinary.secureUrl} target="_blank" rel="noreferrer">open</a></dd>
        </dl>
      )}
      {s.error && <p className="error">{s.error}</p>}
      {s.summary && <><h4>Summary</h4><p>{s.summary}</p></>}
      {s.analyzedWith && <p className="muted small">Analyzed with {s.analyzedWith}</p>}
      {!!s.ambiguities?.length && <><h4>Ambiguities</h4><ul>{s.ambiguities.map((a, i) => <li key={i}>{a}</li>)}</ul></>}
      {s.type !== 'IMAGE' && (editing ? (
        <>
          <textarea rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <p className="muted small">Saving replaces this source's contribution to the map: facts only it asserted are removed, then the new text is merged.</p>
          <div className="row">
            <button className="primary" disabled={draft === s.text || s.status === 'ANALYZING'} onClick={() => { onUpdateText(draft); setEditing(false) }}>Save & re-analyze</button>
            <button onClick={() => { setDraft(s.text ?? ''); setEditing(false) }}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <details><summary>Text</summary><pre>{s.text}</pre></details>
          <button onClick={() => setEditing(true)} disabled={s.status === 'ANALYZING'}>Edit text</button>
        </>
      ))}
      {s.ocrText && <details><summary>OCR text</summary><pre>{s.ocrText}</pre></details>}
      <div className="row">
        <button onClick={onAnalyze} disabled={s.status === 'ANALYZING'}>{s.status === 'DONE' ? 'Re-analyze' : 'Analyze'}</button>
        <button className="danger" onClick={onDelete}>Remove</button>
      </div>
    </div>
  )
}

export function NodeDetails(p: {
  node: GraphNode
  nodes: GraphNode[]
  edges: GraphEdge[]
  sources: Source[]
  onSave: (patch: Partial<GraphNode>) => void
  onDelete: () => void
  onMerge: (intoId: string) => void
  onKeepSeparate: () => void
  onSelectNode: (id: string) => void
  onSelectSource: (id: string) => void
}) {
  const n = p.node
  const [label, setLabel] = useState(n.label)
  const [type, setType] = useState<NodeType>(n.type)
  const [desc, setDesc] = useState(n.description ?? '')
  const [mergeInto, setMergeInto] = useState('')
  useEffect(() => { setLabel(n.label); setType(n.type); setDesc(n.description ?? ''); setMergeInto('') }, [n])
  const byId = new Map(p.nodes.map((x) => [x.id, x]))
  const dup = n.possibleDuplicateOf && byId.get(n.possibleDuplicateOf.nodeId)
  const out = p.edges.filter((e) => e.source === n.id)
  const inc = p.edges.filter((e) => e.target === n.id)
  const dirty = label !== n.label || type !== n.type || desc !== (n.description ?? '')

  return (
    <div className="details">
      <div className="eyebrow" style={{ color: TYPE_COLORS[n.type] }}>{n.type} · confidence {Math.round(n.confidence * 100)}%</div>
      {dup && (
        <div className="review-box">
          <strong>Possible duplicate</strong>
          <p>Is <b>{n.label}</b> the same as <b>{dup.label}</b>? ({Math.round(n.possibleDuplicateOf!.score * 100)}% similar)</p>
          <div className="row">
            <button className="primary" onClick={() => p.onMerge(dup.id)}>Merge into “{dup.label}”</button>
            <button onClick={p.onKeepSeparate}>Keep separate</button>
          </div>
        </div>
      )}
      <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      <label>Type
        <select value={type} onChange={(e) => setType(e.target.value as NodeType)}>
          {NODE_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </label>
      <label>Description<textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <div className="row">
        <button className="primary" disabled={!dirty} onClick={() => p.onSave({ label, type, description: desc })}>Save</button>
        <button className="danger" onClick={p.onDelete}>Delete node</button>
      </div>
      {!!n.aliases.length && <><h4>Also known as</h4><p>{n.aliases.join(', ')}</p></>}
      <h4>Relationships</h4>
      <ul className="rel-list">
        {out.map((e) => <li key={e.id}>→ <i>{e.relationship}</i> <a onClick={() => p.onSelectNode(e.target)}>{byId.get(e.target)?.label}</a></li>)}
        {inc.map((e) => <li key={e.id}>← <a onClick={() => p.onSelectNode(e.source)}>{byId.get(e.source)?.label}</a> <i>{e.relationship}</i></li>)}
        {!out.length && !inc.length && <li className="muted">none</li>}
      </ul>
      <h4>Evidence ({n.sourceIds.length})</h4>
      <ul className="rel-list">
        {n.sourceIds.map((id) => <li key={id}><a onClick={() => p.onSelectSource(id)}>{p.sources.find((s) => s.id === id)?.name ?? id}</a></li>)}
        {!n.sourceIds.length && <li className="muted">added manually</li>}
      </ul>
      <h4>Merge into another node</h4>
      <div className="row">
        <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
          <option value="">Choose…</option>
          {p.nodes.filter((x) => x.id !== n.id).sort((a, b) => a.label.localeCompare(b.label)).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <button disabled={!mergeInto} onClick={() => p.onMerge(mergeInto)}>Merge</button>
      </div>
    </div>
  )
}

export function EdgeDetails(p: { edge: GraphEdge; nodes: GraphNode[]; onSave: (patch: Partial<GraphEdge>) => void; onDelete: () => void }) {
  const [rel, setRel] = useState<RelationshipType>(p.edge.relationship)
  const [label, setLabel] = useState(p.edge.label ?? '')
  useEffect(() => { setRel(p.edge.relationship); setLabel(p.edge.label ?? '') }, [p.edge])
  const name = (id: string) => p.nodes.find((n) => n.id === id)?.label
  return (
    <div className="details">
      <div className="eyebrow">Relationship · confidence {Math.round(p.edge.confidence * 100)}%</div>
      <h3>{name(p.edge.source)} → {name(p.edge.target)}</h3>
      <label>Type<select value={rel} onChange={(e) => setRel(e.target.value as RelationshipType)}>{RELATIONSHIP_TYPES.map((r) => <option key={r}>{r}</option>)}</select></label>
      <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="free-form label" /></label>
      <div className="row">
        <button className="primary" onClick={() => p.onSave({ relationship: rel, label })}>Save</button>
        <button className="danger" onClick={p.onDelete}>Delete edge</button>
      </div>
    </div>
  )
}

export function AddSourceDialog(p: { onClose: () => void; onSubmit: (files: File[], text: string, name: string) => Promise<void> }) {
  const [tab, setTab] = useState<'files' | 'text'>('files')
  const [files, setFiles] = useState<File[]>([])
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [drag, setDrag] = useState(false)
  const accept = '.jpg,.jpeg,.png,.webp,.txt,.md'
  const submit = async () => {
    setBusy(true); setErr('')
    try { await p.onSubmit(tab === 'files' ? files : [], tab === 'text' ? text : '', name); p.onClose() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="modal-bg" onClick={p.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add Source</h2>
        <div className="tabs">
          <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>Upload files</button>
          <button className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}>Paste text</button>
        </div>
        {tab === 'files' ? (
          <label
            className={`drop${drag ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); setFiles([...files, ...Array.from(e.dataTransfer.files)]) }}
          >
            <input type="file" multiple accept={accept} hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
            <div>Drop images (.jpg .png .webp) or notes (.txt .md) here, or click to browse</div>
            {files.map((f, i) => <div key={i} className="file-chip">{f.name}</div>)}
          </label>
        ) : (
          <>
            <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <textarea rows={10} placeholder="Paste meeting notes, a project update, a process description…" value={text} onChange={(e) => setText(e.target.value)} />
          </>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row end">
          <button onClick={p.onClose}>Cancel</button>
          <button className="primary" disabled={busy || (tab === 'files' ? !files.length : !text.trim())} onClick={submit}>
            {busy ? 'Uploading…' : 'Add & Analyze'}
          </button>
        </div>
      </div>
    </div>
  )
}
