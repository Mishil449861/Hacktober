"""
Starts the OrgMap server next to the demo page when nothing answers at ORGMAP_API. This is what makes
the demo hostable on Streamlit Community Cloud, where the page is the only thing that runs: the page
starts the Node.js server itself, inside the same container. Free of Streamlit, so it can be tested.

Node.js: one already installed (20+), else the one from the nodejs-wheel package in requirements.txt
(Community Cloud's Debian has none recent enough). ORGMAP_NODE=wheel forces the packaged one.

The server's output goes to the page's own output (on Community Cloud: "Manage app" > logs, prefixed
"[orgmap]") and to <DATA_DIR>/server.log.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import signal
import subprocess
import sys
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


class _Log:
    """Writes each line to the log file and to this process's output (Community Cloud shows the latter)."""

    def __init__(self, path: Path):
        self.file = open(path, "a", buffering=1, encoding="utf-8")  # noqa: SIM115 (lives as long as the server)
        self.name = str(path)

    def write(self, text: str) -> None:
        self.file.write(text)
        for line in text.splitlines():
            print(f"[orgmap] {line}", file=sys.stderr, flush=True)

    def pump(self, stream) -> None:
        """Copy a child process's output, line by line, until it closes."""
        for raw in iter(stream.readline, b""):
            self.write(raw.decode("utf-8", "replace"))


def ensure_packages(node: str, log: _Log) -> None:
    """Install the server's Node packages (runtime ones only) if they aren't there yet."""
    if (ROOT / "node_modules/tsx/package.json").exists() and (ROOT / "node_modules/express/package.json").exists():
        return
    npm = _npm_cli(node)
    if not npm:
        raise RuntimeError("npm was not found next to Node.js")
    log.write(f"[boot] npm ci --omit=dev in {ROOT}\n")
    r = subprocess.run([node, str(npm), "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=ROOT,
                       capture_output=True, timeout=900)
    log.write((r.stdout + r.stderr).decode("utf-8", "replace")[-4000:])
    if r.returncode != 0:
        raise RuntimeError(f"npm ci failed (exit {r.returncode}); see the app's logs")


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


def code_version() -> str:
    """Fingerprint of the server code on disk; must match server/index.ts codeVersion."""
    files = sorted([f"server/{p.relative_to(ROOT / 'server').as_posix()}" for p in (ROOT / "server").rglob("*.ts")]
                   + ["src/shared/schema.ts", "package-lock.json"])
    h = hashlib.sha1()
    for f in files:
        h.update(f.encode() + b"\0")
        try:
            h.update((ROOT / f).read_bytes())
        except OSError:
            pass
    return h.hexdigest()[:12]


_replaced: set[str] = set()


def replace_if_outdated(api: str, status: dict) -> bool:
    """A server started before an update keeps running the old code (Streamlit Cloud reloads the page,
    not the container). If its fingerprint differs from the code on disk, stop it and start the new one.
    Only once per running version, so a fingerprint bug can't cause a restart loop. True if replaced."""
    running, pid = status.get("codeVersion"), status.get("pid")
    if not running or not pid or running == code_version() or running in _replaced:
        return False
    _replaced.add(running)
    print(f"[orgmap] [boot] server code {running} is outdated (disk: {code_version()}): restarting it", file=sys.stderr, flush=True)
    try:
        os.kill(int(pid), signal.SIGTERM)
    except OSError:
        return False
    for _ in range(30):
        if not healthy(api):
            break
        time.sleep(0.5)
    ensure_server(api)
    return True


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
        log = _Log(data_dir() / "server.log")
        log.write(f"[boot] {time.strftime('%Y-%m-%d %H:%M:%S')} starting the server with {node}\n")
        ensure_packages(node, log)
        proc = subprocess.Popen([node, "--import", "tsx", "server/index.ts"], cwd=ROOT, env=server_env(api),
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=(os.name != "nt"))
        threading.Thread(target=log.pump, args=(proc.stdout,), daemon=True, name="orgmap-server-log").start()
        deadline = time.time() + wait_s
        while time.time() < deadline:
            if healthy(api):
                return
            if proc.poll() is not None:
                raise RuntimeError(f"the server stopped (exit {proc.returncode}); see the app's logs")
            time.sleep(2)
        raise RuntimeError(f"the server didn't answer within {wait_s} s; see the app's logs")
