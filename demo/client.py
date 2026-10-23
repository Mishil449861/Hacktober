"""
The demo page's calls to the OrgMap server, kept free of Streamlit so they can be tested on their own.
"""
from __future__ import annotations

import os

import requests

API = os.environ.get("ORGMAP_API", "http://localhost:8787")
OWNER_TYPES = ("PERSON", "TEAM")


def api(method: str, path: str, **kw):
    r = requests.request(method, API + path, timeout=60, **kw)
    if not r.ok:
        raise RuntimeError(f"{r.status_code}: {r.text[:300]}")
    return r.json()


def apply_edits(ws_id: str, ops: list[tuple]) -> None:
    """Carry out todos.plan_edits() through the server's editing API (the same one the graph editor uses)."""
    state = api("GET", f"/api/workspaces/{ws_id}")
    nodes = {n["id"]: n for n in state["nodes"]}
    people = [n for n in state["nodes"] if n["type"] in OWNER_TYPES]

    def person_id(name: str) -> str:
        exact = [p for p in people if p["label"].lower() == name.lower()]
        if exact:
            return exact[0]["id"]
        # "Ben" for the existing "Ben Carter", when that is the only Ben.
        first = [p for p in people if p["type"] == "PERSON" and p["label"].split()[0].lower() == name.lower()]
        if len(first) == 1:
            return first[0]["id"]
        p = api("POST", f"/api/workspaces/{ws_id}/nodes", json={"label": name, "type": "PERSON"})
        people.append(p)
        nodes[p["id"]] = p
        return p["id"]

    def set_owners(task_id: str, names: list[str]) -> None:
        # The same links the to-do list reads owners from (server/views.ts ownersOf).
        current: dict[str, list[str]] = {}
        for e in state["edges"]:
            if e["target"] == task_id and e["relationship"] in ("OWNS", "RESPONSIBLE_FOR"):
                other = e["source"]
            elif e["source"] == task_id and e["relationship"] in ("OWNS", "RESPONSIBLE_FOR", "RELATES_TO"):
                other = e["target"]
            else:
                continue
            if nodes.get(other, {}).get("type") in OWNER_TYPES:
                current.setdefault(other, []).append(e["id"])
        wanted = [person_id(n) for n in names]
        for other, edge_ids in current.items():
            if other not in wanted:
                for edge_id in edge_ids:
                    api("DELETE", f"/api/edges/{edge_id}")
        for pid in wanted:
            if pid not in current:
                api("POST", f"/api/workspaces/{ws_id}/edges", json={"source": pid, "target": task_id, "relationship": "RESPONSIBLE_FOR"})

    for op in ops:
        if op[0] == "add":
            item = op[1]
            task = api("POST", f"/api/workspaces/{ws_id}/nodes", json={"label": item["label"], "type": "TASK"})
            api("PATCH", f"/api/nodes/{task['id']}", json={"status": "DONE" if item["done"] else "OPEN",
                                                           **({"date": item["due"]} if item["due"] else {})})
            if item["owners"]:
                set_owners(task["id"], item["owners"])
        elif op[0] == "update":
            api("PATCH", f"/api/nodes/{op[1]}", json=op[2])
        elif op[0] == "owners":
            set_owners(op[1], op[2])
        elif op[0] == "delete":
            api("DELETE", f"/api/nodes/{op[1]}")
