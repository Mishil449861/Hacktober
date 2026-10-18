# One command to run OrgMap AI and its demo on this laptop.
#   .\start-demo.ps1
# If PowerShell blocks scripts:  powershell -ExecutionPolicy Bypass -File .\start-demo.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 1. Ollama must be running with a vision model.
try { Invoke-RestMethod http://localhost:11434/api/version -TimeoutSec 3 | Out-Null }
catch { Write-Host 'Ollama is not running. Start the Ollama app (or run "ollama serve"), then run this again.' -ForegroundColor Red; exit 1 }
if (-not (ollama list | Select-String 'vl|vision|llava|minicpm|gemma3')) {
  Write-Host 'No vision model found. Run:  ollama pull qwen2.5vl:7b' -ForegroundColor Yellow
}

# 2. Dependencies (first run only).
if (-not (Test-Path node_modules)) { Write-Host 'Installing Node packages...'; npm install }
if (-not (Test-Path .venv\Scripts\python.exe)) {
  Write-Host 'Creating Python environment (.venv)...'
  python -m venv .venv
  & .\.venv\Scripts\python.exe -m pip install --quiet -r demo\requirements.txt
}
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host 'Created .env from .env.example (add your Cloudinary keys there).' }

# 3. API server in its own window, then the demo page in this one.
if (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)) {
  # Minimized and clearly labelled, so it isn't closed by accident: closing it stops the server.
  $serverCmd = "`$host.UI.RawUI.WindowTitle = 'OrgMap server - keep this window open'; Set-Location '$PSScriptRoot'; " +
    "Write-Host 'OrgMap server. Keep this window open while you use the demo; close it to stop the server.' -ForegroundColor Yellow; npm run dev"
  Start-Process powershell -WindowStyle Minimized -ArgumentList '-NoExit', '-Command', $serverCmd
  Write-Host 'Starting the OrgMap server in a minimized window (taskbar: "OrgMap server - keep this window open")...'
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
}

Write-Host ''
Write-Host 'Demo: http://localhost:8501' -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop the demo page. Close the minimized "OrgMap server" window to stop the server.'
# The page runs in presentation mode (see .streamlit\config.toml), so open the browser ourselves once it is up.
Start-Process powershell -WindowStyle Hidden -ArgumentList '-Command', "Start-Sleep 6; Start-Process 'http://localhost:8501'"
& .\.venv\Scripts\python.exe -m streamlit run demo\app.py --server.port 8501 --browser.gatherUsageStats false
