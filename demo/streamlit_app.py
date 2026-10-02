"""
OrgMap AI: meeting notes -> live project dashboard (Streamlit demo).

Story: a payments migration program. Each meeting's minutes (and whiteboard / sprint-board photos)
are merged into one map; the dashboard (action items, blockers, trend) updates after every meeting.

    npm run dev                                   # terminal 1: API + local models
    streamlit run demo/streamlit_app.py           # terminal 2: this demo
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import altair as alt
import pandas as pd
import requests
import streamlit as st

API = os.environ.get("ORGMAP_API", "http://localhost:8787")
MINUTES = Path(__file__).parent / "minutes"
SERIES = "Payments Platform Migration"

# Scripted meetings: (title, date, minutes file, optional photo)
SCRIPT = [
    ("Kickoff", "2026-09-08", "01-kickoff.md", None),
    ("Architecture review", "2026-09-15", "02-architecture-review.md", "02-whiteboard.png"),
    ("Weekly sync", "2026-09-22", "03-weekly-sync.md", None),
    ("Steering committee", "2026-09-29", "04-steering-committee.md", "04-sprint-board.png"),
]

BLUE, ORANGE = "#2a78d6", "#eb6834"  # categorical slots 1-2
STATUS_ICON = {"DONE": "✅ Done", "RESOLVED": "✅ Resolved", "IN_PROGRESS": "🟡 In progress", "OPEN": "⚪ Open", "CANCELLED": "Cancelled"}


def api(method: str, path: str, **kw):
    r = requests.request(method, API + path, timeout=60, **kw)
    if not r.ok:
        raise RuntimeError(f"{r.status_code}: {r.text[:300]}")
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text


def add_meeting(ws_id: str, title: str, date: str, text: str | None, photo: tuple[str, bytes] | None):
    if text:
        api("POST", f"/api/workspaces/{ws_id}/sources", data={"text": text, "name": f"{date} · {title}", "date": date})
    if photo:
        name, data = photo
        ext = Path(name).suffix.lower() or ".png"
        api("POST", f"/api/workspaces/{ws_id}/sources", data={"date": date},
            files={"files": (f"{date} · {title} (photo){ext}", data, f"image/{ext.lstrip('.').replace('jpg', 'jpeg')}")})


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


# ------------------------------------------------------------------ page
st.set_page_config(page_title="OrgMap AI", layout="wide")

try:
    status = api("GET", "/api/status")
except Exception as e:  # noqa: BLE001
    st.error(f"OrgMap server not reachable at {API}. Start it with `npm run dev`. ({e})")
    st.stop()

ss = st.session_state
workspaces = api("GET", "/api/workspaces")

with st.sidebar:
    st.header("OrgMap AI")
    names = [w["name"] for w in workspaces]
    ws = None
    if workspaces:
        default = names.index(SERIES) if SERIES in names else 0
        ws = workspaces[st.selectbox("Project", range(len(workspaces)), index=default, format_func=lambda i: names[i])]
    if SERIES not in names and st.button(f"Create “{SERIES}”", type="primary"):
        api("POST", "/api/workspaces", json={"name": SERIES})
        st.rerun()
    if ws and ws["name"] == SERIES and st.button("Reset demo"):
        api("DELETE", f"/api/workspaces/{ws['id']}")
        api("POST", "/api/workspaces", json={"name": SERIES})
        st.rerun()
    st.divider()
    inbox = status.get("inbox") or {}
    if inbox.get("enabled"):
        st.markdown(f"📷 **Phone capture**  \n[{inbox['captureUrls'][0]}]({inbox['captureUrls'][0]})")
        st.caption("Open on a phone on the same Wi-Fi. Photos go to Cloudinary and appear here automatically.")
    st.caption(f"Model: {status.get('visionModel') or status.get('textModel')} (local)  \n"
               f"Images: {'Cloudinary' if status['cloudinary'] else 'local disk'}")

if not ws:
    st.title("OrgMap AI")
    st.info("Create the demo project in the sidebar to start.")
    st.stop()

views = api("GET", f"/api/workspaces/{ws['id']}/views")
k = views["kpis"]
st.title(ws["name"])


@st.fragment(run_every=5)
def live_refresh(ws_id: str):
    """Rerun the page when a phone photo lands or an analysis finishes."""
    s = api("GET", f"/api/workspaces/{ws_id}")
    sig = tuple((x["id"], x["status"]) for x in s["sources"])
    if ss.get("sig") not in (None, sig):
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

tab_run, tab_dash, tab_map, tab_report = st.tabs(["▶ Add meetings", "📊 Dashboard", "🗺️ Map", "📄 Status report"])

# ---- 1. add meetings
with tab_run:
    done_names = {c["name"] for c in views["changes"]}
    left, right = st.columns([1, 1])
    with left:
        st.subheader("Scripted demo")
        nxt = next((m for m in SCRIPT if f"{m[1]} · {m[0]}" not in done_names), None)
        for title, date, _, photo in SCRIPT:
            mark = "✅" if f"{date} · {title}" in done_names else ("▶️" if nxt and nxt[0] == title else "○")
            st.markdown(f"{mark} **{date}**, {title}{' + 📷 photo' if photo else ''}")
        if nxt and st.button(f"Add next meeting: {nxt[0]}", type="primary"):
            photo = (nxt[3], (MINUTES / nxt[3]).read_bytes()) if nxt[3] else None
            add_meeting(ws["id"], nxt[0], nxt[1], (MINUTES / nxt[2]).read_text(encoding="utf8"), photo)
            wait_idle(ws["id"])
            st.rerun()
        if nxt:
            with st.expander(f"Preview: {nxt[0]} minutes"):
                st.markdown((MINUTES / nxt[2]).read_text(encoding="utf8"))
                if nxt[3]:
                    st.image(str(MINUTES / nxt[3]))
        else:
            st.success("All scripted meetings added. Try your own notes, or a phone photo.")
    with right:
        st.subheader("Your own notes")
        title = st.text_input("Meeting", "Ad-hoc sync")
        date = st.date_input("Date").isoformat()
        text = st.text_area("Minutes", height=160, placeholder="- Raj: fix the login bug (due 2026-10-09)\n- Decision: ...\n- The PCI audit is done.")
        up = st.file_uploader("Whiteboard / sprint-board photo", type=["png", "jpg", "jpeg", "webp"])
        if st.button("Add to project", disabled=not (text.strip() or up)):
            add_meeting(ws["id"], title, date, text.strip() or None, (up.name, up.getvalue()) if up else None)
            wait_idle(ws["id"])
            st.rerun()

    # What the latest meeting changed
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

# ---- 2. dashboard
with tab_dash:
    if trend:
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
        st.altair_chart(chart, use_container_width=True)

    a_col, b_col = st.columns([3, 2])
    with a_col:
        st.subheader("Action items")
        rows = [{
            "Status": "🔴 Overdue" if a["overdue"] else STATUS_ICON.get(a["status"], a["status"]),
            "Action": a["label"], "Owner": ", ".join(a["owners"]) or "-", "Due": a["due"] or "-",
        } for a in views["actionItems"]]
        st.dataframe(pd.DataFrame(rows), hide_index=True, use_container_width=True) if rows else st.caption("None yet.")
    with b_col:
        st.subheader("Blockers & risks")
        rows = [{
            "Status": STATUS_ICON.get(b["status"], b["status"]) if b["status"] != "OPEN" else "🔴 Open",
            "Blocker": b["label"], "Blocks": ", ".join(b["blocks"]) or "-",
            "Age": f"{b['ageDays']}d",
        } for b in views["blockers"]]
        st.dataframe(pd.DataFrame(rows), hide_index=True, use_container_width=True) if rows else st.caption("None yet.")
        st.subheader("Milestones")
        for m in views["milestones"]:
            slip = f" · ⚠️ slipped {m['slipDays']}d (was {m['originalDate']})" if m["slipDays"] > 0 else ""
            st.markdown(f"**{m['label']}**: {m['date'] or 'no date'}{slip}")

# ---- 3. map
with tab_map:
    s = api("GET", f"/api/workspaces/{ws['id']}")
    colors = {"PERSON": "#e8590c", "TEAM": "#d6336c", "SYSTEM": "#1c7ed6", "COMPONENT": "#1098ad", "TASK": "#0c8599",
              "BLOCKER": "#e03131", "DECISION": "#f59f00", "MILESTONE": "#ae3ec9", "PROJECT": "#7048e8", "PROCESS": "#37b24d"}
    show = st.multiselect("Show", list(colors), default=["PERSON", "TEAM", "SYSTEM", "COMPONENT", "BLOCKER", "MILESTONE", "PROJECT", "PROCESS"])
    nodes = [n for n in s["nodes"] if n["type"] in show]
    ids = {n["id"] for n in nodes}
    dot = ['digraph G { rankdir=LR; bgcolor="transparent"; node [shape=box style="rounded,filled" fillcolor=white fontname=Helvetica fontsize=11]; edge [fontname=Helvetica fontsize=9 color="#888888"];']
    for n in nodes:
        done = n.get("status") in ("DONE", "RESOLVED")
        label = n["label"].replace('"', "'") + "\\n" + n["type"].lower() + (" ✓" if done else "")
        style = ' style="rounded,filled,dashed"' if done else ""
        color = colors.get(n["type"], "#495057")
        dot.append(f'"{n["id"]}" [label="{label}" color="{color}" penwidth=2{style}];')
    for e in s["edges"]:
        if e["source"] in ids and e["target"] in ids:
            dot.append(f'"{e["source"]}" -> "{e["target"]}" [label="{e["relationship"].replace("_", " ").lower()}"];')
    dot.append("}")
    st.graphviz_chart("\n".join(dot), use_container_width=True)

# ---- 4. report
with tab_report:
    md = api("GET", f"/api/workspaces/{ws['id']}/report.md")
    st.download_button("Download report (.md)", md, file_name="status-report.md")
    st.markdown(md)
