# OrgMap AI

**Meeting notes in. To-do list out.**

Type what was said in a meeting, or photograph the whiteboard. OrgMap AI works out who does what by when, what was decided and who reports to whom, and keeps that picture up to date as new notes and photos arrive.

- **The AI runs on your laptop.** A local model in [Ollama](https://ollama.com) plus tesseract.js OCR. No OpenAI, Anthropic or Gemini keys; no notes are sent to a hosted LLM. The [public online demo](#online-demo-streamlit-community-cloud) has no AI of its own, so each visitor connects their own key instead (Google Gemini's is free).
- **Cloudinary handles the photos.** Signed upload, storage, CDN delivery, and an on-the-fly copy that is resized, contrast-improved and sharpened for the AI to read. See [Where Cloudinary is used](#where-cloudinary-is-used).
- **It updates, it doesn't start over.** "Ben has booked the venue. Done." ticks off the existing to-do. A later photo adds new ones. Nothing is regenerated from scratch.

---

## The demo

One screen. Typed notes take about 15 to 25 seconds per step, the photo about 40 to 60 seconds (the model first writes out everything on the page). After [setup](#setup):

```powershell
.\start-demo.ps1
```

The browser opens **http://localhost:8501** by itself; if it doesn't, open that address. To let people use it from their own devices, see [Sharing it publicly](#sharing-it-publicly).

### Everyone gets their own board

The page opens on a start screen. Each visitor names a board (optional) and picks **Start with an example** (the guided tour below) or **Start with a blank board** (straight to their own notes). Each board has its own private link, `…/?board=<id>`, shown at the top of the board:

- **Only people with the link can see or change a board.** The page never lists boards, and the id in the link is a random UUID, so boards can't be guessed or browsed.
- **Bookmark the link to come back**, or send it to teammates to work on the same board together.
- **New board** starts another one (the current board stays at its link); **Delete this board** removes it, with its notes and photos, for good.

Everything on a board can be changed: add notes or photos at any time (later notes update the list, e.g. "… Done." ticks a to-do off), or open **Edit the to-do list** and tick off, rename, reassign (several people: `Ben, Maya`), change dates, add rows and delete rows directly, then press **Save changes**. Manual edits and later notes work together: a note can tick off a to-do you renamed by hand.

### The whiteboard-photo tour (Cloudinary first)

**Start with a whiteboard photo** goes straight to a sample phone snapshot of a whiteboard (dim, grey cast, slightly soft, made by [demo/make_whiteboard_photo.py](demo/make_whiteboard_photo.py)). Press **Read the photo** and the page opens with **How Cloudinary handled the photo**:

1. **Uploaded and stored:** the untouched original, with its size.
2. **Prepared for the AI:** the brighter, sharper copy Cloudinary builds on the fly. This is the image the AI reads.
3. **Thumbnail:** smart-cropped around the content.

Below that, every step of the transformation is explained in plain words, read from the actual delivery URL (`c_limit`, `e_improve`, `e_sharpen`, `f_jpg,q_90`), and **What the AI read from Cloudinary's copy** shows the text the to-do list was built from. Then comes the to-do list itself.

### The example

| Step | You do | You see |
|---|---|---|
| 1 | Four plain lines about planning a team offsite are already in the box. Press **Read my notes**. | A to-do list (what, who, by when), the decision, and who reports to whom. |
| 2 | A short update is offered: "Ben has booked the venue. Done. …". Press **Add the update**. | That to-do is struck through, a new one is added, and a banner says what changed. |
| 3 | A whiteboard photo is shown. Press **Read the photo** (or use your own photo or the laptop camera). | Two more to-dos, another one ticked off, and a panel showing exactly what Cloudinary did with the photo. |
| 4 | Type your own line, for example `Sam will write the agenda by Friday.` | It joins the list. |

For the next person, press **New board** (or **Delete this board**). Dates in the prepared notes are computed from today, and the whiteboard says "by Friday", so nothing ever looks stale. From step 2 on, what the latest input added is shown in green and what it changed in orange.

The page runs in presentation mode ([.streamlit/config.toml](.streamlit/config.toml)): no Deploy button, developer menu or Streamlit pop-ups.

### Sharing it publicly

Two ways, both free:

| | Online demo (Streamlit Community Cloud) | From this laptop (Tailscale Funnel) |
|---|---|---|
| Works when | always (wakes in about a minute after 12 quiet hours) | only while the laptop is on and running the demo |
| AI | each visitor's own API key (Gemini, OpenAI, OpenRouter, Groq) | the local model, no key needed |
| Best for | a submission link judges open at any time | live demos, fully local |

### Online demo (Streamlit Community Cloud)

The page starts the OrgMap server itself inside Streamlit's container (Node.js comes from the `nodejs-wheel` package), and asks each visitor to connect their own AI:

1. **Connect your AI:** pick a provider, paste an API key, press **Use this key**. The key is checked with a tiny request, kept in that browser tab's session, sent only with that visitor's own notes and only to that provider's fixed address, and never saved or logged (it's scrubbed from error messages). A free Google Gemini key takes a minute at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), no payment details needed.
2. **Start a board**, exactly as on the laptop.

Boards survive the app being restarted on a fresh disk (after 12 hours asleep, or on redeploy): the server keeps a **private** backup of the database in your Cloudinary account (a raw file downloadable only with your API secret, never by URL) and restores it on startup. Boards untouched for 30 days are deleted, with their photos.

**Deploy (one time, about 5 minutes):**

1. Sign in at [share.streamlit.io](https://share.streamlit.io) with your GitHub account.
2. **Create app** → **Deploy a public app from GitHub**: repository `Mishil449861/Hacktober`, branch `main`, main file path `demo/app.py`. Pick a custom address under **App URL** (e.g. `orgmap-ai` → `https://orgmap-ai.streamlit.app`).
3. **Advanced settings**: Python 3.12, and paste the secrets from [.streamlit/secrets.toml.example](.streamlit/secrets.toml.example) with your Cloudinary values (`ORGMAP_HOSTED = "true"` is what switches on visitor keys and the self-started server).
4. **Deploy.** The first visit installs the server's packages and takes 2 to 3 minutes; later wake-ups about a minute.

Updates: push to `main` and Streamlit reloads the page; the page notices the server is still running the old code (it compares a fingerprint of the code) and restarts it, so no manual reboot is needed. The server's messages appear in **Manage app → logs**, prefixed `[orgmap]`. Visitors never see error details (`showErrorDetails = "none"`).

With Gemini, the server asks for low reasoning effort and leaves the temperature at Google's default (Google warns that lowering it on Gemini 3 can cause looping). **Use this key** checks the key by listing the models it can use, so it answers in about a second and says if the chosen model isn't available.

Limits: up to 2.7 GB of memory; one AI request at a time per app (visitors queue); speed depends on the visitor's provider (Gemini: a few seconds per note).

### From this laptop (Tailscale Funnel)

The page runs on this laptop with its local AI. [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) (free) gives it a permanent public address:

**https://orgmap.tailb4b076.ts.net**

Set up once (already done on this laptop):

```powershell
winget install --id Tailscale.Tailscale                           # sign in when the Tailscale app asks
& "C:\Program Files\Tailscale\tailscale.exe" set --hostname=orgmap  # the "orgmap" part of the address
& "C:\Program Files\Tailscale\tailscale.exe" funnel --bg 8501       # first time: approve Funnel in the page it links to
```

After that, Funnel stays on, including after a restart. To share the demo, just run `.\start-demo.ps1` and send the address; each visitor gets their own board. Check with `tailscale funnel status`; turn it off with `tailscale funnel --https=443 off`.

- **It works only while the laptop is on**, Tailscale is running (it starts with Windows) and the demo is running (`.\start-demo.ps1`). Otherwise visitors get an error page.
- **The address stays the same**, and so do board links. The `tailb4b076` part is your Tailscale network's name; it can be changed once to a friendlier pair of words in the Tailscale admin console (**DNS → Rename tailnet**), but that changes every existing board link.
- **Only the demo page is public.** The OrgMap server (port 8787) and the graph editor (5173) stay on the laptop.
- No Tailscale? A free Cloudflare quick tunnel also works, with a random address that changes on every restart: `winget install --id Cloudflare.cloudflared`, then `& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:8501`.
- **One AI for everyone.** Notes from several visitors are read one at a time, so at busy moments a step waits its turn (photos take about a minute each).
- **No login.** Anyone with a board's link can change it, and visitors' photos go to your Cloudinary account. Boards stay until someone deletes them: tidy up with `DELETE /api/workspaces/<id>`, or remove `data/db.json` while the server is stopped to clear everything.
- **Leaving it unattended** (e.g. while judges test it): `powershell -ExecutionPolicy Bypass -File deploy\windows\install-keep-alive.ps1` adds a task that checks every 5 minutes, and at sign-in, that the model, server, demo page and public link are up, and restarts what isn't (log: `data\logs\keep-alive.log`; undo with `-Remove`). Keep the laptop plugged in: on battery Windows sleeps it after an hour. After a reboot someone has to sign in for the demo to start again.

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
- **In your Cloudinary console:** Media Library → folder `orgmap/<board id>` contains the uploaded photo, named "OrgMap <file name>" (search for "OrgMap"), while the board exists. **Delete this board** deletes the photo and its folder again.
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

It checks that Ollama is running, installs anything missing on first run, starts the server in a **minimized window titled "OrgMap server - keep this window open"**, then starts the demo page and opens the browser. If the server is already running, it reuses it.

To stop: press **Ctrl+C** in the launcher's window (stops the demo page), then close the minimized "OrgMap server" window (stops the server). Closing that window while presenting stops the demo from working.

Or two terminals, both in the project folder:

```powershell
# Terminal 1: the server (API + local model + Cloudinary)
npm run dev

# Terminal 2: the demo page
.venv\Scripts\Activate.ps1           # macOS/Linux: source .venv/bin/activate
npm run demo
```

Then open **http://localhost:8501** (in presentation mode the browser doesn't open by itself). Ollama must be running (it starts with Windows by default; otherwise launch the Ollama app or run `ollama serve`).

| Command | What it does |
|---|---|
| `.\start-demo.ps1` | Checks Ollama, installs what's missing, starts the server and the demo |
| `npm run dev` | Server on `:8787` (auto-reload) and the graph editor on `:5173` |
| `npm run demo` | Demo page on `:8501`; needs `npm run dev` running and the Python environment active |
| `npm test` | Unit tests (no model needed, about 1 second) |
| `npm run test:demo` | Demo page tests (no server or model needed); Python environment active |
| `npm run test:eval` | Extraction accuracy on 6 cases, against the running server and model |
| `npm run test:scenario` | A 4-meeting, 2-photo project, checked end to end |
| `npm run test:handwritten` | Handwritten notes, first meeting then follow-up, as photos and typed, against the running server and model |
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

Dates can be `Oct 10`, `October 10th`, `10 Oct`, `2026-10-10`, `by Friday`, `DUE: Fri`, `due tomorrow`. Longer, formal minutes with headings (`## Action items`, `## Decisions`, `## Risks`, `## Milestones`, `## Updates`) work too; see [tests/fixtures/scenarios](tests/fixtures/scenarios) for examples.

Quick handwritten-style lists work the same way (examples in [tests/fixtures/handwritten](tests/fixtures/handwritten)):

| You write | It becomes |
|---|---|
| `Maya` or `Maya:` with items under it | each item is a to-do for Maya, up to the next name or heading |
| `Maya → Design homepage → Oct 14` | a to-do for Maya, due Oct 14 (`->` works too) |
| `Maya → Design` with `- items` under it | the items are Maya's; "Design" is her area |
| `DUE: Oct 14` under one or more items | their due date (only the items above it in the same group) |
| `✓ landing page DONE`, `→ started`, `~ halfway` | done / in progress; a later meeting updates the existing to-do |
| `Fix login` with `DUE Oct 20` and no name | a to-do with nobody assigned (it is never given to a nearby name) |
| `DECISION:` / `BLOCKER:` with a line under it | a decision / a blocker |
| `- ~~banner ads~~`, or an item crossed out in a photo | nothing: crossed-out items are cancelled, never to-dos |

One empty line separates groups within a person's list; two empty lines or a heading end it.

The same rules apply to photos. The vision model writes down what the photo says, marking the layout (which items sit under which name, ticks, arrows), and that transcript is parsed exactly like typed notes. Tesseract OCR is used instead when it reads printed text better. The vision model also adds what only a picture shows (boxes, arrows, sticky-note columns, org-chart lines).

Crossed-out items in a photo: the model is asked to mark them as `~~text~~`, but in practice `qwen2.5vl` writes the strike line as a long dash glued to the word (`—banner ads`), and tesseract does the same. In text read from a photo, either form is treated as crossed out, and the item is removed from both readings and from the model's own list. Typed notes keep their dashes; only `~~text~~` counts there.

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
                     cleanup: fix relationship directions and types, drop invented dates and owners,
                     drop crossed-out items
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
| `LOCAL_AI_TIMEOUT_MS` | `600000` | how long one model call may take |
| `OCR_ENABLED` | `true` | |
| `ORGMAP_DEBUG` | blank | extraction traces (`data/debug/`, see [Testing](#testing)); blank = on in development, `false` = off |
| `PORT` | `8787` | |
| `HOST` | all interfaces | `127.0.0.1` keeps the API off the network (the cloud setups do this) |
| `DATA_DIR` | `data` | where projects are stored (`data/db.json`) |
| `CLOUDINARY_DISABLED` | | `true` = ignore the Cloudinary keys and store photos locally |
| `ORGMAP_HOSTED` | | `true` (online demo): the page starts the server itself and visitors bring their own AI key |
| `ORGMAP_DB_BACKUP` | | `cloudinary` = keep a private backup of the boards in Cloudinary, restored on startup (on by default when hosted) |
| `BOARD_MAX_AGE_DAYS` | | delete boards untouched for this many days (hosted default: 30) |

---

## Testing

```bash
npm test                 # 67 unit tests: the notes parser, handwritten lists and ownership, crossed-out items,
                         # name matching, validation, relationship fixes, status history, views, visitors'
                         # AI keys (each key only for its own notes, fixed provider addresses, the key check),
                         # Gemini settings, and the backup never being overwritten after a failed restore
npm run test:demo        # 40 tests of the demo page: the to-do list (including to-dos with no date, owner or
                         # status), editing it, boards, crafted board links, the online demo's key flow,
                         # and replacing a server left running from before an update
npm run test:eval        # 6 extraction cases: text, name matching, org chart, process flow, diagram + notes
npm run test:scenario    # a 4-meeting, 2-photo project with 13 checks on the result
npm run test:handwritten # two handwritten photos and two typed notes, first meeting then follow-up
```

`test:eval`, `test:scenario` and `test:handwritten` call the running server and the local model. Their inputs are in [tests/fixtures](tests/fixtures) and [tests/dataset](tests/dataset). Together they take about 10 minutes on an 8 GB GPU. The model's answers vary a little from run to run, so rerun a single failure before treating it as a bug.

They create projects (and upload photos to Cloudinary). To keep them away from your real projects and the demo, run them against a second server with its own data folder:

```powershell
# Terminal 1: a test server on port 8788 with its own data (data-eval/, git-ignored)
$env:PORT='8788'; $env:DATA_DIR='data-eval'; npx tsx server/index.ts

# Terminal 2
$env:ORGMAP_API='http://localhost:8788'
npm run test:eval; npm run test:scenario; npm run test:handwritten
```

Add `$env:CLOUDINARY_DISABLED='true'` in terminal 1 to keep test photos out of Cloudinary. Run one test server at a time: two servers analyzing at once can exhaust 16 GB of RAM.

Last full run (Oct 18, 2026, `qwen2.5vl:7b`): unit 54/54, demo 18/18, eval 6/6 (node and edge recall 100%), scenario 13/13, handwritten photos 36/36 (3 runs in a row) and typed 41/41. Boards (Oct 23): demo 29/29; with the model, two visitors' boards stayed separate, every kind of edit was saved, and the full example passed on a fresh board. Online demo (Oct 24), rehearsed on a fresh clone with no local AI and the page starting the server with `nodejs-wheel`'s Node: every check of the two-visitor test and the full example (including the photo and the Cloudinary panel) passed with visitor keys, and a board survived a wiped disk via the Cloudinary backup. The visitor-key path was tested against an OpenAI-compatible endpoint (Ollama's), not against Gemini itself.

**When a to-do comes out wrong**, look at the source's extraction trace: `GET /api/sources/<id>/trace` (also saved as `data/debug/<id>.json`; on by default in development, `ORGMAP_DEBUG=false` turns it off). It lists, in order, the OCR text, the model's raw reply and its validated form (including the vision transcript), what the notes parser read, the cleaned extraction, the merge report and the resulting to-dos. The first stage where the to-do is wrong is the stage to fix: vision (transcript misread), parser, cleanup, or merge. `npm run test:handwritten` prints these stages for each photo.

---

## Project structure

```
.streamlit/
  config.toml         presentation mode for the demo page
  secrets.toml.example  settings for the online demo (paste into Streamlit Cloud; never commit secrets.toml)
demo/
  app.py              the demo page (Streamlit): start screen, one board per visitor, visitors' AI keys
  client.py           the page's calls to the server, including applying to-do edits
  server_boot.py      starts the server next to the page on the online demo (Node.js from nodejs-wheel)
  todos.py            the to-do table and what an edit changes, tolerant of missing fields (tests: test_todos.py)
  whiteboard.png      the sample photo for step 3 (source: whiteboard.html)
server/
  index.ts            REST API, analysis queue
  cloudinary.ts       signed uploads and the three transformations
  inbox.ts            Cloudinary inbox watcher
  capture.ts          phone capture page (Cloudinary Upload Widget)
  lib/ai/provider.ts  local model abstraction: analyzeImage / analyzeText / reconcileGraph
  lib/ai/runtimes.ts  Ollama and OpenAI-compatible clients, model auto-selection, visitors' keys (withAi)
  backup.ts           private Cloudinary backup of the boards (online demo)
  lib/ai/ocr.ts       tesseract.js OCR
  lib/minutes.ts      deterministic notes parser
  graph/reconcile.ts  merging, duplicate detection, status history
  views.ts            to-dos, decisions, blockers, milestones, reporting lines
  store.ts            JSON-file storage (data/db.json)
src/                  graph editor (React + React Flow, uses @cloudinary/react)
tests/                unit tests, eval cases, fixtures
deploy/cloud/         installer for an Ubuntu server of its own (Ollama on CPU; slow on free hardware)
deploy/windows/       keep-alive task for leaving the laptop demo running unattended
start-demo.ps1        one-command launcher (Windows)
```

The graph editor at `http://localhost:5173` shows the full map behind the to-do list (drag, edit, merge duplicates). It is not needed for the demo.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The OrgMap server isn't running" | The "OrgMap server" window was closed: run `.\start-demo.ps1` again (it only restarts what's missing). Without the launcher, run `npm run dev` in another terminal. |
| The browser didn't open | Open http://localhost:8501 yourself. |
| "The local AI model isn't running" | Start the Ollama app, or run `ollama serve`. |
| `No local vision model found` | `ollama pull qwen2.5vl:7b` |
| The Cloudinary panel says the photo was stored on the laptop | The three `CLOUDINARY_…` values are missing from `.env`. Add them and restart `npm run dev`. |
| `api_secret mismatch` from Cloudinary | Re-copy the secret with the console's copy button: `I` and `l` look identical in its font. |
| A step takes minutes | The model is running on CPU. Check `ollama ps`. |
| A to-do is wrong or missing | Read its extraction trace (see [Testing](#testing)) to find the stage that got it wrong. |
| Node crashes with *out of memory* | Close other heavy apps and keep `OLLAMA_UNLOAD_ON_SWITCH=true`. |
| "Disk is full: changes are not being saved" | Free up disk space; the server keeps running in the meantime. |
| Phone can't open the capture page | Same Wi-Fi? Allow Node through the firewall, and use the IP the server prints, not `localhost`. |

---

## Limitations

- Handwriting depends on the photo. Clear block letters work; cursive or a blurry photo may not.
- Crossed-out items in photos are recognized by how the model writes the strike line (see above). A messier photo or a different model may write it differently and let the item through.
- Free-form sentences outside the patterns above are read by the model and can be misread. Check the result.
- Arrow directions in dense diagrams are occasionally wrong.
- Storage is one JSON file, and there is no login: a board's link is its only key. Don't put confidential notes on a shared demo.
- In the edit table, a due date can be changed but not removed.
- PDFs aren't supported yet; export slides as images.
