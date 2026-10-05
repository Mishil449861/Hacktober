# OrgMap AI

**Turn meeting minutes, whiteboard photos and architecture diagrams into one live map of your project: who owns what, what's blocked, what was decided, and what's overdue.**

Someone photographs the whiteboard after a meeting, or pastes the minutes. OrgMap AI reads it with a **local** vision/language model and **merges** it into a persistent knowledge graph. It never regenerates the graph from scratch. The dashboard updates by itself: action items with owners and due dates, open blockers, milestone slips, the org chart, and a status report ready to paste into email.

- 🔒 **Runs entirely on your machine.** Models run in [Ollama](https://ollama.com); OCR uses tesseract.js. No OpenAI/Anthropic/Gemini keys, nothing sent to a hosted LLM.
- ☁️ **Cloudinary for images.** Upload, storage, CDN thumbnails, and an analysis copy that is resized, contrast-improved and sharpened. Phone photos dropped into a Cloudinary folder are picked up automatically.
- 🧠 **Incremental merge.** "Auth API" in a later meeting is matched to the existing "Authentication API". "The PCI audit is done" resolves the existing blocker. "Launch moves to Nov 15" records a slip.

---

## Contents

- [Demo in 5 minutes](#demo-in-5-minutes)
- [Requirements](#requirements)
- [Setup](#setup)
- [Running](#running)
- [Using it](#using-it)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Demo in 5 minutes

After [setup](#setup), one command starts everything (Windows PowerShell):

```powershell
.\start-demo.ps1
```

Or run the two parts yourself, see [Running](#running). Everything happens on this one laptop; no phone or second machine is needed.

In the dashboard (http://localhost:8501):

1. In the sidebar open **➕ New project**, choose **Start from → Payments Platform Migration**, and click **Create project**.
2. On **➕ Add notes**, under **Sample story**, click **Add next** four times. Each click feeds one meeting's minutes (and a whiteboard or sprint-board photo for two of them) to the local model, about 30–90 s each.
3. Watch **📊 Dashboard** after each meeting:

| Meeting | What the dashboard shows |
|---|---|
| Sep 8, Kickoff | 3 action items with owners and due dates, 2 milestones, the reporting lines |
| Sep 15, Architecture review + whiteboard photo | Raj's action is **done**, the **PCI audit blocker** is raised, the architecture from the photo is added to the map |
| Sep 22, Weekly sync | A new latency risk, Tom joins, new actions are assigned |
| Sep 29, Steering committee + sprint-board photo | PCI blocker **resolved**, Checkout launch **slips 15 days**, a new vendor risk, the sprint board marks tasks done, an **overdue** load-test |

4. **📄 Status report** has a Markdown report to download or paste.
5. **Add something live** under **Your notes**: type a line such as `- Tom Becker: finish the load test (due 2026-10-15)`, upload a photo, or switch on **Use this laptop's camera** and photograph a whiteboard.

A second, non-software story (**Office Relocation**) ships as well. The full graph editor (drag nodes, merge duplicates, edit relationships) is the web app at **http://localhost:5173**.

### Make your own demo

**Any project, live.** Create a blank project with any name and add notes under **Your notes**: paste text, upload `.md` / `.txt` files and photos, or use the laptop camera. Nothing else is required.

**A scripted story you can click through.** Add a folder to `demo/scenarios/`. Files are grouped into steps by their leading number:

```
demo/scenarios/q4-product-launch/
  01-kickoff.md              minutes for step 1
  02-design-review.md        minutes for step 2 ...
  02-whiteboard.jpg          ... with a photo (any number of images share the step's number)
  03-sprint-board.png        a photo on its own
```

- The first heading sets the names: `# Q4 Product Launch: Kickoff` → project "Q4 Product Launch", step "Kickoff".
- A line `**Date:** 2026-10-01` dates the meeting; later meetings override earlier ones. Without it, today's date is used.
- See [Minutes format that works best](#minutes-format-that-works-best) for the patterns that are read exactly.

The story appears in the dashboard within 10 seconds, under **➕ New project → Start from** and under **Sample story**. No code changes are needed.

---

## Requirements

| | Version | Notes |
|---|---|---|
| **Node.js** | 20+ (tested on 24) | |
| **Ollama** | 0.9+ | <https://ollama.com/download> |
| **A vision model** | `qwen2.5vl:7b` recommended (6 GB) | `ollama pull qwen2.5vl:7b` |
| **Python** | 3.10+ | only for the Streamlit demo |
| **Cloudinary account** | free tier is fine | optional; without it images are stored on local disk |
| **Hardware** | 16 GB RAM, 8 GB GPU recommended | runs on CPU too, but slowly |

Other Ollama vision models work as well (`qwen3-vl`, `minicpm-v`, `llava`, `gemma3`). The app picks the best one installed. An LM Studio / llama.cpp / LocalAI OpenAI-compatible **local** endpoint is also supported, see [Configuration](#configuration).

---

## Setup

```bash
git clone <this repo> orgmap-ai
cd orgmap-ai

# 1. Node dependencies
npm install

# 2. Local model (one-time download, about 6 GB)
ollama pull qwen2.5vl:7b

# 3. Python environment for the demo dashboard
python -m venv .venv
.venv\Scripts\Activate.ps1          # macOS/Linux: source .venv/bin/activate
pip install -r demo/requirements.txt

# 4. Configuration
cp .env.example .env                # Windows PowerShell: Copy-Item .env.example .env
```

On Windows, `.\start-demo.ps1` does steps 1, 3 and 4 for you on first run. If PowerShell refuses to run scripts, use `powershell -ExecutionPolicy Bypass -File .\start-demo.ps1`, or allow scripts for your user once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

Then edit `.env`. Everything has a working default. Only fill in Cloudinary if you want cloud image storage and phone capture:

```ini
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=your-api-secret
```

These are in the Cloudinary console under **Settings → API Keys**. The secret is used only on the server (signed uploads); it never reaches the browser. `.env` is git-ignored.

---

## Running

Two terminals, both in the project folder:

```powershell
# Terminal 1: API server + web app
npm run dev

# Terminal 2: demo dashboard
.venv\Scripts\Activate.ps1          # macOS/Linux: source .venv/bin/activate
npm run demo
```

Then open **http://localhost:8501**. Ollama must be running (it starts with Windows by default; otherwise launch the Ollama app or run `ollama serve`).

| Command | What it does |
|---|---|
| `.\start-demo.ps1` | Windows: checks Ollama, installs what's missing, starts the server and the dashboard |
| `npm run dev` | API server (`:8787`, auto-reload) + web app (`:5173`) |
| `npm run demo` | Streamlit dashboard (`:8501`), needs `npm run dev` running and the Python environment active |
| `npm start` | Production: build the web app, serve everything from `:8787` |
| `npm test` | Unit tests (no model needed, about 1 s) |
| `npm run test:eval` | Extraction accuracy on 6 cases against the running server + model |
| `npm run test:scenario` | The full 4-meeting demo story, checked end to end |
| `npm run typecheck` | TypeScript check for client + server |

On startup the server prints the model it selected and the phone-capture URL:

```
OrgMap AI server on http://localhost:8787 (cloudinary: on)
[inbox] watching Cloudinary folder "orgmap-inbox/<workspace>" every 15s
[capture] phone page: http://192.168.1.23:8787/capture
```

---

## Using it

### Add knowledge

- **Paste minutes or notes**, or upload `.txt` / `.md` files.
- **Upload images** (`.jpg .png .webp`): whiteboards, architecture diagrams, slides, sprint boards, org charts.
- **Phone capture:** open `http://<laptop-ip>:8787/capture` on a phone (same Wi-Fi), pick the project, tap **Take photo of notes**.
- **Straight into Cloudinary:** drop images into the folder `orgmap-inbox/<project-name-slug>` (Media Library or the Cloudinary mobile app). They are imported within 15 s.

### Minutes format that works best

Free-form prose works. These conventions are parsed exactly (no model guesswork):

```markdown
**Date:** 2026-09-29
**Attendees:** Sarah Chen (Program Director), Raj Patel

## Action items
- Raj Patel: provision the Redis Cache (due 2026-09-25)

## Decisions
- Decision: keep the legacy Ledger running until cutover.

## Risks
- Fraud vendor contract: expires 2026-10-20, not renewed yet. It blocks the Fraud Check process.

## Milestones
- Checkout launch: 2026-10-31

## Updates
- PCI audit: completed. The blocker is resolved.
- The Checkout launch moves from 2026-10-31 to 2026-11-15.
- Priya Shah joins the Payments Team and reports to Ana Silva.
```

### Update and correct

- **Edit a past meeting's minutes:** whatever only that meeting said is retracted, and the new version is merged in. Status changes it made are rolled back too.
- **Possible duplicates** show a dashed outline in the web app, with **Merge** / **Keep separate** buttons.
- **Manual edits** to labels, types, statuses and relationships happen in the web app's right panel.

---

## How it works

```
 photo / minutes ──► Cloudinary (store, thumbnail, 1600px sharpened analysis copy)
                         │
                         ▼
             ┌──────────────────────────┐
             │ tesseract.js OCR (local) │
             │ qwen2.5vl via Ollama     │──► JSON (Zod-validated, 1 repair retry)
             │ minutes parser (exact)   │
             └──────────────────────────┘
                         │
                         ▼
     cleanup: fix edge directions, fold "X latency" into X, drop leaked dates
                         │
                         ▼
     reconcile with the existing graph:
       exact / alias / fuzzy match → model adjudicates the unsure band →
       still unsure → flagged for the user. Types must be compatible.
                         │
                         ▼
     persistent graph (data/db.json): nodes, edges, provenance per source,
     status/date history per meeting (latest meeting wins)
                         │
                         ▼
     views: action items · blockers · milestones/slips · decisions ·
            org chart · ownership · trends · Markdown status report
```

**Design choices**

- **The model never writes to storage directly.** Its output is schema-validated, then cleaned up deterministically before anything is merged.
- **Structure is parsed, prose is modelled.** A 7B local model is good at diagrams and prose relationships but unreliable at long structured minutes. Sections, `Owner: task (due …)`, `X reports to Y` and status updates are handled by a deterministic parser that wins where both overlap.
- **One model for everything** (`OLLAMA_SINGLE_MODEL=true`). On an 8 GB GPU, `qwen2.5vl:7b` handles text too. That's 3–5× faster than a 14B text model and avoids reloading models between a photo and the minutes.
- **No webhooks needed.** A localhost app can't receive Cloudinary webhooks, so the server polls the inbox folder with one Admin API call per poll.

Code map: [server/lib/ai/provider.ts](server/lib/ai/provider.ts) (`analyzeImage` / `analyzeText` / `reconcileGraph`), [server/lib/minutes.ts](server/lib/minutes.ts), [server/graph/reconcile.ts](server/graph/reconcile.ts), [server/views.ts](server/views.ts).

---

## Configuration

All in `.env` (see [.env.example](.env.example)):

| Variable | Default | |
|---|---|---|
| `LOCAL_AI_PROVIDER` | `ollama` | or `lmstudio` (any local OpenAI-compatible server) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | |
| `OLLAMA_MODEL` / `OLLAMA_VISION_MODEL` | auto | pin specific models |
| `OLLAMA_SINGLE_MODEL` | `true` | `false` = separate text model (e.g. `qwen3:14b`), slower |
| `OLLAMA_NUM_CTX` | `16384` | upper bound; smallest fitting context is used |
| `OLLAMA_UNLOAD_ON_SWITCH` | `true` | keep one model in memory (needed on 16 GB RAM) |
| `LOCAL_AI_BASE_URL` / `LOCAL_AI_MODEL` | | for `lmstudio` |
| `OCR_ENABLED` | `true` | |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | empty | empty = local disk storage |
| `CLOUDINARY_INBOX` | `true` | watch the inbox folder for phone photos |
| `CLOUDINARY_INBOX_FOLDER` | `orgmap-inbox` | |
| `CLOUDINARY_INBOX_POLL_SECONDS` | `15` | |
| `PORT` | `8787` | |

---

## Testing

```bash
npm test                 # 22 deterministic tests: matching, schema validation, relationship fixes,
                         # minutes parser on the demo minutes, status history, dashboard views
npm run test:eval        # 6 extraction cases (text, alias merge, org chart, process flow, diagram + notes)
npm run test:scenario    # 4 meetings + 2 photos, 13 checks on the resulting dashboard
```

The eval and scenario tests call the running server and the local model. To keep them out of your real data, run them against an isolated server:

```bash
# PowerShell
$env:PORT='8788'; $env:DATA_DIR='data-eval'; $env:CLOUDINARY_DISABLED='true'; npx tsx server/index.ts
$env:ORGMAP_API='http://localhost:8788'; npm run test:scenario
```

---

## Project structure

```
server/
  index.ts            REST API, analysis queue, source lifecycle
  lib/ai/provider.ts  local model abstraction: analyzeImage / analyzeText / reconcileGraph
  lib/ai/runtimes.ts  Ollama + OpenAI-compatible local clients, model auto-selection
  lib/ai/ocr.ts       tesseract.js OCR
  lib/minutes.ts      deterministic meeting-minutes parser
  graph/reconcile.ts  merge into the persistent graph, duplicate detection, status history
  graph/text.ts       label normalization + similarity
  views.ts            dashboard views + Markdown status report
  cloudinary.ts       signed uploads, analysis/preview/thumbnail transformations
  inbox.ts            Cloudinary inbox watcher (phone photos → sources)
  capture.ts          mobile capture page (Cloudinary Upload Widget)
  store.ts            JSON-file persistence (data/db.json)
src/                  React + React Flow graph editor (web app)
  shared/schema.ts    types + Zod schemas shared by client and server
demo/
  streamlit_app.py    dashboard demo: any project, sample stories, webcam capture
  scenarios/          sample stories: one folder each (payments-migration, office-relocation)
  requirements.txt    Python packages for the dashboard
tests/                unit tests, extraction eval dataset, end-to-end scenario
start-demo.ps1        one-command launcher (Windows)
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Local model runtime is not reachable` | Start Ollama (`ollama serve`, or launch the app). |
| `No local vision model found` | `ollama pull qwen2.5vl:7b`. Without one, images fall back to OCR + text model. |
| Node crashes with *out of memory* / `spawn UNKNOWN` | RAM is exhausted. Keep `OLLAMA_UNLOAD_ON_SWITCH=true`, close other heavy apps, and don't run two OrgMap servers analyzing at once. |
| Analysis is slow (minutes per source) | The model is running on CPU. Check `ollama ps`, use `OLLAMA_SINGLE_MODEL=true`, or a smaller model. |
| Phone can't open the capture page | Same Wi-Fi? Allow Node through the Windows firewall (private networks). Use the IP the server prints, not `localhost`. |
| `api_secret mismatch` from Cloudinary | Re-copy the secret with the console's copy button: `I` and `l` look identical in its font. |
| `Port 5173 is in use` | Another `npm run dev` is already running; use that one or stop it. |
| `Failed to load PostCSS config … not valid JSON` | A JSON file was saved with a UTF-8 BOM (PowerShell 5 `Set-Content`). Re-save it as UTF-8 without BOM. |

---

## Limitations

- Handwriting recognition depends on the vision model and photo quality. Printed text and clean diagrams work best.
- Arrow direction in dense diagrams is occasionally wrong. Fix it in the web app (edit or delete the edge).
- Storage is a single JSON file, which is fine for a team or project but not multi-tenant.
- No authentication. Run it on a trusted network. The capture page can only upload into the inbox folder.
- PDF input isn't supported yet. Export slides as images.
