<#
.SYNOPSIS
  Uninstalls the World Monitor desktop app on Windows.

.DESCRIPTION
  One binary ships for every variant (variants are switched in-app), so there
  is one product to remove. The script runs the bundled NSIS or MSI
  uninstaller found in the registry (the same one as Settings > Apps), then
  removes the app data the uninstaller leaves behind (unless -KeepData) and
  the Credential Manager entries (unless -KeepSecrets).

  Everything found is listed and confirmed before removal. Run from a
  repository checkout; the manual steps are in docs/desktop-app.mdx under
  "Uninstall". macOS and Linux: scripts/uninstall-desktop.sh.

  Set WM_UNINSTALL_SKIP_PROCESS_STOP=1 to skip stopping the running app.

.PARAMETER KeepData
  Keep app data, caches, WebView storage and logs under %APPDATA% and %LOCALAPPDATA%.

.PARAMETER KeepSecrets
  Keep API keys and sign-in state stored in Windows Credential Manager.

.PARAMETER DryRun
  Show what would be removed without removing anything.

.PARAMETER Yes
  Skip the confirmation prompt.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall-desktop.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$KeepData,
  [switch]$KeepSecrets,
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

# Mirrors src-tauri/tauri.conf.json and src-tauri/src/main.rs; the test in
# tests/desktop-uninstall-scripts.test.mjs fails when they drift.
$Product = 'World Monitor'
$Binary = 'world-monitor'
$Identifier = 'app.worldmonitor.desktop'
$KeyringService = 'world-monitor'

function Find-Uninstallers {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $found = @()
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($props.DisplayName -eq $Product -and $props.UninstallString) {
        $found += $props
      }
    }
  }
  return $found
}

function Get-InstallDirs {
  param([array]$Entries)
  # The install directory from the registry when the uninstaller recorded it,
  # plus the two locations the NSIS installer offers. Process stops are scoped
  # to these directories, the same way the NSIS pre-uninstall hook scopes its
  # own stop to $INSTDIR, so no Node process outside the install is touched.
  $dirs = @()
  foreach ($entry in $Entries) {
    if ($entry.InstallLocation) { $dirs += $entry.InstallLocation.TrimEnd('\') }
  }
  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA "Programs\$Product"),
    (Join-Path $env:ProgramFiles $Product)
  )) {
    if (Test-Path $candidate) { $dirs += $candidate.TrimEnd('\') }
  }
  return @($dirs | Select-Object -Unique)
}

function Stop-InstalledProcesses {
  param([array]$InstallDirs)
  if ($env:WM_UNINSTALL_SKIP_PROCESS_STOP -eq '1') { return }
  if ($InstallDirs.Count -eq 0) { return }
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $path = $_.ExecutablePath
      $path -and ($InstallDirs | Where-Object { $path.StartsWith("$_\", [System.StringComparison]::OrdinalIgnoreCase) })
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$uninstallers = @(Find-Uninstallers)
$installDirs = Get-InstallDirs -Entries $uninstallers

$dataDirs = @()
if (-not $KeepData) {
  foreach ($dir in @(
    (Join-Path $env:APPDATA $Identifier),
    (Join-Path $env:LOCALAPPDATA $Identifier)
  )) {
    if (Test-Path $dir) { $dataDirs += $dir }
  }
}

$credTargets = @()
if (-not $KeepSecrets) {
  $credTargets = @(cmdkey /list 2>$null |
    Where-Object { $_ -match 'Target:' -and $_ -match [regex]::Escape($KeyringService) } |
    ForEach-Object { ($_ -split 'Target:\s*', 2)[1].Trim() })
}

if ($uninstallers.Count -eq 0 -and $dataDirs.Count -eq 0 -and $credTargets.Count -eq 0) {
  Write-Host "Nothing to uninstall: no $Product desktop installation found."
  exit 0
}

Write-Host 'The following will be removed:'
foreach ($u in $uninstallers) {
  Write-Host "  $($u.DisplayName) $($u.DisplayVersion) (via bundled uninstaller)"
}
foreach ($d in $dataDirs) { Write-Host "  $d" }
foreach ($c in $credTargets) { Write-Host "  Credential Manager entry: $c" }

if ($DryRun) {
  Write-Host 'Dry run: nothing was removed.'
  exit 0
}

if (-not $Yes) {
  $answer = Read-Host 'Proceed? [y/N]'
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host 'Aborted.'
    exit 1
  }
}

Stop-InstalledProcesses -InstallDirs $installDirs

foreach ($u in $uninstallers) {
  $cmd = $u.UninstallString
  Write-Host "Running uninstaller for $($u.DisplayName)..."
  if ($cmd -match 'msiexec') {
    $productCode = if ($u.PSChildName -match '^\{.*\}$') { $u.PSChildName } else { $null }
    if ($productCode) {
      Start-Process 'msiexec.exe' -ArgumentList "/x $productCode /qb" -Wait
    } else {
      Start-Process 'cmd.exe' -ArgumentList "/c $cmd /qb" -Wait
    }
  } else {
    # NSIS: /S runs silently; its pre-uninstall hook stops the bundled sidecar.
    if ($cmd.StartsWith('"')) {
      $exe, $rest = $cmd -split '(?<=")\s+', 2
      Start-Process $exe.Trim('"') -ArgumentList "$rest /S".Trim() -Wait
    } else {
      Start-Process $cmd -ArgumentList '/S' -Wait
    }
  }
}

foreach ($d in $dataDirs) {
  if (Test-Path $d) {
    Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed $d"
  }
}

foreach ($c in $credTargets) {
  cmdkey /delete:$c | Out-Null
  Write-Host "Removed Credential Manager entry: $c"
}

Write-Host "Done. $Product desktop has been uninstalled."
