# Installs the Melvor Idle 2 friends-chat mod. Run install.cmd (double-click) with the game closed.
# Run it again after every game update. Undo with uninstall.cmd.
param([string]$GameDir)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\find-game.ps1"

$GameDir = Find-Melvor2 $GameDir
if (Get-Process Melvor2 -ErrorAction SilentlyContinue) { throw 'Melvor Idle 2 is running. Close it and run this again.' }

$dataDir = Join-Path $GameDir 'data_GamesByMalcs.Melvor2_windows_x86_64'
$gameDll = Join-Path $dataDir 'GamesByMalcs.Melvor2.dll'
$origDll = "$gameDll.orig"
$tmp = "$gameDll.patched.tmp"

# Back up saves next to this script.
$saves = Join-Path $env:APPDATA 'Games By Malcs\Melvor Idle 2\steam'
if (Test-Path $saves) {
    $dest = Join-Path $PSScriptRoot ('save-backups\' + (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
    Copy-Item $saves $dest -Recurse -Force
    Write-Host "Saves backed up to $dest"
}

# Always patch from an untouched original.
$installedText = [IO.File]::ReadAllText($gameDll, [Text.Encoding]::GetEncoding(28591))
if ($installedText.Contains('Melvor2ModBootstrap')) {
    if (-not (Test-Path $origDll)) { throw 'Game DLL is patched but no .orig exists. In Steam, verify the game files, then run this again.' }
} else {
    Copy-Item $gameDll $origDll -Force
}
& (Join-Path $PSScriptRoot 'patcher\Melvor2.Patcher.exe') $origDll $tmp
if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -ErrorAction SilentlyContinue; throw 'Patching failed. The game was not changed.' }
Move-Item $tmp $gameDll -Force

Copy-Item (Join-Path $PSScriptRoot 'files\Melvor2.ModLoader.dll') $dataDir -Force
$modsDir = Join-Path $GameDir 'mods'
New-Item -ItemType Directory -Force $modsDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'files\Melvor2.Chat.dll') $modsDir -Force

Write-Host ''
Write-Host "Installed into $GameDir"
Write-Host 'Start the game from Steam. Open chat with the Chat button (bottom right) or F8.'
