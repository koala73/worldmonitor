<#
.SYNOPSIS
  Opens the built artifact of 全球实时热点追踪·探长版.

.DESCRIPTION
  This launcher belongs to the WorldMonitor-based mother workspace. It does not
  reuse, overwrite, stop, or probe the legacy Global Intelligence Earth Express
  services. The Tauri desktop executable owns its local sidecar and opens the
  native overview; markets and stocks remain reachable from the in-app market
  workspace.

  It is deliberately path-safe for Chinese Windows paths and PowerShell 5.1.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# PowerShell 5 defaults to an OEM output encoding. Set UTF-8 only for this
# process so Chinese product and path text survives logs and error dialogs.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$ProductBrand = '全球实时热点追踪·探长版'
$DesktopProcessName = 'global-intelligence-earth'
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$DesktopInstallerDirectory = Join-Path $ProjectRoot 'src-tauri\target\release\bundle\nsis'
$DesktopInstaller = Join-Path $DesktopInstallerDirectory "$ProductBrand`_2.10.0_x64-setup.exe"

function Get-InstalledDesktopExecutable {
  # A Tauri Windows executable is not self-contained: the packaged frontend
  # assets live beside it in the NSIS-installed application directory. Never
  # launch the bare target\release executable, because it cannot resolve
  # index.html outside that installed resource layout.
  $programFiles = [Environment]::GetFolderPath('ProgramFiles')
  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  $candidatePaths = @(
    (Join-Path (Join-Path $localAppData $ProductBrand) "$DesktopProcessName.exe"),
    (Join-Path (Join-Path $programFiles $ProductBrand) "$DesktopProcessName.exe")
  )

  foreach ($candidate in $candidatePaths) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return $null
}

function Install-DesktopApplicationIfNeeded {
  param([Parameter(Mandatory)][string]$InstallerPath)

  if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "未找到桌面安装包：$InstallerPath。请先在母体项目中运行 npm run desktop:tauri:build；此启动器不会回退到旧项目服务。"
  }

  # The NSIS installer is the canonical distribution artifact. It is safe to
  # rerun: it installs only this product's per-user directory and preserves the
  # legacy project untouched. Waiting here avoids ever launching a bare build
  # executable with incomplete resource layout.
  $installProcess = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru
  if ($installProcess.ExitCode -ne 0) {
    throw "$ProductBrand 安装失败（退出码：$($installProcess.ExitCode)）。"
  }
}

function Show-LauncherError {
  param([Parameter(Mandatory)][string]$Message)

  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(
      $Message,
      "$ProductBrand - 启动失败",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    )
  }
  catch {
    Write-Error $Message
  }
}

$launcherMutex = [System.Threading.Mutex]::new($false, 'GlobalIntelligenceEarthMotherDesktopLauncher')
if (-not $launcherMutex.WaitOne(0)) {
  # A simultaneous double-click is already checking the exact same executable.
  exit 0
}

try {
  $DesktopExecutable = Get-InstalledDesktopExecutable
  if ([string]::IsNullOrWhiteSpace($DesktopExecutable)) {
    Install-DesktopApplicationIfNeeded -InstallerPath $DesktopInstaller
    $DesktopExecutable = Get-InstalledDesktopExecutable
  }
  if ([string]::IsNullOrWhiteSpace($DesktopExecutable)) {
    throw "未找到已安装的 $ProductBrand。已执行安装包但未定位到应用；请检查目录：$DesktopInstallerDirectory。此启动器不会回退到旧项目服务，也不会启动裸构建二进制。"
  }

  # The native Tauri process starts and supervises its own first-party local
  # sidecar. There is no separate legacy backend service or fixed HTTP port for
  # this launcher to start, test, or expose.
  $running = @(Get-Process -Name $DesktopProcessName -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -eq $DesktopExecutable
  })
  if ($running.Count -gt 0) {
    Write-Host "$ProductBrand 已在运行；保留现有桌面窗口。"
    exit 0
  }

  $process = Start-Process -FilePath $DesktopExecutable -WorkingDirectory $ProjectRoot -PassThru
  Start-Sleep -Milliseconds 750
  if ($process.HasExited) {
    throw "$ProductBrand 未能保持运行（退出码：$($process.ExitCode)）。请检查桌面日志。"
  }

  Write-Host "$ProductBrand 已打开原生总览入口；股票入口可从应用内市场面板进入。"
}
catch {
  Show-LauncherError -Message $_.Exception.Message
  exit 1
}
finally {
  $launcherMutex.ReleaseMutex()
  $launcherMutex.Dispose()
}
