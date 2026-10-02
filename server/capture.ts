/**
 * Mobile capture page (served at /capture). Open it on a phone on the same Wi-Fi, snap the
 * whiteboard / meeting notes, and the photo goes straight to Cloudinary's inbox folder via the
 * Upload Widget (signed by this server). The inbox watcher then imports and analyzes it.
 */
export function capturePage(cfg: { cloudName: string; apiKey: string; enabled: boolean }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OrgMap Capture</title>
<style>
  :root { --bg:#f6f7f9; --panel:#fff; --text:#1d2229; --muted:#6b7480; --accent:#4c6ef5; --ok:#2f9e44; --err:#e03131; --border:#e3e6ea; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14171c; --panel:#1c2027; --text:#e6e9ee; --muted:#8b95a3; --border:#2c323b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width:520px; margin:0 auto; padding:20px 16px 40px; display:flex; flex-direction:column; gap:14px; }
  h1 { font-size:22px; margin:0; } h1 span { color:var(--accent); }
  p { margin:0; color:var(--muted); }
  select, button { font:inherit; width:100%; padding:12px; border-radius:10px; border:1px solid var(--border); background:var(--panel); color:var(--text); }
  button.big { background:var(--accent); color:#fff; border:none; font-size:20px; font-weight:600; padding:22px; }
  button:disabled { opacity:.5; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:12px; }
  .folder { font-family:ui-monospace, monospace; font-size:13px; color:var(--muted); word-break:break-all; }
  ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
  li { display:flex; gap:10px; align-items:center; }
  li img { width:56px; height:42px; object-fit:cover; border-radius:6px; background:var(--bg); }
  .st { font-size:13px; } .DONE { color:var(--ok); } .ERROR { color:var(--err); } .ANALYZING, .PENDING { color:var(--accent); }
  .name { flex:1; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #msg { min-height:1.2em; }
  label.fallback { display:block; text-align:center; color:var(--muted); font-size:14px; text-decoration:underline; cursor:pointer; }
</style>
</head><body><main>
  <h1>OrgMap <span>Capture</span></h1>
  <p>Photograph whiteboards, sticky notes or slides. They upload to Cloudinary and the shared map updates automatically.</p>
  <select id="ws"></select>
  <div class="folder" id="folder"></div>
  <button class="big" id="snap" ${cfg.enabled ? '' : 'disabled'}>📷 Take photo of notes</button>
  <label class="fallback">or upload through this laptop instead<input type="file" id="file" accept="image/*" capture="environment" multiple hidden></label>
  <p id="msg">${cfg.enabled ? '' : 'Cloudinary is not configured on the server.'}</p>
  <div class="card"><strong>Recent photos</strong><ul id="recent"><li><p>None yet</p></li></ul></div>
</main>
<script src="https://upload-widget.cloudinary.com/latest/global/all.js"></script>
<script>
const CLOUD = ${JSON.stringify(cfg.cloudName)}, API_KEY = ${JSON.stringify(cfg.apiKey)};
const $ = (id) => document.getElementById(id);
let folder = '', widget;
const msg = (t, color) => { $('msg').textContent = t; $('msg').style.color = color || ''; };
const wsId = () => $('ws').value;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadWorkspaces() {
  const list = await fetch('/api/workspaces').then((r) => r.json());
  const saved = localStorage.getItem('orgmap.capture.ws');
  $('ws').innerHTML = list.map((w) => '<option value="' + w.id + '">' + esc(w.name) + '</option>').join('') || '<option value="">No workspace yet</option>';
  if (list.some((w) => w.id === saved)) $('ws').value = saved;
  else if (list.length) $('ws').value = list[list.length - 1].id;
  await selectWs();
}
async function selectWs() {
  if (!wsId()) return;
  try { localStorage.setItem('orgmap.capture.ws', wsId()); } catch {}
  const r = await fetch('/api/workspaces/' + wsId() + '/inbox').then((r) => r.json());
  folder = r.folder;
  $('folder').textContent = 'Cloudinary folder: ' + folder;
  widget = undefined;
  refresh();
}
async function refresh() {
  if (!wsId()) return;
  const s = await fetch('/api/workspaces/' + wsId()).then((r) => r.json()).catch(() => null);
  if (!s) return;
  const photos = s.sources.filter((x) => x.type === 'IMAGE').slice(-6).reverse();
  if (!photos.length) return;
  const label = { PENDING: 'queued', ANALYZING: 'analyzing…', DONE: '✓ on the map', ERROR: '✕ failed' };
  $('recent').innerHTML = photos.map((p) =>
    '<li><img src="' + esc(p.thumbUrl || '') + '" alt=""><span class="name">' + esc(p.name) + '</span><span class="st ' + p.status + '">' + label[p.status] + '</span></li>').join('');
}

function openWidget() {
  if (!folder) return msg('Create a workspace in the app first.', 'var(--err)');
  if (!window.cloudinary) return msg('Upload widget did not load (offline?). Use the fallback link.', 'var(--err)');
  widget ??= cloudinary.createUploadWidget({
    cloudName: CLOUD, apiKey: API_KEY, folder,
    sources: ['camera', 'local'], multiple: true, clientAllowedFormats: ['png', 'jpg', 'jpeg', 'webp', 'heic'],
    uploadSignature: (cb, params) => fetch('/api/cloudinary/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params_to_sign: params }) })
      .then((r) => r.json()).then((d) => d.signature ? cb(d.signature) : msg(d.error || 'Signing failed', 'var(--err)')),
  }, (err, res) => {
    if (err) return msg('Upload failed: ' + (err.statusText || err.message || err), 'var(--err)');
    if (res.event === 'success') {
      msg('Uploaded to Cloudinary ✓. Updating the map…', 'var(--ok)');
      fetch('/api/inbox/poll', { method: 'POST' }).then(refresh);
    }
  });
  widget.open();
}

$('snap').onclick = openWidget;
$('ws').onchange = selectWs;
$('file').onchange = async (e) => {
  const fd = new FormData();
  for (const f of e.target.files) fd.append('files', f);
  msg('Uploading…');
  const r = await fetch('/api/workspaces/' + wsId() + '/sources', { method: 'POST', body: fd });
  msg(r.ok ? 'Uploaded ✓. Updating the map…' : 'Upload failed', r.ok ? 'var(--ok)' : 'var(--err)');
  refresh();
};
loadWorkspaces().catch((e) => msg('Cannot reach OrgMap server: ' + e.message, 'var(--err)'));
setInterval(refresh, 4000);
</script>
</body></html>`
}
