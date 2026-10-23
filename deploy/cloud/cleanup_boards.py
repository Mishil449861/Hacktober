"""
Delete boards nobody has touched for a while, with their notes and photos (Cloudinary too).

A public demo collects boards from strangers. Removing stale ones keeps storage, the Cloudinary free plan
and other people's notes from piling up. Run daily by the orgmap-cleanup timer (deploy/cloud/setup.sh).

    python3 cleanup_boards.py --days 30 [--api http://127.0.0.1:8787] [--dry-run]

Standard library only. A board's last activity is its newest note or photo, or its creation if it has none.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import urllib.request


def call(api: str, method: str, path: str):
    req = urllib.request.Request(api + path, method=method)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"null")


def when(ts: str | None) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument("--days", type=int, default=30, help="delete boards with no activity for this many days")
    p.add_argument("--api", default="http://127.0.0.1:8787")
    p.add_argument("--dry-run", action="store_true", help="only list what would be deleted")
    a = p.parse_args()

    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)
    removed = kept = 0
    for ws in call(a.api, "GET", "/api/workspaces"):
        state = call(a.api, "GET", f"/api/workspaces/{ws['id']}")
        stamps = [when(ws.get("createdAt"))] + [when(s.get("createdAt")) for s in state.get("sources", [])]
        stamps = [s for s in stamps if s]
        if not stamps or max(stamps) >= cutoff:
            kept += 1
            continue
        print(f"{'would delete' if a.dry_run else 'deleting'} {ws['name']!r} (last activity {max(stamps):%Y-%m-%d})", flush=True)
        if not a.dry_run:
            call(a.api, "DELETE", f"/api/workspaces/{ws['id']}")
        removed += 1
    print(f"{removed} board(s) {'to delete' if a.dry_run else 'deleted'}, {kept} kept (inactive for over {a.days} days = stale)")


if __name__ == "__main__":
    main()
