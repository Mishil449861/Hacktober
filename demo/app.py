"""
OrgMap AI demo: one screen.

Plain meeting notes go in; a to-do list (who, what, by when), the decisions and who reports to whom
come out. A second note updates it, then a whiteboard photo does: the photo is stored and transformed
by Cloudinary, and the page shows exactly what Cloudinary did with it.

    npm run dev     # terminal 1: API + local model
    npm run demo    # terminal 2: this page (http://localhost:8501)
"""
from __future__ import annotations

import datetime as dt
import os
import time
from pathlib import Path

import requests
import streamlit as st

API = os.environ.get("ORGMAP_API", "http://localhost:8787")
PROJECT = "Demo"
WHITEBOARD = Path(__file__).parent / "whiteboard.png"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

today = dt.date.today()
short = lambda d: f"{MONTHS[d.month - 1]} {d.day}"  # noqa: E731  ("Oct 10", independent of the OS language)


def friendly(iso: str | None) -> str:
    if not iso:
        return ""
    d = dt.date.fromisoformat(iso)
    return f"{DAYS[d.weekday()]}, {short(d)}"


# The two prepared notes. Dates are computed from today so the story always reads as current.
FIRST_DAY = today - dt.timedelta(days=3)
NOTE_1 = f"""Maya is planning the team offsite. Ben reports to Maya.
- Ben: book the venue by {short(today + dt.timedelta(days=2))}
- Maya: send the invitations by {short(today + dt.timedelta(days=5))}
- Decision: the offsite is on {short(today + dt.timedelta(days=19))}."""
NOTE_2 = f"""Ben has booked the venue. Done.
Chloe joins the team and reports to Maya.
- Chloe: order the catering by {short(today + dt.timedelta(days=9))}
- Decision: lunch will be catered."""


def api(method: str, path: str, **kw):
    r = requests.request(method, API + path, timeout=60, **kw)
    if not r.ok:
        raise RuntimeError(f"{r.status_code}: {r.text[:300]}")
    return r.json()


def project_id() -> str:
    for w in api("GET", "/api/workspaces"):
        if w["name"] == PROJECT:
            return w["id"]
    return api("POST", "/api/workspaces", json={"name": PROJECT})["id"]


def read(ws_id: str, date: dt.date, text: str = "", photo: tuple[str, bytes] | None = None):
    stamp = time.strftime("%H:%M:%S")
    if text.strip():
        api("POST", f"/api/workspaces/{ws_id}/sources", data={"text": text, "name": f"Notes {stamp}", "date": date.isoformat()})
    if photo:
        api("POST", f"/api/workspaces/{ws_id}/sources", data={"date": date.isoformat()}, files={"files": photo})
    with st.spinner("Reading on this laptop… (usually 15 to 40 seconds)"):
        while True:
            time.sleep(1.5)
            s = api("GET", f"/api/workspaces/{ws_id}")
            if not any(x["status"] in ("ANALYZING", "PENDING") for x in s["sources"]):
                return


def own_photo(key: str) -> tuple[str, bytes] | None:
    """Upload or laptop camera. Returns (filename, bytes)."""
    up = st.file_uploader("Photo", type=["png", "jpg", "jpeg", "webp"], label_visibility="collapsed", key=f"up-{key}")
    shot = st.camera_input("Take a photo", key=f"cam-{key}") if st.toggle("Use this laptop's camera", key=f"camtoggle-{key}") else None
    if up:
        return (up.name, up.getvalue())
    if shot:
        return (f"camera {time.strftime('%H-%M-%S')}.jpg", shot.getvalue())
    return None


# ------------------------------------------------------------------ page
st.set_page_config(page_title="OrgMap AI", layout="centered")

try:
    status = api("GET", "/api/status")
except Exception:  # noqa: BLE001
    st.error("The OrgMap server isn't running. Start it with `npm run dev`, then refresh this page.")
    st.stop()
if not status["reachable"]:
    st.error("The local AI model isn't running. Start the Ollama app, then refresh this page.")
    st.stop()

ws_id = project_id()
views = api("GET", f"/api/workspaces/{ws_id}/views")
sources = api("GET", f"/api/workspaces/{ws_id}")["sources"]
done = [c for c in views["changes"] if c["status"] == "DONE"]
failed = [c for c in views["changes"] if c["status"] == "ERROR"]
stage = len(views["changes"])  # 0 nothing read yet, 1 first note read, 2 updated, 3+ photo read

st.title("Meeting notes in. To-do list out.")
st.caption("Type what was said in a meeting, or photograph the whiteboard. OrgMap AI works out who does what by "
           "when and keeps it up to date. The AI runs on this laptop; photos are stored and prepared by Cloudinary.")

# ---- results
if stage:
    latest = done[-1] if done else None
    if stage >= 2 and latest and (latest["statusChanges"] or latest["created"] or latest["dateChanges"]):
        lines = [f"**{c['label']}** is now {c['to'].replace('_', ' ').lower()}" for c in latest["statusChanges"]]
        lines += [f"**{c['label']}** moved to {friendly(c['to'])}" for c in latest["dateChanges"]]
        new = [c["label"] for c in latest["created"] if c["type"] in ("TASK", "DECISION", "PERSON", "BLOCKER")]
        if new:
            lines.append("New: " + ", ".join(new))
        what = "the photo" if latest["type"] == "IMAGE" else "the update"
        st.success(f"**What {what} changed**\n\n" + "\n\n".join(lines))

    st.subheader("To-do list")
    if views["actionItems"]:
        rows = ["| To-do | Who | By when |", "|---|---|---|"]
        for a in sorted(views["actionItems"], key=lambda a: (a["status"] == "DONE", a["due"] or "9999")):
            is_done = a["status"] in ("DONE", "RESOLVED")
            label = f"~~{a['label']}~~" if is_done else f"**{a['label']}**"
            when = "Done" if is_done else (friendly(a["due"]) + (" (overdue)" if a["overdue"] else ""))
            rows.append(f"| {label} | {', '.join(a['owners']) or 'nobody yet'} | {when or 'no date'} |")
        st.markdown("\n".join(rows))
    else:
        st.caption("No to-dos found yet.")

    left, right = st.columns(2)
    with left:
        st.subheader("Decisions")
        if views["decisions"]:
            for d in reversed(views["decisions"]):
                st.markdown(f"- {d['label']}")
        else:
            st.caption("None yet.")
        open_blockers = [b for b in views["blockers"] if b["status"] == "OPEN"]
        if open_blockers:
            st.subheader("Blockers")
            for b in open_blockers:
                st.markdown(f"- **{b['label']}**" + (f" (blocks {', '.join(b['blocks'])})" if b["blocks"] else ""))
    with right:
        st.subheader("Who's who")
        people = {n["id"]: n["label"] for n in views["orgChart"]["nodes"] if n["type"] == "PERSON"}
        reports = [(e["source"], e["target"]) for e in views["orgChart"]["edges"]
                   if e["relationship"] == "REPORTS_TO" and e["source"] in people and e["target"] in people]
        if reports:
            dot = ['digraph G { rankdir=BT; bgcolor="transparent"; node [shape=box style="rounded,filled" fillcolor=white '
                   'color="#2a78d6" penwidth=2 fontname=Helvetica fontsize=12]; edge [color="#898781" arrowsize=0.7];']
            dot += [f'"{i}" [label="{name}"];' for i, name in people.items() if any(i in r for r in reports)]
            dot += [f'"{a}" -> "{b}";' for a, b in reports]
            dot.append("}")
            st.graphviz_chart("\n".join(dot))
            st.caption("Arrows point to the person someone reports to.")
        elif people:
            st.markdown(", ".join(people.values()))
        else:
            st.caption("Nobody mentioned yet.")

    # ---- proof of what Cloudinary did with the latest photo
    photos = [s for s in sources if s["type"] == "IMAGE"]
    if photos:
        p = photos[-1]
        cld = p.get("cloudinary")
        st.subheader("What Cloudinary did with the photo")
        if cld:
            clean = lambda u: (u or "").split("?")[0]  # noqa: E731  (drop the SDK analytics suffix)
            a, b, c = st.columns([5, 5, 3])
            a.image(cld["secureUrl"], caption="1. Stored: the original, untouched")
            b.image(p.get("analysisUrl") or p["previewUrl"], caption="2. Prepared for the AI: resized, contrast improved, sharpened")
            c.image(p["thumbUrl"], caption="3. Thumbnail: smart-cropped")
            st.caption("The AI on this laptop read copy 2. Cloudinary made it on the fly; the instructions are in the address:")
            st.code(clean(p.get("analysisUrl")), language=None, wrap_lines=True)
            st.caption(
                f"Cloud **{status.get('cloudName')}** · asset `{cld['publicId']}` · {cld['width']}×{cld['height']} {cld['format'].upper()} · "
                f"uploaded {cld['createdAt'][:16].replace('T', ' ')} UTC by a signed request from this laptop's server "
                f"(the API secret never reaches the browser). [Open the original]({cld['secureUrl']})")
        else:
            st.info("This photo was stored on the laptop, because Cloudinary isn't configured. Add the three "
                    "`CLOUDINARY_…` values to `.env` and restart `npm run dev` to store and prepare photos with Cloudinary.")

    if failed:
        st.warning("One of the inputs couldn't be read. Press **Start over** below and try again.")
    st.divider()

# ---- input for the current step
if stage == 0:
    st.subheader("1. Here are some notes from a meeting")
    text = st.text_area("Notes", NOTE_1, height=150, key="notes-0", label_visibility="collapsed")
    st.caption("Change anything you like, or just press the button.")
    if st.button("Read my notes", type="primary", disabled=not text.strip()):
        read(ws_id, FIRST_DAY, text)
        st.rerun()

elif stage == 1:
    st.subheader("2. A few days later, there's an update")
    text = st.text_area("Notes", NOTE_2, height=150, key="notes-1", label_visibility="collapsed")
    st.caption("Watch the to-do list above: Ben's task gets ticked off and Chloe's is added.")
    if st.button("Add the update", type="primary", disabled=not text.strip()):
        read(ws_id, today, text)
        st.rerun()

elif stage == 2:
    st.subheader("3. Then someone photographs the whiteboard")
    st.image(str(WHITEBOARD), width=460)
    st.caption("The photo is uploaded to Cloudinary, which prepares a cleaned-up copy for the AI to read.")
    mine = None
    with st.expander("Use my own photo instead (handwritten notes, a whiteboard, sticky notes)"):
        mine = own_photo("step3")
        inbox = status.get("inbox") or {}
        if inbox.get("enabled"):
            st.caption(f"From a phone on the same Wi-Fi: {inbox['captureUrls'][0]} (uploads straight to Cloudinary)")
    if st.button("Read my photo" if mine else "Read the photo", type="primary"):
        read(ws_id, today, photo=mine or ("whiteboard.png", WHITEBOARD.read_bytes(), "image/png"))
        st.rerun()

else:
    st.subheader("4. Now try your own")
    hint = "For example:  Sam will write the agenda by Friday.   or   Chloe has ordered the catering. Done."
    text = st.text_area("Notes", "", height=120, key=f"notes-{stage}", label_visibility="collapsed", placeholder=hint)
    with st.expander("Or add a photo"):
        mine = own_photo(f"free-{stage}")
    if st.button("Add", type="primary", disabled=not (text.strip() or mine)):
        read(ws_id, today, text, mine)
        st.rerun()

st.divider()
c1, c2 = st.columns([1, 3])
if c1.button("Start over"):
    api("DELETE", f"/api/workspaces/{ws_id}")
    st.rerun()
images = f"Cloudinary ({status.get('cloudName')})" if status["cloudinary"] else "this laptop (Cloudinary not configured)"
c2.caption(f"AI: {status.get('visionModel') or status.get('textModel')}, running locally. Photos: {images}.")
