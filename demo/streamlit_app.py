"""
OrgMap AI: meeting notes -> live project dashboard (Streamlit demo).

Works for any project, from one laptop:
  - create a project with any name
  - add notes by pasting text, uploading .md/.txt files or photos, or using the laptop's webcam
  - or click through a sample story: every folder in demo/scenarios/ is one (see README)

    npm run dev        # terminal 1: API + local models
    npm run demo       # terminal 2: this page
"""
from __future__ import annotations

import datetime as dt
import os
import re
import time
from pathlib import Path

import altair as alt
import pandas as pd
import requests
import streamlit as st

API = os.environ.get("ORGMAP_API", "http://localhost:8787")
SCENARIOS = Path(__file__).parent / "scenarios"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
TEXT_EXT = {".md", ".txt"}

BLUE, ORANGE = "#2a78d6", "#eb6834"  # categorical slots 1-2
STATUS_ICON = {"DONE": "✅ Done", "RESOLVED": "✅ Resolved", "IN_PROGRESS": "🟡 In progress", "OPEN": "⚪ Open", "CANCELLED": "Cancelled"}


# ------------------------------------------------------------------ API
def api(method: str, path: str, **kw):
    r = requests.request(method, API + path, timeout=60, **kw)
    if not r.ok:
        raise RuntimeError(f"{r.status_code}: {r.text[:300]}")
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text


def add_notes(ws_id: str, title: str, date: str, text: str | None, photos: list[tuple[str, bytes]]):
    """One meeting = optional minutes text + any number of photos, all dated the same day."""
    if text and text.strip():
        api("POST", f"/api/workspaces/{ws_id}/sources", data={"text": text, "name": f"{date} · {title}", "date": date})
    for i, (name, data) in enumerate(photos):
        ext = Path(name).suffix.lower() if Path(name).suffix.lower() in IMAGE_EXT else ".png"
        label = f"{date} · {title} (photo{'' if len(photos) == 1 else ' ' + str(i + 1)}){ext}"
        api("POST", f"/api/workspaces/{ws_id}/sources", data={"date": date},
            files={"files": (label, data, f"image/{ext.lstrip('.').replace('jpg', 'jpeg')}")})


def wait_idle(ws_id: str):
    t0 = time.time()
    with st.status("Reading notes with the local model…", expanded=False) as box:
        while True:
            s = api("GET", f"/api/workspaces/{ws_id}")
            busy = [x["name"] for x in s["sources"] if x["status"] in ("ANALYZING", "PENDING")]
            if not busy:
                box.update(label=f"Dashboard updated ({time.time() - t0:.0f}s)", state="complete")
                return
            box.update(label=f"Analyzing: {busy[0]} ({time.time() - t0:.0f}s)")
            time.sleep(2)


# ------------------------------------------------------------------ sample stories
def pretty(name: str) -> str:
    return re.sub(r"[-_]+", " ", name).strip().capitalize()


@st.cache_data(ttl=10)
def load_scenarios() -> dict[str, dict]:
    """
    Every folder in demo/scenarios is a story. Files are grouped into steps by their leading number:
        01-kickoff.md            minutes ("# Project: Meeting title" and "**Date:** YYYY-MM-DD" are picked up)
        02-review.md + 02-*.png  minutes with one or more photos
        03-board.jpg             a photo on its own
    """
    out: dict[str, dict] = {}
    if not SCENARIOS.is_dir():
        return out
    for folder in sorted(p for p in SCENARIOS.iterdir() if p.is_dir()):
        steps: dict[str, dict] = {}
        project = None
        for f in sorted(folder.iterdir()):
            m = re.match(r"^(\d+)[-_ ]?(.*)$", f.stem)
            ext = f.suffix.lower()
            if not m or ext not in IMAGE_EXT | TEXT_EXT:
                continue
            step = steps.setdefault(m.group(1), {"title": None, "date": None, "text": None, "photos": []})
            if ext in TEXT_EXT:
                text = f.read_text(encoding="utf8")
                step["text"] = str(f)
                head = re.search(r"^#\s+(.+)$", text, re.M)
                if head:
                    parts = head.group(1).split(":", 1)
                    step["title"] = parts[-1].strip()
                    project = project or (parts[0].strip() if len(parts) == 2 else None)
                date = re.search(r"\*{0,2}Date:?\*{0,2}:?\s*(\d{4}-\d{2}-\d{2})", text, re.I)
                step["date"] = date.group(1) if date else None
                step["title"] = step["title"] or pretty(m.group(2))
            else:
                step["photos"].append(str(f))
                step["title"] = step["title"] or pretty(m.group(2))
        ordered = [steps[k] for k in sorted(steps, key=int)]
        last = dt.date.today().isoformat()
        for s in ordered:  # photo-only steps inherit the previous step's date
            s["date"] = last = s["date"] or last
        if ordered:
            out[project or pretty(folder.name)] = {"folder": folder.name, "steps": ordered}
    return out


# ------------------------------------------------------------------ page
st.set_page_config(page_title="OrgMap AI", layout="wide")

try:
    status = api("GET", "/api/status")
except Exception as e:  # noqa: BLE001
    st.error(f"OrgMap server not reachable at {API}. Start it with `npm run dev`. ({e})")
    st.stop()

ss = st.session_state
scenarios = load_scenarios()
workspaces = api("GET", "/api/workspaces")
by_id = {w["id"]: w for w in workspaces}

with st.sidebar:
    st.header("OrgMap AI")
    # A widget's state can't be changed after it is drawn, so "select this project" requests
    # (create / reset) are parked in `next_project` and applied here, before the selectbox exists.
    if "next_project" in ss:
        ss.project = ss.pop("next_project")
    if ss.get("project") not in by_id:
        ss.pop("project", None)
    ws = None
    if workspaces:
        ws = by_id[st.selectbox("Project", list(by_id), format_func=lambda i: by_id[i]["name"], key="project")]

    with st.expander("➕ New project", expanded=not workspaces):
        story = st.selectbox("Start from", ["A blank project", *scenarios], help="Sample stories come from demo/scenarios/")
        default = "" if story == "A blank project" else story
        new_name = st.text_input("Project name", default, placeholder="e.g. Q4 product launch", key=f"new-name-{story}")
        taken = new_name.strip() in {w["name"] for w in workspaces}
        if taken:
            st.caption("A project with this name already exists.")
        if st.button("Create project", type="primary", disabled=not new_name.strip() or taken):
            ss.next_project = api("POST", "/api/workspaces", json={"name": new_name.strip()})["id"]
            st.rerun()

    if ws:
        with st.expander("Reset / delete this project"):
            st.caption("Removes its notes, photos and map.")
            c_a, c_b = st.columns(2)
            if c_a.button("Reset"):
                api("DELETE", f"/api/workspaces/{ws['id']}")
                ss.next_project = api("POST", "/api/workspaces", json={"name": ws["name"]})["id"]
                st.rerun()
            if c_b.button("Delete"):
                api("DELETE", f"/api/workspaces/{ws['id']}")
                st.rerun()

    st.divider()
    inbox = status.get("inbox") or {}
    if inbox.get("enabled"):
        st.markdown(f"📷 **Phone capture (optional)**  \n[{inbox['captureUrls'][0]}]({inbox['captureUrls'][0]})")
        st.caption("A phone on the same Wi-Fi can send photos too. They appear here automatically.")
    st.caption(f"Model: {status.get('visionModel') or status.get('textModel') or 'none found'} (local)  \n"
               f"Images: {'Cloudinary' if status['cloudinary'] else 'local disk'}")
    for note in status["notes"]:
        st.caption(f"⚠️ {note}")

if not ws:
    st.title("OrgMap AI")
    st.info("Create a project in the sidebar: a blank one for your own notes, or one of the sample stories.")
    st.stop()

views = api("GET", f"/api/workspaces/{ws['id']}/views")
k = views["kpis"]
st.title(ws["name"])


@st.fragment(run_every=5)
def live_refresh(ws_id: str):
    """Rerun the page when a photo arrives from elsewhere or an analysis finishes."""
    s = api("GET", f"/api/workspaces/{ws_id}")
    sig = (ws_id, tuple((x["id"], x["status"]) for x in s["sources"]))
    if ss.get("sig") is not None and ss.sig[0] == ws_id and ss.sig != sig:
        ss.sig = sig
        st.rerun(scope="app")
    ss.sig = sig
    busy = [x["name"] for x in s["sources"] if x["status"] in ("ANALYZING", "PENDING")]
    if busy:
        st.info(f"⏳ Analyzing {busy[0]}…")


live_refresh(ws["id"])

# ---- KPI row, with change since the previous meeting
trend = views["trend"]
prev = trend[-2] if len(trend) > 1 else None
c1, c2, c3, c4 = st.columns(4)
c1.metric("Open action items", k["openActions"], None if not prev else trend[-1]["openActions"] - prev["openActions"], delta_color="inverse")
c2.metric("Overdue", k["overdueActions"], delta_color="inverse")
c3.metric("Open blockers", k["openBlockers"], None if not prev else trend[-1]["openBlockers"] - prev["openBlockers"], delta_color="inverse")
c4.metric("Decisions logged", k["decisions"], None if not prev else trend[-1]["decisions"] - prev["decisions"])

tab_add, tab_dash, tab_map, tab_report = st.tabs(["➕ Add notes", "📊 Dashboard", "🗺️ Map", "📄 Status report"])

# ---- 1. add notes
with tab_add:
    done_names = {c["name"] for c in views["changes"]}
    own, sample = st.columns([1, 1])

    with own:
        st.subheader("Your notes")
        c_t, c_d = st.columns([2, 1])
        title = c_t.text_input("Meeting / topic", "Team sync")
        date = c_d.date_input("Date").isoformat()
        text = st.text_area("Minutes or notes", height=170, placeholder=(
            "Plain sentences work. These patterns are read exactly:\n"
            "- Raj Patel: fix the login bug (due 2026-10-09)\n"
            "- Decision: ship on Friday.\n"
            "- The PCI audit is done.\n"
            "- Priya reports to Ana."))
        files = st.file_uploader("Or upload notes (.md, .txt) and photos of whiteboards, slides, sticky notes",
                                 type=["md", "txt", "png", "jpg", "jpeg", "webp"], accept_multiple_files=True)
        shot = st.camera_input("Photograph the whiteboard") if st.toggle("Use this laptop's camera") else None

        uploads = files or []
        texts = [text] + [f.getvalue().decode("utf8", errors="replace") for f in uploads if Path(f.name).suffix.lower() in TEXT_EXT]
        photos = [(f.name, f.getvalue()) for f in uploads if Path(f.name).suffix.lower() in IMAGE_EXT]
        if shot:
            photos.append(("camera.jpg", shot.getvalue()))
        combined = "\n\n".join(t for t in texts if t.strip())
        name = f"{date} · {title or 'Notes'}"
        if combined and name in done_names:
            st.caption("Notes with this meeting name and date already exist. Change the name or date to add another.")
        if st.button("Add to project", type="primary", disabled=not (combined or photos) or (bool(combined) and name in done_names)):
            add_notes(ws["id"], title or "Notes", date, combined, photos)
            wait_idle(ws["id"])
            st.rerun()

    with sample:
        st.subheader("Sample story")
        if not scenarios:
            st.caption("No sample stories found. Add a folder to demo/scenarios/ (see README).")
        else:
            names = list(scenarios)
            pick = st.selectbox("Story", names, index=names.index(ws["name"]) if ws["name"] in names else 0,
                                help="Each folder in demo/scenarios/ is a story. Add your own to script a demo.")
            steps = scenarios[pick]["steps"]
            key = lambda s: f"{s['date']} · {s['title']}"  # noqa: E731
            is_done = lambda s: key(s) in done_names or any(n.startswith(key(s) + " (photo") for n in done_names)  # noqa: E731
            nxt = next((s for s in steps if not is_done(s)), None)
            for s in steps:
                mark = "✅" if is_done(s) else ("▶️" if s is nxt else "○")
                st.markdown(f"{mark} **{s['date']}**, {s['title']}{' + 📷' * len(s['photos'])}")
            if nxt and st.button(f"Add next: {nxt['title']}", type="primary"):
                body = Path(nxt["text"]).read_text(encoding="utf8") if nxt["text"] else None
                add_notes(ws["id"], nxt["title"], nxt["date"], body, [(Path(p).name, Path(p).read_bytes()) for p in nxt["photos"]])
                wait_idle(ws["id"])
                st.rerun()
            if nxt:
                with st.expander(f"Preview: {nxt['title']}"):
                    if nxt["text"]:
                        st.markdown(Path(nxt["text"]).read_text(encoding="utf8"))
                    for p in nxt["photos"]:
                        st.image(p)
            else:
                st.success("Story complete. Keep going with your own notes on the left.")

    latest = [c for c in views["changes"] if c["status"] == "DONE"][-3:]
    if latest:
        st.subheader("What changed")
        for c in reversed(latest):
            bits = [f"**{x['label']}** {x['from'].lower()} → **{x['to'].lower()}**" for x in c["statusChanges"]]
            bits += [f"**{x['label']}** moved {x['from']} → **{x['to']}**" for x in c["dateChanges"]]
            new = ", ".join(x["label"] for x in c["created"][:8]) + (" …" if len(c["created"]) > 8 else "")
            with st.container(border=True):
                st.markdown(f"**{c['name']}**" + (" 📷" if c["type"] == "IMAGE" else ""))
                if bits:
                    st.markdown(" · ".join(bits))
                if new:
                    st.caption(f"New: {new}")
    failed = [c for c in views["changes"] if c["status"] == "ERROR"]
    for c in failed:
        st.warning(f"Could not read “{c['name']}”. Open the web app (localhost:5173) to retry or remove it.")

# ---- 2. dashboard
with tab_dash:
    if not views["changes"]:
        st.info("Nothing here yet. Add notes or a photo on the first tab.")
    if len(trend) > 1:
        df = pd.DataFrame(trend)
        long = df.melt(id_vars=["date"], value_vars=["openActions", "openBlockers"], var_name="series", value_name="count")
        long["series"] = long["series"].map({"openActions": "Open action items", "openBlockers": "Open blockers"})
        chart = (
            alt.Chart(long).mark_line(strokeWidth=2, point=alt.OverlayMarkDef(size=80, filled=True))
            .encode(
                x=alt.X("date:T", title="Meeting date", axis=alt.Axis(format="%b %d", grid=False)),
                y=alt.Y("count:Q", title=None, axis=alt.Axis(tickMinStep=1)),
                color=alt.Color("series:N", scale=alt.Scale(domain=["Open action items", "Open blockers"], range=[BLUE, ORANGE]),
                                legend=alt.Legend(title=None, orient="top")),
                tooltip=[alt.Tooltip("date:T", format="%b %d"), "series:N", "count:Q"],
            )
            .properties(height=220, title="Open items after each meeting")
        )
        st.altair_chart(chart, width="stretch")

    a_col, b_col = st.columns([3, 2])
    with a_col:
        st.subheader("Action items")
        rows = [{
            "Status": "🔴 Overdue" if a["overdue"] else STATUS_ICON.get(a["status"], a["status"]),
            "Action": a["label"], "Owner": ", ".join(a["owners"]) or "-", "Due": a["due"] or "-",
        } for a in views["actionItems"]]
        if rows:
            st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
        else:
            st.caption("None yet.")
    with b_col:
        st.subheader("Blockers & risks")
        rows = [{
            "Status": STATUS_ICON.get(b["status"], b["status"]) if b["status"] != "OPEN" else "🔴 Open",
            "Blocker": b["label"], "Blocks": ", ".join(b["blocks"]) or "-",
            "Age": f"{b['ageDays']}d",
        } for b in views["blockers"]]
        if rows:
            st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")
        else:
            st.caption("None yet.")
        if views["milestones"]:
            st.subheader("Milestones")
            for m in views["milestones"]:
                slip = f" · ⚠️ slipped {m['slipDays']}d (was {m['originalDate']})" if m["slipDays"] > 0 else ""
                st.markdown(f"**{m['label']}**: {m['date'] or 'no date'}{slip}")

# ---- 3. map
with tab_map:
    s = api("GET", f"/api/workspaces/{ws['id']}")
    colors = {"PERSON": "#e8590c", "TEAM": "#d6336c", "SYSTEM": "#1c7ed6", "COMPONENT": "#1098ad", "TASK": "#0c8599",
              "BLOCKER": "#e03131", "DECISION": "#f59f00", "MILESTONE": "#ae3ec9", "PROJECT": "#7048e8", "PROCESS": "#37b24d",
              "DOCUMENT": "#868e96", "OTHER": "#495057"}
    present = [t for t in colors if any(n["type"] == t for n in s["nodes"])]
    show = st.multiselect("Show", present, default=[t for t in present if t not in ("TASK", "DECISION")])
    nodes = [n for n in s["nodes"] if n["type"] in show]
    ids = {n["id"] for n in nodes}
    dot = ['digraph G { rankdir=LR; bgcolor="transparent"; node [shape=box style="rounded,filled" fillcolor=white fontname=Helvetica fontsize=11]; edge [fontname=Helvetica fontsize=9 color="#888888"];']
    for n in nodes:
        done = n.get("status") in ("DONE", "RESOLVED")
        label = n["label"].replace('"', "'") + "\\n" + n["type"].lower() + (" ✓" if done else "")
        style = ' style="rounded,filled,dashed"' if done else ""
        dot.append(f'"{n["id"]}" [label="{label}" color="{colors.get(n["type"], "#495057")}" penwidth=2{style}];')
    for e in s["edges"]:
        if e["source"] in ids and e["target"] in ids:
            dot.append(f'"{e["source"]}" -> "{e["target"]}" [label="{e["relationship"].replace("_", " ").lower()}"];')
    dot.append("}")
    if nodes:
        st.graphviz_chart("\n".join(dot), width="stretch")
    else:
        st.info("The map is empty.")
    st.caption("Drag, edit and merge nodes in the full editor: http://localhost:5173")

# ---- 4. report
with tab_report:
    md = api("GET", f"/api/workspaces/{ws['id']}/report.md")
    st.download_button("Download report (.md)", md, file_name=f"{re.sub(r'[^a-z0-9]+', '-', ws['name'].lower()).strip('-')}-status.md")
    st.markdown(md)
