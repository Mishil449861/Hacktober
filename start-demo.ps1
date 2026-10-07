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
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$PSScriptRoot'; npm run dev"
  Write-Host 'Starting the OrgMap server...'
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
}

Write-Host ''
Write-Host 'Demo: http://localhost:8501' -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop the demo; close the other window to stop the server.'
& .\.venv\Scripts\python.exe -m streamlit run demo\app.py --server.port 8501 --browser.gatherUsageStats false
