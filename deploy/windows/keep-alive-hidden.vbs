' Runs keep-alive.ps1 with no visible window (used by the 'OrgMap keep-alive' scheduled task).
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\mishi\OneDrive\Desktop\Hacktober\deploy\windows\keep-alive.ps1""", 0, True
