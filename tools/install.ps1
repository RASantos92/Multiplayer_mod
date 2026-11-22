# Builds the mods and installs them into Melvor Idle 2.
#   - backs up saves
#   - keeps the original game DLL as GamesByMalcs.Melvor2.dll.orig
#   - patches the game DLL so it loads Melvor2.ModLoader.dll
#   - copies the loader next to the game DLL and the mods into <game>\mods
# Run again after every game update. Undo with uninstall.ps1.
param([string]$GameDir)

. "$PSScriptRoot\common.ps1"
. "$PSScriptRoot\sign.ps1"
$GameDir = Get-GameDir $GameDir
Assert-GameClosed

$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
if (-not $dotnet) { $dotnet = 'C:\Program Files\dotnet\dotnet.exe' }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'

$dataDir = Join-Path $GameDir $DataDirName
$gameDll = Join-Path $dataDir $GameDllName
$origDll = "$gameDll.orig"
$modsDir = Join-Path $GameDir 'mods'

# Refresh the reference copies so mods compile against the installed game version.
$refDir = Join-Path $RepoRoot 'game-ref'
New-Item -ItemType Directory -Force $refDir | Out-Null
Copy-Item "$dataDir\*.dll" $refDir -Force
# Never compile against a patched DLL: prefer the untouched original when one exists.
if (Test-Path $origDll) {
    $installed = [IO.File]::ReadAllText($gameDll, [Text.Encoding]::GetEncoding(28591))
    if ($installed.Contains('Melvor2ModBootstrap')) { Copy-Item $origDll (Join-Path $refDir $GameDllName) -Force }
}

Write-Host 'Building...'
foreach ($proj in 'tools\Melvor2.Patcher', 'src\Melvor2.ModLoader', 'src\Melvor2.Chat') {
    & $dotnet build (Join-Path $RepoRoot $proj) -c Release -v q --nologo | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $proj" }
}

# Sign the freshly built DLLs when signing is configured, so Smart App Control accepts this dev build too.
$built = @((Join-Path $RepoRoot "src\Melvor2.ModLoader\bin\Release\net10.0\$LoaderDllName"),
           (Join-Path $RepoRoot 'src\Melvor2.Chat\bin\Release\net10.0\Melvor2.Chat.dll'))
Invoke-CodeSign -Path $built | Out-Null

Backup-Saves

# Always patch from an untouched original, into a temp file first.
#   - installed DLL unpatched (first install, or Steam updated it): it becomes the new .orig
#   - installed DLL already patched: re-patch from the existing .orig so patcher changes take effect
$patcher = Join-Path $RepoRoot 'tools\Melvor2.Patcher\bin\Release\net10.0\Melvor2.Patcher.dll'
$tmp = "$gameDll.patched.tmp"
$installedText = [IO.File]::ReadAllText($gameDll, [Text.Encoding]::GetEncoding(28591))
if ($installedText.Contains('Melvor2ModBootstrap')) {
    if (-not (Test-Path $origDll)) { throw 'Game DLL is patched but no .orig exists. Verify game files in Steam, then run again.' }
} else {
    Copy-Item $gameDll $origDll -Force
}
& $dotnet $patcher $origDll $tmp
if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -ErrorAction SilentlyContinue; throw 'Patching failed. Game DLL was not changed.' }
Move-Item $tmp $gameDll -Force
Write-Host 'Game DLL patched. Original kept as .orig'

Copy-Item (Join-Path $RepoRoot "src\Melvor2.ModLoader\bin\Release\net10.0\$LoaderDllName") $dataDir -Force
New-Item -ItemType Directory -Force $modsDir | Out-Null
Copy-Item (Join-Path $RepoRoot 'src\Melvor2.Chat\bin\Release\net10.0\Melvor2.Chat.dll') $modsDir -Force

Write-Host "Installed. Mods folder: $modsDir"
