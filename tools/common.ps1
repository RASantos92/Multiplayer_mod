# Shared paths and helpers for the install scripts.
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path $PSScriptRoot -Parent
$DataDirName = 'data_GamesByMalcs.Melvor2_windows_x86_64'
$GameDllName = 'GamesByMalcs.Melvor2.dll'
$LoaderDllName = 'Melvor2.ModLoader.dll'

function Get-GameDir {
    param([string]$GameDir)
    if (-not $GameDir) { $GameDir = 'C:\Program Files (x86)\Steam\steamapps\common\Melvor Idle 2' }
    if (-not (Test-Path (Join-Path $GameDir "$DataDirName\$GameDllName"))) {
        throw "Melvor Idle 2 not found at '$GameDir'. Pass -GameDir with your install folder."
    }
    return $GameDir
}

function Assert-GameClosed {
    if (Get-Process Melvor2 -ErrorAction SilentlyContinue) {
        throw 'Melvor Idle 2 is running. Close the game first, then run this again.'
    }
}

function Backup-Saves {
    $saves = Join-Path $env:APPDATA 'Games By Malcs\Melvor Idle 2\steam'
    if (-not (Test-Path $saves)) { Write-Host 'No saves found to back up.'; return }
    $dest = Join-Path $RepoRoot ("save-backups\" + (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
    Copy-Item $saves $dest -Recurse -Force
    Write-Host "Saves backed up to $dest"
}
