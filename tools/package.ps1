# Builds dist\Melvor2Chat.zip for friends (upload it to a GitHub release): mod DLLs, a self-contained patcher
# (no .NET install needed on their PC) and double-click install/uninstall scripts.
# Contains none of the game's own files.
param([string]$Version = '0.7.0')

. "$PSScriptRoot\common.ps1"
. "$PSScriptRoot\sign.ps1"
$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
if (-not $dotnet) { $dotnet = 'C:\Program Files\dotnet\dotnet.exe' }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'

# Fixed names so the "latest release" download link in README never changes.
$name = 'Melvor2Chat'
$stage = Join-Path $RepoRoot "dist\$name"
$zip = Join-Path $RepoRoot "dist\$name.zip"
Remove-Item $stage, $zip -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage\files", "$stage\patcher" | Out-Null

foreach ($proj in 'src\Melvor2.ModLoader', 'src\Melvor2.Chat') {
    & $dotnet build (Join-Path $RepoRoot $proj) -c Release -v q --nologo | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $proj" }
}
& $dotnet publish (Join-Path $RepoRoot 'tools\Melvor2.Patcher') -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:DebugType=none `
    -o "$stage\patcher" -v q --nologo | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Patcher publish failed.' }

Copy-Item (Join-Path $RepoRoot 'src\Melvor2.ModLoader\bin\Release\net10.0\Melvor2.ModLoader.dll') "$stage\files"
Copy-Item (Join-Path $RepoRoot 'src\Melvor2.Chat\bin\Release\net10.0\Melvor2.Chat.dll') "$stage\files"
Copy-Item (Join-Path $PSScriptRoot 'dist-template\*') $stage
Set-Content (Join-Path $stage 'VERSION.txt') $Version -Encoding ascii

# Sign everything Windows will be asked to run or load: the mod DLLs, the patcher and the scripts.
$toSign = @("$stage\files\Melvor2.ModLoader.dll", "$stage\files\Melvor2.Chat.dll", "$stage\patcher\Melvor2.Patcher.exe") +
    (Get-ChildItem $stage -Filter *.ps1 | ForEach-Object FullName)
$signed = Invoke-CodeSign -Path $toSign
Set-Content (Join-Path $stage 'SIGNED.txt') $(if ($signed) { 'signed' } else { 'unsigned' }) -Encoding ascii

Compress-Archive -Path $stage -DestinationPath $zip
Write-Host "Created $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB), $(if ($signed) { 'SIGNED' } else { 'UNSIGNED' })"
