; Stop bundled sidecar runtimes before NSIS copies/deletes files.
; This avoids "Error opening file for writing ... sidecar ... node ... .exe"
; when an orphaned local API process keeps the runtime locked.
!macro WM_KILL_BUNDLED_SIDECAR_NODE
  System::Call 'kernel32::SetEnvironmentVariable(t, t)i("WM_INSTDIR", "$INSTDIR").r0'
  nsExec::ExecToLog "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $\"$$ErrorActionPreference='SilentlyContinue'; $$inst=$$env:WM_INSTDIR; if ($$inst) { $$targets=@((Join-Path $$inst 'resources\sidecar\node\node.exe'),(Join-Path $$inst 'resources\sidecar\node.node.exe'),(Join-Path $$inst 'resources\sidecar\node.exe')); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$targets -contains $$_.ExecutablePath) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force } }$\""
  Pop $R0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WM_KILL_BUNDLED_SIDECAR_NODE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WM_KILL_BUNDLED_SIDECAR_NODE
!macroend
