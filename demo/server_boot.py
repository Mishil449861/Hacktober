"""
Starts the OrgMap server next to the demo page when nothing answers at ORGMAP_API. This is what makes
the demo hostable on Streamlit Community Cloud, where the page is the only thing that runs: the page
starts the Node.js server itself, inside the same container. Free of Streamlit, so it can be tested.

Node.js: one already installed (20+), else the one from the nodejs-wheel package in requirements.txt
(Community Cloud's Debian has none recent enough). ORGMAP_NODE=wheel forces the packaged one.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
_lock = threading.Lock()


def data_dir() -> Path:
    d = Path(os.environ.get("DATA_DIR") or Path.home() / ".orgmap-data")
    d.mkdir(parents=True, exist_ok=True)
    return d


def healthy(api: str) -> bool:
    try:
        with urllib.request.urlopen(api.rstrip("/") + "/api/status", timeout=10) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def _major(node: str) -> int:
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=20).stdout
        return int(out.strip().lstrip("v").split(".")[0])
    except Exception:  # noqa: BLE001
        return 0


def node_binary() -> str | None:
    """A Node.js 20+ executable, or None."""
    if os.environ.get("ORGMAP_NODE") != "wheel":
        found = shutil.which("node")
        if found and _major(found) >= 20:
            return found
    try:
        from nodejs_wheel.executable import ROOT_DIR
    except ImportError:
        return None
    exe = Path(ROOT_DIR) / ("node.exe" if os.name == "nt" else "bin/node")
    return str(exe) if exe.exists() and _major(str(exe)) >= 20 else None


def _npm_cli(node: str) -> Path | None:
    """The npm that ships with this Node.js (installer layout, Linux layout, or nodejs-wheel's)."""
    n = Path(node).resolve()
    candidates = [n.parent / "node_modules/npm/bin/npm-cli.js", n.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"]
    try:
        from nodejs_wheel.executable import ROOT_DIR
        candidates.append(Path(ROOT_DIR) / "lib/node_modules/npm/bin/npm-cli.js")
    except ImportError:
        pass
    return next((c for c in candidates if c.exists()), None)


def ensure_packages(node: str, log) -> None:
    """Install the server's Node packages (runtime ones only) if they aren't there yet."""
    if (ROOT / "node_modules/tsx/package.json").exists() and (ROOT / "node_modules/express/package.json").exists():
        return
    npm = _npm_cli(node)
    if not npm:
        raise RuntimeError("npm was not found next to Node.js")
    log.write(f"[boot] npm ci --omit=dev in {ROOT}\n")
    log.flush()
    r = subprocess.run([node, str(npm), "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=ROOT, stdout=log,
                       stderr=subprocess.STDOUT, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"npm ci failed (exit {r.returncode}); see {log.name}")


def server_env(api: str) -> dict[str, str]:
    """Environment for the hosted server. Values already set (e.g. Streamlit secrets) win."""
    env = dict(os.environ)
    env.update({"PORT": str(urlparse(api).port or 8787), "HOST": "127.0.0.1"})
    for k, v in {
        "DATA_DIR": str(data_dir()), "NODE_ENV": "production", "ORGMAP_DEBUG": "false",
        "CLOUDINARY_INBOX": "false",            # no phone inbox on the hosted demo
        "ORGMAP_DB_BACKUP": "cloudinary",       # boards survive the app's disk being wiped
        "BOARD_MAX_AGE_DAYS": "30",             # strangers' boards don't pile up
        "OCR_ENABLED": "true",
    }.items():
        env.setdefault(k, v)
    return env


def ensure_server(api: str, wait_s: int = 300) -> None:
    """Make the server answer at `api`, starting it if needed. Raises RuntimeError with the reason."""
    if healthy(api):
        return
    with _lock:
        if healthy(api):  # another session started it meanwhile
            return
        node = node_binary()
        if not node:
            raise RuntimeError("Node.js 20+ was not found (add nodejs-wheel to requirements.txt)")
        log = open(data_dir() / "server.log", "a", buffering=1, encoding="utf-8")  # noqa: SIM115 (kept open for the child)
        log.write(f"\n[boot] {time.strftime('%Y-%m-%d %H:%M:%S')} starting the server with {node}\n")
        ensure_packages(node, log)
        proc = subprocess.Popen([node, "--import", "tsx", "server/index.ts"], cwd=ROOT, env=server_env(api),
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=(os.name != "nt"))
        deadline = time.time() + wait_s
        while time.time() < deadline:
            if healthy(api):
                return
            if proc.poll() is not None:
                raise RuntimeError(f"the server stopped (exit {proc.returncode}); see {log.name}")
            time.sleep(2)
        raise RuntimeError(f"the server didn't answer within {wait_s} s; see {log.name}")
