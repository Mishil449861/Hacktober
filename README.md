# OrgMap AI

**Meeting notes in. To-do list out.**

Type what was said in a meeting, or photograph the whiteboard. OrgMap AI works out who does what by when, what was decided and who reports to whom, and keeps that picture up to date as new notes and photos arrive.

- **The AI runs on your laptop.** A local model in [Ollama](https://ollama.com) plus tesseract.js OCR. No OpenAI, Anthropic or Gemini keys; no notes are sent to a hosted LLM.
- **Cloudinary handles the photos.** Signed upload, storage, CDN delivery, and an on-the-fly copy that is resized, contrast-improved and sharpened for the AI to read. See [Where Cloudinary is used](#where-cloudinary-is-used).
- **It updates, it doesn't start over.** "Ben has booked the venue. Done." ticks off the existing to-do. A later photo adds new ones. Nothing is regenerated from scratch.

---

## The demo

One screen, about 15 to 20 seconds per step. After [setup](#setup):

```powershell
.\start-demo.ps1
```

Open **http://localhost:8501**.

| Step | You do | You see |
|---|---|---|
| 1 | Four plain lines about planning a team offsite are already in the box. Press **Read my notes**. | A to-do list (what, who, by when), the decision, and who reports to whom. |
| 2 | A short update is offered: "Ben has booked the venue. Done. …". Press **Add the update**. | That to-do is struck through, a new one is added, and a banner says what changed. |
| 3 | A whiteboard photo is shown. Press **Read the photo** (or use your own photo or the laptop camera). | Two more to-dos, another one ticked off, and a panel showing exactly what Cloudinary did with the photo. |
| 4 | Type your own line, for example `Sam will write the agenda by Friday.` | It joins the list. |

**Start over** resets it for the next person. Dates in the prepared notes are computed from today, and the whiteboard says "by Friday", so nothing ever looks stale.

---

## Where Cloudinary is used

Typed notes never leave the laptop. **Every photo goes through Cloudinary**, and the demo shows the evidence on screen after step 3:

1. **Stored:** the original, uploaded by a signed request from the local server. The API secret stays in `.env` on the server and never reaches the browser.
2. **Prepared for the AI:** a derived copy, made by Cloudinary on the fly. The transformation is readable in the delivery URL the panel prints:
   ```
   https://res.cloudinary.com/<cloud>/image/upload/c_limit,h_1600,w_1600/e_improve/e_sharpen:60/f_jpg,q_90/v1/orgmap/<project>/<id>
   ```
   `c_limit,w_1600,h_1600` caps the size, `e_improve` fixes contrast and colour, `e_sharpen:60` makes handwriting crisper. The local model reads this copy, not the original.
3. **Thumbnail:** `c_fill,g_auto,w_160,h_120`, a smart crop for lists.

Ways to verify it yourself:

- **On screen:** the "What Cloudinary did with the photo" panel shows all three images served from `res.cloudinary.com`, the URL above, the asset's public ID, size and upload time.
- **In your Cloudinary console:** Media Library → folder `orgmap/<project id>` contains the uploaded photo while the demo project exists (**Start over** deletes it again).
- **In the code:** [server/cloudinary.ts](server/cloudinary.ts) (upload and the three transformations), [server/inbox.ts](server/inbox.ts) and [server/capture.ts](server/capture.ts).
- **Turn it off:** remove the Cloudinary keys from `.env` and the panel says the photo was stored on the laptop instead.

Two more Cloudinary features, outside the main demo flow:

- **Phone capture.** `http://<laptop-ip>:8787/capture` opens the Cloudinary Upload Widget on a phone (same Wi-Fi). Photos upload straight from the phone to Cloudinary, signed by the local server.
- **Inbox folder.** Any image dropped into the Cloudinary folder `orgmap-inbox/<project-name>` (Media Library, mobile app, API) is imported and read automatically within 15 seconds.

---

## Requirements

| | Version | Notes |
|---|---|---|
| **Node.js** | 20+ (tested on 24) | |
| **Ollama** | 0.9+ | <https://ollama.com/download> |
| **A vision model** | `qwen2.5vl:7b` recommended (6 GB) | `ollama pull qwen2.5vl:7b` |
| **Python** | 3.10+ | for the demo page |
| **Cloudinary account** | free tier is fine | without it, photos are stored on local disk and the Cloudinary panel says so |
| **Hardware** | 16 GB RAM, 8 GB GPU recommended | runs on CPU too, but slowly |

Other Ollama vision models work as well (`qwen3-vl`, `minicpm-v`, `llava`, `gemma3`); the app picks the best one installed. A local OpenAI-compatible endpoint (LM Studio, llama.cpp, LocalAI) is also supported, see [Configuration](#configuration).

---

## Setup

```bash
git clone <this repo> orgmap-ai
cd orgmap-ai

npm install                          # 1. Node packages
ollama pull qwen2.5vl:7b             # 2. local model, one-time 6 GB download

python -m venv .venv                 # 3. Python environment for the demo page
.venv\Scripts\Activate.ps1           #    macOS/Linux: source .venv/bin/activate
pip install -r demo/requirements.txt

cp .env.example .env                 # 4. configuration (PowerShell: Copy-Item .env.example .env)
```

Put your Cloudinary credentials in `.env` (Cloudinary console → **Settings → API Keys**):

```ini
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=your-api-secret
```

`.env` is git-ignored. On Windows, `.\start-demo.ps1` does steps 1, 3 and 4 for you on first run. If PowerShell refuses to run scripts, use `powershell -ExecutionPolicy Bypass -File .\start-demo.ps1`.

---

## Running

One command (Windows):

```powershell
.\start-demo.ps1
```

Or two terminals, both in the project folder:

```powershell
# Terminal 1: the server (API + local model + Cloudinary)
npm run dev

# Terminal 2: the demo page
.venv\Scripts\Activate.ps1           # macOS/Linux: source .venv/bin/activate
npm run demo
```

Then open **http://localhost:8501**. Ollama must be running (it starts with Windows by default; otherwise launch the Ollama app or run `ollama serve`).

| Command | What it does |
|---|---|
| `.\start-demo.ps1` | Checks Ollama, installs what's missing, starts the server and the demo |
| `npm run dev` | Server on `:8787` (auto-reload) and the graph editor on `:5173` |
| `npm run demo` | Demo page on `:8501`; needs `npm run dev` running and the Python environment active |
| `npm test` | Unit tests (no model needed, about 1 second) |
| `npm run test:eval` | Extraction accuracy on 6 cases, against the running server and model |
| `npm run test:scenario` | A 4-meeting, 2-photo project, checked end to end |
| `npm run typecheck` | TypeScript check |

---

## Writing notes it understands

Plain sentences work. These patterns are read exactly, with no guessing by the model:

| You write | It becomes |
|---|---|
| `- Ben: book the venue by Oct 10` | a to-do for Ben, due Oct 10 |
| `Sam will write the agenda by Friday.` | a to-do for Sam, due the coming Friday |
| `TODO: Chloe: print the name badges` | a to-do for Chloe |
| `Ben has booked the venue. Done.` | the existing "Book the venue" to-do, ticked off |
| `- Decision: lunch will be catered.` | a decision |
| `Chloe reports to Maya.` | a reporting line |
| `The launch moves from Oct 31 to Nov 15.` | the existing milestone, moved, with the slip recorded |

Dates can be `Oct 10`, `October 10th`, `10 Oct`, `2026-10-10`, `by Friday`, `due tomorrow`. Longer, formal minutes with headings (`## Action items`, `## Decisions`, `## Risks`, `## Milestones`, `## Updates`) work too; see [tests/fixtures/scenarios](tests/fixtures/scenarios) for examples.

The same rules apply to photos: text on a whiteboard is read by OCR and parsed the same way, and the vision model adds what only a picture shows (boxes, arrows, sticky-note columns, org-chart lines).

---

## How it works

```
 typed notes ─────────────────────────────┐
                                          ▼
 photo ──► Cloudinary ──► prepared copy ──► OCR (tesseract.js) + vision model (Ollama) + notes parser
           (store, CDN,    (resize,                         │
            thumbnail)      improve, sharpen)               ▼
                                          JSON, schema-validated, one repair retry
                                                            │
                                                            ▼
                     cleanup: fix relationship directions, drop invented dates and owners
                                                            │
                                                            ▼
                     merge into the existing graph: match names ("Auth API" = "Authentication API"),
                     never merge different kinds of thing, flag what is unsure
                                                            │
                                                            ▼
                     stored graph with a history per item (latest meeting wins)
                                                            │
                                                            ▼
                     to-dos · decisions · blockers · milestones · who reports to whom
```

- **The model never writes to storage directly.** Its output is validated, then cleaned up by ordinary code, before anything is merged.
- **Structure is parsed, prose is modelled.** A 7B local model is good at diagrams and loose prose but unreliable at lists of tasks and dates, so a deterministic parser reads those and wins wherever both cover the same thing.
- **One model for text and images.** On an 8 GB GPU, `qwen2.5vl:7b` is 3 to 5 times faster than a larger text model and avoids reloading between a photo and a note.

Code map: [server/lib/ai/provider.ts](server/lib/ai/provider.ts) (`analyzeImage`, `analyzeText`, `reconcileGraph`), [server/lib/minutes.ts](server/lib/minutes.ts) (the parser), [server/graph/reconcile.ts](server/graph/reconcile.ts) (merging), [server/views.ts](server/views.ts) (to-dos, decisions and the rest), [server/cloudinary.ts](server/cloudinary.ts).

---

## Configuration

All in `.env` (see [.env.example](.env.example)):

| Variable | Default | |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | empty | empty = photos stored on local disk |
| `CLOUDINARY_INBOX` | `true` | watch the inbox folder for photos |
| `CLOUDINARY_INBOX_FOLDER` | `orgmap-inbox` | |
| `CLOUDINARY_INBOX_POLL_SECONDS` | `15` | |
| `LOCAL_AI_PROVIDER` | `ollama` | or `lmstudio` (any local OpenAI-compatible server) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | |
| `OLLAMA_MODEL` / `OLLAMA_VISION_MODEL` | auto | pin specific models |
| `OLLAMA_SINGLE_MODEL` | `true` | `false` = separate, slower text model |
| `OLLAMA_UNLOAD_ON_SWITCH` | `true` | keep one model in memory (needed on 16 GB RAM) |
| `LOCAL_AI_BASE_URL` / `LOCAL_AI_MODEL` | | for `lmstudio` |
| `OCR_ENABLED` | `true` | |
| `PORT` | `8787` | |

---

## Testing

```bash
npm test                 # 26 unit tests: the notes parser, name matching, validation, status history
npm run test:eval        # 6 extraction cases: text, name matching, org chart, process flow, diagram + notes
npm run test:scenario    # a 4-meeting, 2-photo project with 13 checks on the result
```

`test:eval` and `test:scenario` call the running server and the local model. Their inputs are in [tests/fixtures](tests/fixtures) and [tests/dataset](tests/dataset).

---

## Project structure

```
demo/
  app.py              the demo page (Streamlit)
  whiteboard.png      the sample photo for step 3 (source: whiteboard.html)
server/
  index.ts            REST API, analysis queue
  cloudinary.ts       signed uploads and the three transformations
  inbox.ts            Cloudinary inbox watcher
  capture.ts          phone capture page (Cloudinary Upload Widget)
  lib/ai/provider.ts  local model abstraction: analyzeImage / analyzeText / reconcileGraph
  lib/ai/runtimes.ts  Ollama and OpenAI-compatible local clients, model auto-selection
  lib/ai/ocr.ts       tesseract.js OCR
  lib/minutes.ts      deterministic notes parser
  graph/reconcile.ts  merging, duplicate detection, status history
  views.ts            to-dos, decisions, blockers, milestones, reporting lines
  store.ts            JSON-file storage (data/db.json)
src/                  graph editor (React + React Flow, uses @cloudinary/react)
tests/                unit tests, eval cases, fixtures
start-demo.ps1        one-command launcher (Windows)
```

The graph editor at `http://localhost:5173` shows the full map behind the to-do list (drag, edit, merge duplicates). It is not needed for the demo.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The OrgMap server isn't running" | Run `npm run dev` in another terminal. |
| "The local AI model isn't running" | Start the Ollama app, or run `ollama serve`. |
| `No local vision model found` | `ollama pull qwen2.5vl:7b` |
| The Cloudinary panel says the photo was stored on the laptop | The three `CLOUDINARY_…` values are missing from `.env`. Add them and restart `npm run dev`. |
| `api_secret mismatch` from Cloudinary | Re-copy the secret with the console's copy button: `I` and `l` look identical in its font. |
| A step takes minutes | The model is running on CPU. Check `ollama ps`. |
| Node crashes with *out of memory* | Close other heavy apps and keep `OLLAMA_UNLOAD_ON_SWITCH=true`. |
| "Disk is full: changes are not being saved" | Free up disk space; the server keeps running in the meantime. |
| Phone can't open the capture page | Same Wi-Fi? Allow Node through the firewall, and use the IP the server prints, not `localhost`. |

---

## Limitations

- Handwriting depends on the photo. Clear block letters work; cursive or a blurry photo may not.
- Free-form sentences outside the patterns above are read by the model and can be misread. Check the result.
- Arrow directions in dense diagrams are occasionally wrong.
- Storage is one JSON file, and there is no login. Run it on a trusted network.
- PDFs aren't supported yet; export slides as images.
