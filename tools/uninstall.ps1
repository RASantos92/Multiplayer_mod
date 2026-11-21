# Removes the mods and restores the original game DLL.
# If anything looks wrong afterwards, use Steam: Properties > Installed Files > Verify integrity.
param([string]$GameDir)

. "$PSScriptRoot\common.ps1"
$GameDir = Get-GameDir $GameDir
Assert-GameClosed

$dataDir = Join-Path $GameDir $DataDirName
$gameDll = Join-Path $dataDir $GameDllName
$origDll = "$gameDll.orig"

if (Test-Path $origDll) {
    Move-Item $origDll $gameDll -Force
    Write-Host 'Original game DLL restored.'
} else {
    Write-Host 'No .orig backup found; game DLL left as is.'
}

Remove-Item (Join-Path $dataDir $LoaderDllName) -ErrorAction SilentlyContinue
Remove-Item (Join-Path $GameDir 'mods\Melvor2.Chat.dll') -ErrorAction SilentlyContinue
Write-Host 'Mods removed.'
