<#
.SYNOPSIS
  Creates or refreshes the Desktop shortcut for 全球实时热点追踪·探长版.

.DESCRIPTION
  The shortcut deliberately targets the new mother-workspace launcher, never
  the legacy launcher. It uses PowerShell's absolute executable path and quoted
  arguments so the product opens correctly from Chinese Windows paths.
#>

[CmdletBinding()]
param(
  [string]$DesktopDirectory = [Environment]::GetFolderPath('DesktopDirectory')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$ProductBrand = '全球实时热点追踪·探长版'
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$LauncherPath = Join-Path $PSScriptRoot 'Launch-Global-Intelligence-Earth-Mother.ps1'
$IconPath = Join-Path $ProjectRoot 'src-tauri\icons\icon.ico'
$ShortcutPath = Join-Path $DesktopDirectory "$ProductBrand.lnk"
$PowerShellExecutable = Join-Path $PSHOME 'powershell.exe'

if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) {
  throw "启动器不存在：$LauncherPath"
}
if (-not (Test-Path -LiteralPath $PowerShellExecutable -PathType Leaf)) {
  throw "无法定位 Windows PowerShell：$PowerShellExecutable"
}
if (-not (Test-Path -LiteralPath $DesktopDirectory -PathType Container)) {
  throw "桌面目录不存在：$DesktopDirectory"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $PowerShellExecutable
$shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$LauncherPath`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.Description = "$ProductBrand 原生桌面总览与股票入口"
if (Test-Path -LiteralPath $IconPath -PathType Leaf) {
  $shortcut.IconLocation = "$IconPath,0"
}
$shortcut.Save()

Write-Output "Desktop shortcut created: $ShortcutPath"
