<#
.SYNOPSIS
  Uninstalls the World Monitor desktop app on Windows.

.DESCRIPTION
  Runs the bundled NSIS/MSI uninstaller for each installed variant, then
  removes leftover app data (unless -KeepData) and Credential Manager
  secrets (unless -KeepSecrets).

  macOS/Linux users: use scripts/uninstall-desktop.sh instead.

.PARAMETER Variant
  Which desktop variant to uninstall: world, tech, finance, or all (default).

.PARAMETER KeepData
  Keep app data, caches, and logs under %APPDATA% / %LOCALAPPDATA%.

.PARAMETER KeepSecrets
  Keep API keys stored in Windows Credential Manager.

.PARAMETER DryRun
  Show what would be removed without removing anything.

.PARAMETER Yes
  Skip the confirmation prompt.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall-desktop.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [ValidateSet('world', 'tech', 'finance', 'all')]
  [string]$Variant = 'all',
  [switch]$KeepData,
  [switch]$KeepSecrets,
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

# variant -> product name / binary name / bundle identifier
# (mirrors src-tauri/tauri*.conf.json)
$AllVariants = @{
  world   = @{ Product = 'World Monitor';   Binary = 'world-monitor';   Identifier = 'app.worldmonitor.desktop' }
  tech    = @{ Product = 'Tech Monitor';    Binary = 'tech-monitor';    Identifier = 'app.worldmonitor.tech.desktop' }
  finance = @{ Product = 'Finance Monitor'; Binary = 'finance-monitor'; Identifier = 'app.worldmonitor.finance.desktop' }
}
$KeyringService = 'world-monitor'

$Selected = if ($Variant -eq 'all') { @('world', 'tech', 'finance') } else { @($Variant) }

function Find-Uninstallers {
  param([string]$Product)
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

function Stop-VariantProcesses {
  param([hashtable]$Info)
  # Best-effort: stop the main binary and any bundled sidecar Node runtime
  # (matches the NSIS pre-uninstall hook in src-tauri/nsis/installer-hooks.nsh).
  Get-Process -Name $Info.Binary -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath -match 'resources\\sidecar\\node' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# Collect what exists
$uninstallers = @()
$dataDirs = @()
foreach ($v in $Selected) {
  $info = $AllVariants[$v]
  foreach ($entry in (Find-Uninstallers -Product $info.Product)) {
    $uninstallers += @{ Variant = $v; Entry = $entry }
  }
  if (-not $KeepData) {
    foreach ($dir in @(
      (Join-Path $env:APPDATA $info.Identifier),
      (Join-Path $env:LOCALAPPDATA $info.Identifier)
    )) {
      if (Test-Path $dir) { $dataDirs += $dir }
    }
  }
}

# Credential Manager entries (shared by all variants; only offered on -Variant all)
$credTargets = @()
if (-not $KeepSecrets -and $Variant -eq 'all') {
  $credTargets = cmdkey /list 2>$null |
    Where-Object { $_ -match 'Target:' -and $_ -match [regex]::Escape($KeyringService) } |
    ForEach-Object { ($_ -split 'Target:\s*', 2)[1].Trim() }
}

if ($uninstallers.Count -eq 0 -and $dataDirs.Count -eq 0 -and $credTargets.Count -eq 0) {
  Write-Host 'Nothing to uninstall — no World Monitor desktop installation found.'
  exit 0
}

Write-Host 'The following will be removed:'
foreach ($u in $uninstallers) {
  Write-Host "  $($u.Entry.DisplayName) $($u.Entry.DisplayVersion) (via bundled uninstaller)"
}
foreach ($d in $dataDirs) { Write-Host "  $d" }
foreach ($c in $credTargets) { Write-Host "  Credential Manager entry: $c" }

if ($DryRun) {
  Write-Host 'Dry run — nothing was removed.'
  exit 0
}

if (-not $Yes) {
  $answer = Read-Host 'Proceed? [y/N]'
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host 'Aborted.'
    exit 1
  }
}

foreach ($v in $Selected) {
  Stop-VariantProcesses -Info $AllVariants[$v]
}

foreach ($u in $uninstallers) {
  $cmd = $u.Entry.UninstallString
  Write-Host "Running uninstaller for $($u.Entry.DisplayName)..."
  if ($cmd -match 'msiexec') {
    # MSI: switch to quiet uninstall by product code
    $productCode = if ($u.Entry.PSChildName -match '^\{.*\}$') { $u.Entry.PSChildName } else { $null }
    if ($productCode) {
      Start-Process 'msiexec.exe' -ArgumentList "/x $productCode /qb" -Wait
    } else {
      Start-Process 'cmd.exe' -ArgumentList "/c $cmd /qb" -Wait
    }
  } else {
    # NSIS: /S = silent
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

Write-Host 'Done. World Monitor desktop has been uninstalled.'
