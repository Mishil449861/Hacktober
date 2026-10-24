# OrgMap AI keep-alive for leaving the demo running unattended on this laptop (e.g. while judges test it).
# Checks the local model, the server, the demo page and the public Tailscale link, and starts whatever is
# down. Only acts on what is down, so it is safe to run any time. Run every 5 minutes and at sign-in by the
# "OrgMap keep-alive" scheduled task (install-keep-alive.ps1). Log: data\logs\keep-alive.log
$ErrorActionPreference = 'Continue'
# One check at a time: two overlapping runs would each start a server and a demo page.
$mutex = New-Object System.Threading.Mutex($false, 'Local\OrgMapKeepAlive')
if (-not $mutex.WaitOne(0)) { exit 0 }
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # deploy\windows -> project folder
Set-Location $root
$logs = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$log = Join-Path $logs 'keep-alive.log'
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item $log "$log.old" -Force }
function Log([string]$m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" -Encoding UTF8 }
function Healthy([string]$url) { try { (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 15).StatusCode -eq 200 } catch { $false } }
function WaitFor([string]$url, [int]$seconds) { $t = (Get-Date).AddSeconds($seconds); while ((Get-Date) -lt $t) { if (Healthy $url) { return $true }; Start-Sleep 2 }; $false }
# A port held by one of our own processes that stopped answering: end it so it can be started again.
function FreePort([int]$port) {
  foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -match '^(node|python|pythonw)$') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Log "stopped unresponsive $($p.ProcessName) on port $port" }
  }
}

# 1. Local model (Ollama)
if (-not (Healthy 'http://127.0.0.1:11434/api/version')) {
  $app = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
  if (Test-Path $app) { Start-Process $app } else { Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden }
  Log "Ollama was down: started ($(if (WaitFor 'http://127.0.0.1:11434/api/version' 60) { 'up' } else { 'still not answering' }))"
}

# 2. OrgMap server (API only; the graph editor isn't needed for the demo)
if (-not (Healthy 'http://127.0.0.1:8787/api/status')) {
  FreePort 8787
  Start-Process -FilePath 'node' -ArgumentList '--import', 'tsx', 'server/index.ts' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'server.err.log')
  Log "server was down: started ($(if (WaitFor 'http://127.0.0.1:8787/api/status' 90) { 'up' } else { 'still not answering, see server.err.log' }))"
}

# 3. Demo page
if (-not (Healthy 'http://127.0.0.1:8501/_stcore/health')) {
  FreePort 8501
  $py = Join-Path $root '.venv\Scripts\python.exe'
  Start-Process -FilePath $py -ArgumentList '-m', 'streamlit', 'run', 'demo\app.py', '--server.port', '8501', '--server.headless', 'true' `
    -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'demo.log') -RedirectStandardError (Join-Path $logs 'demo.err.log')
  Log "demo page was down: started ($(if (WaitFor 'http://127.0.0.1:8501/_stcore/health' 90) { 'up' } else { 'still not answering, see demo.err.log' }))"
}

# 4. Public link (Tailscale Funnel to the demo page)
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $ts) {
  $funnel = (& $ts funnel status 2>&1) -join "`n"
  if ($funnel -notmatch '127\.0\.0\.1:8501') {
    & $ts funnel --bg 8501 2>&1 | Out-Null
    Log 'public link was off: turned Tailscale Funnel back on'
  }
}
