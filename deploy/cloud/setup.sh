#!/usr/bin/env bash
# OrgMap AI on a server of its own, so the demo works while the laptop is off.
#
# Made for Oracle Cloud's Always Free Arm VM (Ubuntu 22.04/24.04, 2 OCPUs, 12 GB), works on any Ubuntu
# server with 8 GB+ of memory. Installs the local model (Ollama), the OrgMap server and the demo page as
# services that restart on failure and on reboot, and publishes ONLY the demo page, over HTTPS, through
# Tailscale Funnel: no inbound port is opened. Safe to run again; that is also how you update.
#
#   sudo TS_AUTHKEY=tskey-auth-... bash setup.sh
#
# Settings (environment variables, or lines in /etc/orgmap/setup.env):
#   TS_AUTHKEY            Tailscale auth key (admin console > Settings > Keys). Without it nothing is published.
#   TS_HOSTNAME           name in the address https://<name>.<tailnet>.ts.net        default: orgmap-cloud
#   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET    optional; empty = photos on the server's disk
#   OLLAMA_MODEL          default: qwen2.5vl:3b (fits 12 GB; 7b works too but is about twice as slow on CPU)
#   BOARD_MAX_AGE_DAYS    boards untouched this long are deleted daily                default: 30
#   REPO / BRANCH         where to get the code      default: https://github.com/Mishil449861/Hacktober.git / main
#   SKIP_FIREWALL=1       leave the firewall alone (for test machines)
set -euo pipefail

[ -f /etc/orgmap/setup.env ] && . /etc/orgmap/setup.env
TS_AUTHKEY="${TS_AUTHKEY:-}"
TS_HOSTNAME="${TS_HOSTNAME:-orgmap-cloud}"
CLOUDINARY_CLOUD_NAME="${CLOUDINARY_CLOUD_NAME:-}"
CLOUDINARY_API_KEY="${CLOUDINARY_API_KEY:-}"
CLOUDINARY_API_SECRET="${CLOUDINARY_API_SECRET:-}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5vl:3b}"
BOARD_MAX_AGE_DAYS="${BOARD_MAX_AGE_DAYS:-30}"
REPO="${REPO:-https://github.com/Mishil449861/Hacktober.git}"
BRANCH="${BRANCH:-main}"
SKIP_FIREWALL="${SKIP_FIREWALL:-}"

APP_DIR=/opt/orgmap
APP_USER=orgmap
DATA_HOME=/var/lib/orgmap
export DEBIAN_FRONTEND=noninteractive

log() { echo "[orgmap-setup] $*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash setup.sh" >&2; exit 1; }

# ---------------------------------------------------------------- 1. system packages, security updates
log "installing system packages"
apt-get update -y
apt-get install -y ca-certificates curl git python3 python3-venv ufw unattended-upgrades zstd
# Automatic security updates (Ubuntu's default policy: security fixes only).
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# Swap, so installing packages never runs out of memory next to the loaded model.
if ! swapon --show | grep -q .; then
  log "adding 4 GB swap"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- 2. Node.js 22
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  log "installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# ---------------------------------------------------------------- 3. Ollama + the model
if ! command -v ollama >/dev/null; then
  log "installing Ollama"
  curl -fsSL https://ollama.com/install.sh | sh
fi
mkdir -p /etc/systemd/system/ollama.service.d
# Local only, and keep the model loaded: answers come faster, and a loaded model keeps memory use above
# Oracle's "idle instance" threshold (20%), so the free VM isn't reclaimed.
cat > /etc/systemd/system/ollama.service.d/orgmap.conf <<'EOF'
[Service]
Environment=OLLAMA_HOST=127.0.0.1:11434
Environment=OLLAMA_KEEP_ALIVE=-1
EOF
systemctl daemon-reload
systemctl enable ollama >/dev/null 2>&1 || true
systemctl restart ollama
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 2; done
log "downloading the model $OLLAMA_MODEL (one-time, a few GB)"
ollama pull "$OLLAMA_MODEL"

# ---------------------------------------------------------------- 4. the app, as an unprivileged user
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_HOME/data"
if [ -d "$APP_DIR/.git" ]; then
  log "updating the code"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  log "downloading the code"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_HOME"
as_app() { runuser -u "$APP_USER" -- env HOME="$DATA_HOME" "$@"; }
log "installing Node packages"
(cd "$APP_DIR" && as_app npm ci --no-audit --no-fund)
log "installing Python packages"
(cd "$APP_DIR" && as_app python3 -m venv .venv && as_app .venv/bin/pip install --quiet --upgrade pip && as_app .venv/bin/pip install --quiet -r demo/requirements.txt)

# Settings for the server. Only root and the app user can read it (it may hold the Cloudinary secret).
inbox=false
umask 077
cat > "$APP_DIR/.env" <<EOF
PORT=8787
HOST=127.0.0.1
DATA_DIR=$DATA_HOME/data
NODE_ENV=production
ORGMAP_DEBUG=false
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=$OLLAMA_MODEL
OLLAMA_VISION_MODEL=$OLLAMA_MODEL
OLLAMA_SINGLE_MODEL=true
OLLAMA_UNLOAD_ON_SWITCH=false
OLLAMA_KEEP_ALIVE=-1
LOCAL_AI_TIMEOUT_MS=1800000
CLOUDINARY_CLOUD_NAME=$CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY=$CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET=$CLOUDINARY_API_SECRET
CLOUDINARY_INBOX=$inbox
EOF
umask 022
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# ---------------------------------------------------------------- 5. services
# Shared lockdown: no privilege escalation, read-only system, writes only to the app and data folders.
HARDEN="NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ReadWritePaths=$APP_DIR $DATA_HOME"

cat > /etc/systemd/system/orgmap-server.service <<EOF
[Unit]
Description=OrgMap AI server (API, notes parser, local model client)
After=network-online.target ollama.service
Wants=network-online.target ollama.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$DATA_HOME
ExecStart=$APP_DIR/node_modules/.bin/tsx server/index.ts
Restart=always
RestartSec=5
$HARDEN

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/orgmap-demo.service <<EOF
[Unit]
Description=OrgMap AI demo page (Streamlit)
After=orgmap-server.service
Wants=orgmap-server.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$DATA_HOME
Environment=ORGMAP_API=http://127.0.0.1:8787
ExecStart=$APP_DIR/.venv/bin/python -m streamlit run demo/app.py --server.address 127.0.0.1 --server.port 8501 --server.headless true --server.maxUploadSize 20 --browser.gatherUsageStats false
Restart=always
RestartSec=5
$HARDEN

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/orgmap-cleanup.service <<EOF
[Unit]
Description=OrgMap AI: delete boards untouched for $BOARD_MAX_AGE_DAYS days
After=orgmap-server.service

[Service]
Type=oneshot
User=$APP_USER
ExecStart=/usr/bin/python3 $APP_DIR/deploy/cloud/cleanup_boards.py --days $BOARD_MAX_AGE_DAYS
$HARDEN
EOF

cat > /etc/systemd/system/orgmap-cleanup.timer <<'EOF'
[Unit]
Description=OrgMap AI: daily cleanup of stale boards

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable orgmap-server orgmap-demo orgmap-cleanup.timer >/dev/null
systemctl restart orgmap-server orgmap-demo
systemctl start orgmap-cleanup.timer

log "waiting for the demo page"
for _ in $(seq 1 90); do
  curl -fsS http://127.0.0.1:8787/api/status >/dev/null 2>&1 && curl -fsS http://127.0.0.1:8501/_stcore/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:8501/_stcore/health >/dev/null || { log "the demo page did not start; see: journalctl -u orgmap-demo -u orgmap-server -n 50"; exit 1; }

# ---------------------------------------------------------------- 6. firewall: nothing inbound but SSH
if [ -z "$SKIP_FIREWALL" ]; then
  log "firewall: deny all inbound except SSH and Tailscale"
  { ufw default deny incoming && ufw default allow outgoing && ufw allow OpenSSH && ufw allow in on tailscale0 && ufw --force enable; } >/dev/null \
    || log "warning: could not configure ufw (the cloud provider's own firewall still applies)"
fi

# ---------------------------------------------------------------- 7. publish the demo page (only it) over HTTPS
url=""
if [ -n "$TS_AUTHKEY" ]; then
  command -v tailscale >/dev/null || { log "installing Tailscale"; curl -fsSL https://tailscale.com/install.sh | sh; }
  systemctl enable --now tailscaled >/dev/null 2>&1 || true
  tailscale up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME"
  if timeout 120 tailscale funnel --bg 8501; then
    url="https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  else
    log "Funnel is not allowed for this machine yet: approve it with the link above, then run: sudo tailscale funnel --bg 8501"
  fi
else
  log "no TS_AUTHKEY: the demo runs, but only on this server (http://127.0.0.1:8501). Set TS_AUTHKEY and run again to publish it."
fi

echo
log "done. Model: $OLLAMA_MODEL. Photos: $([ -n "$CLOUDINARY_API_SECRET" ] && echo Cloudinary || echo "this server's disk")."
[ -n "$url" ] && log "public address: $url"
log "status: systemctl status orgmap-server orgmap-demo   logs: journalctl -u orgmap-server -f   update: run this script again"
