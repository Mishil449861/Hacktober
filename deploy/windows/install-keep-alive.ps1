# Sets up this laptop to keep the OrgMap demo running while you're away:
#   - the "OrgMap keep-alive" scheduled task: runs keep-alive.ps1 at sign-in and every 5 minutes, hidden;
#   - closing the lid while plugged in does nothing (instead of sleeping).
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-keep-alive.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-keep-alive.ps1 -Remove   (undo both)
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'OrgMap keep-alive'
$script = Join-Path $PSScriptRoot 'keep-alive.ps1'
$launcher = Join-Path $PSScriptRoot 'keep-alive-hidden.vbs'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1   # Windows default: sleep
  powercfg /setactive SCHEME_CURRENT
  Write-Host "Removed the '$name' task; closing the lid sleeps the laptop again. Running demo processes keep running until you close them or restart."
  return
}

# A tiny launcher so the check runs with no window flashing up every 5 minutes. It waits for the check to
# finish (True), so the task counts as running meanwhile and Windows doesn't start an overlapping one.
Set-Content -Path $launcher -Encoding ASCII -Value @(
  "' Runs keep-alive.ps1 with no visible window (used by the '$name' scheduled task).",
  "CreateObject(""WScript.Shell"").Run ""powershell.exe -NoProfile -ExecutionPolicy Bypass -File """"$script"""""", 0, True"
)

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`""
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $atLogon, $every5 -Settings $settings -Force `
  -Description 'Keeps the OrgMap AI demo (model, server, demo page, public link) running. See deploy\windows\keep-alive.ps1.' | Out-Null

# Plugged in: closing the lid does nothing, so the laptop can sit closed. (Sleep/hibernate on power are left as they are.)
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT

Write-Host "Installed '$name' (at sign-in and every 5 minutes). Log: data\logs\keep-alive.log. Undo: -Remove"
