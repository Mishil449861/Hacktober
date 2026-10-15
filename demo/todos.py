"""
Dates and the to-do table for the demo page, kept free of Streamlit so they can be tested on their own.

Action items come from the local model, so any optional field can be missing: no due date, no owner,
no description. The server sends those as null (server/views.ts), and `action_item` below also accepts
the key being absent, so an incomplete to-do is still shown, just without that detail.
"""
from __future__ import annotations

import datetime as dt
import re

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
DONE = ("DONE", "RESOLVED")


def short(d: dt.date) -> str:
    """"Oct 10", independent of the OS language."""
    return f"{MONTHS[d.month - 1]} {d.day}"


def friendly(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        d = dt.date.fromisoformat(str(iso)[:10])
    except ValueError:  # a date the model got wrong ("2026-13-40"): show it as written
        return str(iso)
    return f"{DAYS[d.weekday()]}, {short(d)}"


def action_item(raw: object) -> dict | None:
    """One action item in a fixed shape. Missing optional fields get a neutral default, never an invented
    value: no due date stays None, no owner stays []. Status defaults to OPEN, as on the server. The label
    is the to-do itself, so an item without one is not a to-do and returns None."""
    if not isinstance(raw, dict):
        return None
    label = raw.get("label")
    if not isinstance(label, str) or not label.strip():
        return None
    owners = raw.get("owners")
    if isinstance(owners, str):
        owners = [owners]
    due, status, description = raw.get("due"), raw.get("status"), raw.get("description")
    return {
        **raw,
        "label": label.strip(),
        "description": description if isinstance(description, str) and description.strip() else None,
        "owners": [str(o) for o in owners if o] if isinstance(owners, list) else [],
        "due": due if isinstance(due, str) and due.strip() else None,
        "status": status if isinstance(status, str) and status.strip() else "OPEN",
        "overdue": bool(raw.get("overdue")),
    }


def _cell(text: str) -> str:
    """Model output can contain line breaks, "|" or brackets, which would break the Markdown table
    or a Streamlit color directive (":green[...]")."""
    return re.sub(r"\s+", " ", text).replace("|", "\\|").replace("[", "\\[").replace("]", "\\]").strip()


# Streamlit Markdown colors: what the latest update added is green, what it changed is orange.
NEW_COLOR, CHANGED_COLOR = "green", "orange"
STATUS_BADGE = {"DONE": "Just done", "RESOLVED": "Just resolved", "IN_PROGRESS": "Now in progress", "OPEN": "Reopened",
                "CANCELLED": "Cancelled"}


def changes_by_item(change: dict | None) -> dict[str, dict]:
    """What one update (an entry of the server's `changes` view) did to each item, keyed by node id and,
    for older servers without ids, by label: {"new": True} / {"status": (from, to)} / {"due": (from, to)}."""
    out: dict[str, dict] = {}
    if not isinstance(change, dict):
        return out

    def put(entry: dict, **what):
        for key in (entry.get("id"), str(entry.get("label") or "").strip().lower()):
            if key:
                out.setdefault(key, {}).update(what)

    for c in change.get("created") or []:
        put(c, new=True)
    for c in change.get("statusChanges") or []:
        put(c, status=(c.get("from"), c.get("to")))
    for c in change.get("dateChanges") or []:
        put(c, due=(c.get("from"), c.get("to")))
    return out


def todo_table(raw_items: list, latest_change: dict | None = None) -> tuple[str, int]:
    """The to-do list as a Markdown table: open items first, then by due date (undated last).
    With `latest_change` (the most recent update), what it added is green with a "New" badge and what it
    changed is orange, with a badge naming the change and the old date beside the new one.
    Returns the table ("" when there is nothing to show) and how many items were left out for having no label."""
    items = [a for a in (action_item(r) for r in raw_items or []) if a]
    if not items:
        return "", len(raw_items or [])
    changed = changes_by_item(latest_change)
    rows = ["| To-do | Who | By when |", "|---|---|---|"]
    for a in sorted(items, key=lambda a: (a["status"] == "DONE", a["due"] or "9999")):
        is_done = a["status"] in DONE
        label = f"~~{_cell(a['label'])}~~" if is_done else f"**{_cell(a['label'])}**"
        when = "Done" if is_done else (friendly(a["due"]) + (" (overdue)" if a["overdue"] else ""))
        when = _cell(when) or "no date"
        c = changed.get(str(a.get("id") or "")) or changed.get(a["label"].lower()) or {}
        if c.get("new"):
            label = f":{NEW_COLOR}[{label}] :{NEW_COLOR}-badge[New]"
        elif c.get("status") or c.get("due"):
            badges = []
            if c.get("status"):
                badges.append(STATUS_BADGE.get(c["status"][1], "Updated"))
            if c.get("due"):
                badges.append("Date moved")
                if not is_done:
                    when = f":{CHANGED_COLOR}[{when}] (was {_cell(friendly(c['due'][0])) or 'no date'})"
            label = f":{CHANGED_COLOR}[{label}] " + " ".join(f":{CHANGED_COLOR}-badge[{b}]" for b in badges)
        rows.append(f"| {label} | {_cell(', '.join(a['owners'])) or 'nobody yet'} | {when} |")
    return "\n".join(rows), len(raw_items or []) - len(items)
