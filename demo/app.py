"""
OrgMap AI demo: one screen, one board per visitor.

Plain meeting notes go in; a to-do list (who, what, by when), the decisions and who reports to whom
come out. Later notes and whiteboard photos update it, and the to-do list can be edited directly.
Photos are stored and transformed by Cloudinary, and the page shows exactly what Cloudinary did.

Each visitor gets their own board, reached by a private link (?board=<id>). The page never lists
boards, so nobody can browse anyone else's; the board id in the link is the key.

The AI is the local model when the server has one (the laptop setup). A hosted copy (Streamlit Community
Cloud, ORGMAP_HOSTED=true) has none: there each visitor brings their own API key, which stays in their
browser session and is sent with their notes only, and the page starts the server itself (server_boot.py).

    npm run dev     # terminal 1: API + local model
    npm run demo    # terminal 2: this page (http://localhost:8501)
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import secrets
import time
from pathlib import Path

import pandas as pd
import requests
import streamlit as st

from client import API, api, apply_edits
from cloudinary_info import explain, size_text, transformation
from server_boot import ensure_server, replace_if_outdated
from todos import (CHANGED_COLOR, NEW_COLOR, changes_by_item, editor_rows, friendly, md_text, plan_edits, short,
                   todo_table)

# The sample photo: the whiteboard as a quick phone snapshot looks (dim, grey cast, soft), so Cloudinary's
# clean-up is visible side by side. Made from whiteboard.png by make_whiteboard_photo.py.
WHITEBOARD = Path(__file__).parent / "whiteboard-photo.jpg"

today = dt.date.today()


# The two prepared notes of the example. Dates are computed from today so the story always reads as current.
FIRST_DAY = today - dt.timedelta(days=3)
NOTE_1 = f"""Maya is planning the team offsite. Ben reports to Maya.
- Ben: book the venue by {short(today + dt.timedelta(days=2))}
- Maya: send the invitations by {short(today + dt.timedelta(days=5))}
- Decision: the offsite is on {short(today + dt.timedelta(days=19))}."""
NOTE_2 = f"""Ben has booked the venue. Done.
Chloe joins the team and reports to Maya.
- Chloe: order the catering by {short(today + dt.timedelta(days=9))}
- Decision: lunch will be catered."""


# A board's tour, kept in its link: "example" (two notes, then a photo) or "photo" (the whiteboard photo first:
# shows Cloudinary at work straight away). None = a blank board.
TOURS = ("example", "photo")


def open_board(board_id: str, tour: str | None) -> None:
    st.query_params.from_dict({"board": board_id, **({tour: "1"} if tour in TOURS else {})})
    st.session_state.pop("edit_version", None)
    st.rerun()


def create_board(name: str, tour: str | None) -> None:
    # A short random suffix keeps boards with the same name apart (e.g. in Cloudinary's inbox folders).
    ws = api("POST", "/api/workspaces", json={"name": f"{name.strip() or 'My board'} · {secrets.token_hex(2)}"})
    open_board(ws["id"], tour)


def board_link(board_id: str, tour: str | None) -> str:
    base = (getattr(st.context, "url", "") or "").split("?")[0]
    # Streamlit Community Cloud serves the page inside its own frame at "<app>/~/+/": link to the app itself.
    base = re.sub(r"/~/\+/?$", "/", base)
    return f"{base}?board={board_id}" + (f"&{tour}=1" if tour in TOURS else "")


@st.cache_data(ttl=3600, show_spinner=False)
def image_bytes(url: str) -> int | None:
    """Size of an image as Cloudinary delivers it (for "339 KB -> 167 KB"); None if unknown."""
    try:
        r = requests.get(url, timeout=15)
        return len(r.content) if r.ok else None
    except requests.RequestException:
        return None


def cloudinary_panel(p: dict) -> None:
    """What Cloudinary did with a photo, at a glance: the photo and the cleaned-up copy the AI read, side by
    side. The details (each transformation in plain words, read from the actual delivery URL; sizes; the
    thumbnail; what the AI read) are one click away, not in the way."""
    cld = p.get("cloudinary")
    if not cld:
        st.caption("This photo was stored on the server itself (Cloudinary isn't configured).")
        return
    clean = lambda u: (u or "").split("?")[0]  # noqa: E731  (drop the SDK analytics suffix)
    original, prepared, thumb = cld["secureUrl"], clean(p.get("analysisUrl") or p["previewUrl"]), clean(p["thumbUrl"])
    st.subheader("Cloudinary prepared the photo for the AI")
    a, b = st.columns(2)
    a.image(original, caption="Your photo")
    b.image(prepared, caption="Cloudinary's copy: resized, brighter, sharper. This is what the AI read.")

    with st.expander("How Cloudinary did it"):
        sizes = [image_bytes(u) for u in (original, prepared, thumb)]
        rows = ["| In the address | What Cloudinary does |", "|---|---|"]
        rows += [f"| `{s}` | {explain(s)} |" for s in transformation(prepared)]
        st.markdown("\n".join(rows))
        st.code(prepared, language=None, wrap_lines=True)
        st.caption("Built on the fly from the original the first time the address is requested, then served from "
                   "Cloudinary's CDN. The original was uploaded by the OrgMap server with a signed request: the API "
                   "secret never reaches the browser."
                   + (f" Sizes: original {size_text(sizes[0])}, copy {size_text(sizes[1])}, thumbnail {size_text(sizes[2])}."
                      if all(sizes) else ""))
        t1, t2 = st.columns([1, 4])
        t1.image(thumb)
        t2.caption("Thumbnail: " + "; ".join(e[:1].lower() + e[1:] for e in map(explain, transformation(thumb))) + ".")
        st.caption(f"Cloud **{status.get('cloudName')}** · asset `{cld['publicId']}` · uploaded "
                   f"{cld['createdAt'][:16].replace('T', ' ')} UTC · [open the original]({original})")
    if p.get("ocrText"):
        with st.expander("What the AI read from the photo"):
            st.text(p["ocrText"][:3000])
            st.caption(f"Read with: {p.get('analyzedWith') or 'the AI'}. The to-do list was built from this.")


# Board ids are UUIDs. Anything else in the link is refused before it reaches a server address
# (e.g. "?board=../workspaces" would otherwise ask for the list of every board).
BOARD_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def error_text(e: Exception) -> str:
    """The server's own message from client.api's "<status>: <body>" error; a plain sentence for network trouble."""
    if isinstance(e, requests.Timeout):
        return "the OrgMap server took too long to answer. Try again in a minute."
    if isinstance(e, requests.RequestException):
        return "the OrgMap server couldn't be reached. Refresh the page in a minute."
    body = str(e).split(": ", 1)[-1]
    try:
        return str(json.loads(body).get("error") or body)
    except (ValueError, AttributeError):
        return body


def ai_key() -> dict | None:
    """The visitor's AI key for this browser session, if they gave one."""
    k = st.session_state.get("ai")
    return k if k and k.get("key") else None


def ai_fields() -> dict:
    """Form fields that send the visitor's key with their notes (nothing when they gave none)."""
    k = ai_key()
    return {"ai_provider": k["provider"], "ai_key": k["key"], "ai_model": k["model"]} if k else {}


def read(ws_id: str, date: dt.date, text: str = "", photo: tuple | None = None) -> bool:
    stamp = time.strftime("%H:%M:%S")
    try:
        if text.strip():
            api("POST", f"/api/workspaces/{ws_id}/sources",
                data={"text": text, "name": f"Notes {stamp}", "date": date.isoformat(), **ai_fields()})
        if photo:
            api("POST", f"/api/workspaces/{ws_id}/sources", data={"date": date.isoformat(), **ai_fields()}, files={"files": photo})
    except Exception as e:  # noqa: BLE001  (server said no, timed out, or is restarting)
        st.error(f"Couldn't add that: {error_text(e)}")
        return False
    where = "with your AI key" if ai_key() else "on this laptop"
    with st.spinner(f"Reading {where}… usually 15 to 40 seconds, about a minute for a photo. "
                    "If other people are adding notes at the same time, yours waits its turn."):
        deadline = time.time() + 600
        while time.time() < deadline:
            time.sleep(1.5)
            try:
                s = api("GET", f"/api/workspaces/{ws_id}")
            except Exception:  # noqa: BLE001  (one slow answer while the server is busy: just ask again)
                continue
            if not any(x["status"] in ("ANALYZING", "PENDING") for x in s["sources"]):
                return True
    st.warning("Still reading after 10 minutes. It will appear on the board when done: refresh the page later.")
    return False


def ai_panel(providers: list[dict], required: bool) -> None:
    """Where a visitor connects their own AI: provider, key, model, and a check that the key works."""
    if not providers:
        return
    labels = {p["id"]: p["label"] for p in providers}
    current = ai_key() or {}
    ids = list(labels)
    provider = st.selectbox("AI provider", ids, format_func=lambda i: labels[i] + (" (free key, no card)" if i == "gemini" else ""),
                            index=ids.index(current["provider"]) if current.get("provider") in ids else 0, key="ai-provider")
    p = next(x for x in providers if x["id"] == provider)
    if p.get("keyUrl"):
        st.markdown(f"Don't have a key? [Get one from {p['label']}]({p['keyUrl']}) (takes a minute), then paste it here.")
    key = st.text_input("API key", type="password", value=current.get("key", "") if current.get("provider") == provider else "",
                        key=f"ai-key-{provider}", placeholder="Paste your API key")
    model = st.text_input("Model", value=(current.get("model") if current.get("provider") == provider else None) or p.get("defaultModel") or "",
                          key=f"ai-model-{provider}", placeholder="Model name from your provider",
                          help="The default is a fast model that reads photos too. Any vision-capable model works.")
    st.caption("Your key stays in this browser tab: it is sent only with your own notes, to "
               f"{p['label']} only, and is never saved. Close the tab and it's gone.")
    c1, c2 = st.columns([1, 3])
    if c1.button("Use this key", type="primary" if required else "secondary", disabled=not (key.strip() and model.strip()), key="ai-save"):
        with st.spinner("Checking the key…"):
            try:
                r = api("POST", "/api/ai/check", data={"ai_provider": provider, "ai_key": key.strip(), "ai_model": model.strip()})
            except Exception as e:  # noqa: BLE001  (never show a raw traceback for a key check)
                r = {"ok": False, "error": error_text(e)}
        if r.get("ok"):
            st.session_state["ai"] = {"provider": provider, "key": key.strip(), "model": model.strip(), "label": p["label"]}
            st.session_state["flash"] = f"Connected: {p['label']} ({model.strip()}). Your notes will be read with your key."
            st.rerun()
        else:
            c2.error(f"That key didn't work: {r.get('error', 'unknown error')[:300]}")
    if current and c2.button("Forget my key", key="ai-forget"):
        st.session_state.pop("ai", None)
        st.rerun()


def own_photo(key: str) -> tuple[str, bytes] | None:
    """Upload or camera. Returns (filename, bytes)."""
    up = st.file_uploader("Photo", type=["png", "jpg", "jpeg", "webp"], label_visibility="collapsed", key=f"up-{key}")
    shot = st.camera_input("Take a photo", key=f"cam-{key}") if st.toggle("Use the camera", key=f"camtoggle-{key}") else None
    if up:
        return (up.name, up.getvalue())
    if shot:
        return (f"camera {time.strftime('%H-%M-%S')}.jpg", shot.getvalue())
    return None


# ------------------------------------------------------------------ page
st.set_page_config(page_title="OrgMap AI", layout="centered")

# Streamlit Community Cloud keeps the app's settings in st.secrets. Copy the plain ones into the environment,
# where this page and the server it starts (server_boot.py) read them. No secrets file (the laptop): nothing to do.
try:
    for _k, _v in st.secrets.items():
        if isinstance(_v, (str, int, float, bool)):
            os.environ.setdefault(_k, str(_v))
except Exception:  # noqa: BLE001
    pass

HOSTED = os.environ.get("ORGMAP_HOSTED", "").strip().lower() in ("1", "true", "yes")


try:
    status = api("GET", "/api/status")
except Exception:  # noqa: BLE001
    if not HOSTED:
        st.error("The OrgMap server isn't running. Start it with `npm run dev`, then refresh this page.")
        st.stop()
    # Hosted copy: start the server inside this container (again, if it stopped). ensure_server is cheap
    # when it's already up, and only one session at a time can start it.
    with st.spinner("Starting OrgMap… the first visit after a quiet spell takes 1 to 3 minutes."):
        try:
            ensure_server(API)
            status = api("GET", "/api/status")
        except Exception as e:  # noqa: BLE001
            st.error(f"OrgMap couldn't start: {e}. Refresh the page in a minute to try again.")
            st.stop()
if HOSTED:
    # A server started before an update still runs the old code: replace it (once per old version).
    with st.spinner("Updating OrgMap…"):
        try:
            if replace_if_outdated(API, status):
                status = api("GET", "/api/status")
        except Exception as e:  # noqa: BLE001
            st.error(f"OrgMap couldn't restart after an update: {e}. Refresh the page in a minute.")
            st.stop()

local_ai = bool(status.get("reachable"))
providers = status.get("aiProviders") or []
need_key = not local_ai  # no AI of its own: each visitor brings a key
if need_key and not providers:
    st.error("The local AI model isn't running. Start the Ollama app, then refresh this page.")
    st.stop()

st.title("Meeting notes in. To-do list out.")

board_id = st.query_params.get("board")
tour = next((t for t in TOURS if st.query_params.get(t) == "1"), None)
example, photo_tour = tour == "example", tour == "photo"

# ---- start screen: no board yet
if not board_id:
    ai_where = ("The AI runs on the demo's own computer" if local_ai
                else "The AI is yours: you connect it with your own API key")
    st.caption("Type what was said in a meeting, or photograph the whiteboard. OrgMap AI works out who does what by "
               f"when and keeps it up to date. {ai_where}; photos are stored and prepared by Cloudinary.")
    st.markdown(
        "**How it works**\n\n"
        "1. Write down what was said in a meeting, or add a photo of the whiteboard.\n"
        "2. The AI turns it into a to-do list: who does what, by when. Plus decisions and who reports to whom.\n"
        "3. Add more notes later and the list updates itself. You can also edit it yourself.")
    if flash := st.session_state.pop("flash", None):
        st.success(flash)
    if need_key:
        st.subheader("1. Connect your AI")
        if ai_key():
            st.success(f"Connected: {ai_key()['label']} ({ai_key()['model']}).")
            with st.expander("Change or forget the key"):
                ai_panel(providers, required=False)
        else:
            st.markdown("This public demo has no AI of its own, so it uses yours. The free Google Gemini key is "
                        "the quickest: no payment details needed.")
            ai_panel(providers, required=True)
        st.subheader("2. Start your board")
    st.info("You get **your own board** with a private link. Nobody else can see or change it unless you share that link.")
    name = st.text_input("Name your board (optional)", placeholder="e.g. Team offsite", max_chars=60)
    c1, c2, c3 = st.columns(3)
    if c1.button("Start with a whiteboard photo", type="primary", width="stretch",
                 help="See Cloudinary prepare a whiteboard photo for the AI, and the to-do list it becomes."):
        create_board(name or "Whiteboard board", "photo")
    if c2.button("Start with an example", width="stretch",
                 help="A guided tour: two prepared notes and a whiteboard photo, then your own."):
        create_board(name or "Example board", "example")
    if c3.button("Start with a blank board", width="stretch", help="Straight to your own notes."):
        create_board(name or "My board", None)
    st.stop()

# ---- a board
try:
    if not BOARD_ID.match(str(board_id)):
        raise RuntimeError("404: not a board link")
    state = api("GET", f"/api/workspaces/{board_id}")
except RuntimeError:
    st.warning("This board doesn't exist any more. It may have been deleted, or the link is incomplete.")
    if st.button("Make a new board", type="primary"):
        st.query_params.clear()
        st.rerun()
    st.stop()

ws_id = board_id
views = api("GET", f"/api/workspaces/{ws_id}/views")
sources = state["sources"]
done = [c for c in views["changes"] if c["status"] == "DONE"]
failed = [c for c in views["changes"] if c["status"] == "ERROR"]
stage = len(views["changes"])  # sources read so far; drives the example's steps
items = views.get("actionItems") or []
guided = (example and stage < 3) or (photo_tour and stage < 1)
photos = [s for s in sources if s["type"] == "IMAGE"]

with st.expander(f"Your board: {state['workspace']['name']}  ·  share or bookmark it"):
    st.caption("Only people with this link can see and edit this board:")
    st.code(board_link(board_id, tour), language=None, wrap_lines=True)

# Notes and photos need an AI: the visitor's key when the demo has none of its own.
blocked = need_key and not ai_key()
if blocked:
    with st.container(border=True):
        st.markdown("**Connect your AI to read notes and photos.** This public demo has no AI of its own, so it "
                    "uses yours. The free Google Gemini key is the quickest. (Editing the to-do list works without one.)")
        ai_panel(providers, required=True)
elif ai_key():
    with st.expander(f"AI: {ai_key()['label']} ({ai_key()['model']}), with your key. Change or forget it"):
        ai_panel(providers, required=False)

if flash := st.session_state.pop("flash", None):
    st.success(flash)

# The AI couldn't be used for the latest input (bad key, quota, outage): say so, and why.
latest_src = max(sources, key=lambda s: s.get("createdAt") or "", default=None)
if latest_src and "failed" in (latest_src.get("analyzedWith") or ""):
    why = next((a for a in latest_src.get("ambiguities") or [] if "failed (" in a), "")
    st.warning("The AI couldn't be used for your latest input, so only the parts written in a fixed format "
               "(like \"Name: task by Friday\") were picked up." + (f"\n\nWhat the AI said: {md_text(why)}" if why else "")
               + ("\n\nCheck your key above, or try again in a minute." if need_key else ""))

# ---- results
if stage or items:
    latest = done[-1] if done else None
    if stage >= 2 and latest and (latest["statusChanges"] or latest["created"] or latest["dateChanges"]):
        lines = [f"**{md_text(c['label'])}** is now {c['to'].replace('_', ' ').lower()}" for c in latest["statusChanges"]]
        lines += [f"**{md_text(c['label'])}** moved to {friendly(c['to'])}" for c in latest["dateChanges"]]
        new = [md_text(c["label"]) for c in latest["created"] if c["type"] in ("TASK", "DECISION", "PERSON", "BLOCKER")]
        if new:
            lines.append("New: " + ", ".join(new))
        what = "the photo" if latest["type"] == "IMAGE" else "the latest notes"
        st.success(f"**What {what} changed**\n\n" + "\n\n".join(lines))

    # From the second input on, mark what the latest one added (green) and changed (orange). On the first
    # notes everything is new, so nothing is marked.
    change = latest if stage >= 2 else None
    marks = changes_by_item(change)
    st.subheader("To-do list")
    table, unreadable = todo_table(items, change)
    if table:
        st.markdown(table)
        if marks:
            st.caption(f":{NEW_COLOR}[■ added] and :{CHANGED_COLOR}[■ changed] by the latest notes")
    else:
        st.caption("No to-dos found yet.")
    if unreadable:
        st.caption(f"{unreadable} to-do(s) had no text and aren't shown.")

    # The photo the latest to-dos came from, as Cloudinary prepared it for the AI (details on request).
    if photos:
        cloudinary_panel(photos[-1])

# ---- edit the to-do list directly (also the way to start a list without notes)
with st.expander("Edit the to-do list",
                 expanded=not guided and not stage and not items):
    version = st.session_state.get("edit_version", 0)
    frame = pd.DataFrame(editor_rows(items), columns=["id", "done", "todo", "who", "due"])
    edited = st.data_editor(
        frame, key=f"edit-{board_id}-{version}", num_rows="dynamic", hide_index=True, width="stretch",
        column_order=["done", "todo", "who", "due"],
        column_config={
            "done": st.column_config.CheckboxColumn("Done", width="small", default=False),
            "todo": st.column_config.TextColumn("To-do", width="large", max_chars=120),
            "who": st.column_config.TextColumn("Who", help="One name, or several separated by commas"),
            "due": st.column_config.DateColumn("By when", format="ddd, MMM D"),
        },
    )
    st.caption("Change any cell, add a row at the bottom, or select rows to delete. Then press **Save changes**.")
    if st.button("Save changes", type="primary"):
        ops = plan_edits(items, edited.to_dict("records"))
        if ops:
            apply_edits(ws_id, ops)
            st.session_state["edit_version"] = version + 1
            st.session_state["flash"] = f"Saved {len(ops)} change{'s' if len(ops) != 1 else ''} to the to-do list."
            st.rerun()
        else:
            st.info("Nothing to save: the table is unchanged.")

# Decisions, blockers and reporting lines: only what the notes actually contained (no empty "None yet" boxes).
people = {n["id"]: n["label"] for n in views["orgChart"]["nodes"] if n["type"] == "PERSON"}
reports = [(e["source"], e["target"]) for e in views["orgChart"]["edges"]
           if e["relationship"] == "REPORTS_TO" and e["source"] in people and e["target"] in people]
open_blockers = [b for b in views["blockers"] if b["status"] == "OPEN"]
if views["decisions"] or open_blockers or reports:
    marks = changes_by_item(done[-1] if stage >= 2 and done else None)
    left, right = st.columns(2) if reports and (views["decisions"] or open_blockers) else (st.container(), st.container())
    with left:
        if views["decisions"]:
            st.subheader("Decisions")
            for d in reversed(views["decisions"]):
                label = md_text(d["label"])
                if (marks.get(d.get("id")) or marks.get(d["label"].lower()) or {}).get("new"):
                    st.markdown(f"- :{NEW_COLOR}[{label}] :{NEW_COLOR}-badge[New]")
                else:
                    st.markdown(f"- {label}")
        if open_blockers:
            st.subheader("Blockers")
            for b in open_blockers:
                label = f"**{md_text(b['label'])}**"
                if (marks.get(b.get("id")) or marks.get(b["label"].lower()) or {}).get("new"):
                    label = f":{NEW_COLOR}[{label}] :{NEW_COLOR}-badge[New]"
                st.markdown(f"- {label}" + (f" (blocks {md_text(', '.join(b['blocks']))})" if b["blocks"] else ""))
    if reports:
        with right:
            st.subheader("Who's who")
            dot = ['digraph G { rankdir=BT; bgcolor="transparent"; node [shape=box style="rounded,filled" fillcolor=white '
                   'color="#2a78d6" penwidth=2 fontname=Helvetica fontsize=12]; edge [color="#898781" arrowsize=0.7];']
            # People the latest notes introduced get a green box.
            new_style = ' fillcolor="#e6f4ea" color="#1e8e3e"'
            dot += [f'"{i}" [label="{name.replace(chr(34), "")}"{new_style if (marks.get(i) or {}).get("new") else ""}];'
                    for i, name in people.items() if any(i in r for r in reports)]
            dot += [f'"{a}" -> "{b}";' for a, b in reports]
            dot.append("}")
            st.graphviz_chart("\n".join(dot))
            st.caption("Arrows point to the person someone reports to.")

if failed:
    st.warning("One of the inputs couldn't be read. Try adding it again, or type the to-dos into the table above.")
st.divider()

# ---- input: the example's guided steps, or free notes
if example and stage == 0:
    st.subheader("1. Here are some notes from a meeting")
    text = st.text_area("Notes", NOTE_1, height=150, key="notes-0", label_visibility="collapsed")
    st.caption("Change anything you like, or just press the button." + (" Connect your AI above first." if blocked else ""))
    if st.button("Read my notes", type="primary", disabled=blocked or not text.strip()) and read(ws_id, FIRST_DAY, text):
        st.rerun()

elif example and stage == 1:
    st.subheader("2. A few days later, there's an update")
    text = st.text_area("Notes", NOTE_2, height=150, key="notes-1", label_visibility="collapsed")
    st.caption("Watch the to-do list above: Ben's task gets ticked off and Chloe's is added.")
    if st.button("Add the update", type="primary", disabled=blocked or not text.strip()) and read(ws_id, today, text):
        st.rerun()

elif (example and stage == 2) or (photo_tour and stage == 0):
    st.subheader("1. After a meeting, someone photographs the whiteboard" if photo_tour
                 else "3. Then someone photographs the whiteboard")
    st.image(str(WHITEBOARD), width=460)
    st.caption("Cloudinary cleans it up, then the AI reads it." + (" Connect your AI above first." if blocked else ""))
    mine = None
    with st.expander("Use my own photo instead (handwritten notes, a whiteboard, sticky notes)"):
        mine = own_photo(f"photo-{stage}")
    if st.button("Read my photo" if mine else "Read the photo", type="primary", disabled=blocked) and \
            read(ws_id, today, photo=mine or ("whiteboard photo.jpg", WHITEBOARD.read_bytes(), "image/jpeg")):
        st.rerun()

else:
    if example:
        st.subheader("4. Now try your own")
    elif photo_tour:
        st.subheader("2. Now add notes, or another photo")
    else:
        st.subheader("Add more notes" if stage else "Add your first notes")
    hint = "e.g. Sam: write the agenda by Friday"
    text = st.text_area("Notes", "", height=110, key=f"notes-{stage}", label_visibility="collapsed", placeholder=hint)
    if blocked:
        st.caption("Connect your AI above first.")
    with st.expander("Or add a photo"):
        mine = own_photo(f"free-{stage}")
    if st.button("Add", type="primary", disabled=blocked or not (text.strip() or mine)) and read(ws_id, today, text, mine):
        st.rerun()

st.divider()
c1, c2, c3 = st.columns([1, 1, 2])
if c1.button("New board", help="Start another board. This one stays at its link."):
    st.query_params.clear()
    st.session_state.pop("edit_version", None)
    st.rerun()
with c2.popover("Delete this board"):
    st.markdown("This deletes the board, its notes and its photos for good. The link stops working.")
    if st.button("Yes, delete it", type="primary"):
        api("DELETE", f"/api/workspaces/{ws_id}")
        st.query_params.clear()
        st.rerun()
images = f"Cloudinary ({status.get('cloudName')})" if status["cloudinary"] else "local storage (Cloudinary not configured)"
ai_used = (f"{ai_key()['label']} ({ai_key()['model']}), your key" if ai_key()
           else f"{status.get('visionModel') or status.get('textModel')}, running locally" if local_ai else "not connected")
c3.caption(f"AI: {ai_used}. Photos: {images}.")
