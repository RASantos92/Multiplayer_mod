# Removes the friends-chat mod and restores the original game DLL. Run uninstall.cmd with the game closed.
param([string]$GameDir)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\find-game.ps1"

$GameDir = Find-Melvor2 $GameDir
if (Get-Process Melvor2 -ErrorAction SilentlyContinue) { throw 'Melvor Idle 2 is running. Close it and run this again.' }

$dataDir = Join-Path $GameDir 'data_GamesByMalcs.Melvor2_windows_x86_64'
$gameDll = Join-Path $dataDir 'GamesByMalcs.Melvor2.dll'
$origDll = "$gameDll.orig"

if (Test-Path $origDll) {
    Move-Item $origDll $gameDll -Force
    Write-Host 'Original game DLL restored.'
} else {
    Write-Host 'No .orig backup found. If the game misbehaves, verify the game files in Steam.'
}
Remove-Item (Join-Path $dataDir 'Melvor2.ModLoader.dll') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $GameDir 'mods\Melvor2.Chat.dll') -ErrorAction SilentlyContinue
Write-Host 'Mod removed.'
