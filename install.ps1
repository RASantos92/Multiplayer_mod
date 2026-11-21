# One-line installer for the Melvor Idle 2 friends-chat mod.
# Friends run this from PowerShell (see README):
#   irm https://raw.githubusercontent.com/RASantos92/Multiplayer_mod/main/install.ps1 | iex
#
# It downloads the latest release zip from this repository into
# %LOCALAPPDATA%\Melvor2Chat and runs the installer inside it.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $url = 'https://github.com/RASantos92/Multiplayer_mod/releases/latest/download/Melvor2Chat.zip'
    $base = Join-Path $env:LOCALAPPDATA 'Melvor2Chat'
    $zip = Join-Path $base 'Melvor2Chat.zip'
    $app = Join-Path $base 'app'

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

        if (Get-Process Melvor2 -ErrorAction SilentlyContinue) {
            throw 'Melvor Idle 2 is running. Close the game, then run this again.'
        }

        New-Item -ItemType Directory -Force $base | Out-Null
        Write-Host 'Downloading the chat mod (about 30 MB)...'
        Invoke-WebRequest $url -OutFile $zip -UseBasicParsing

        if (Test-Path $app) { Remove-Item $app -Recurse -Force }
        Expand-Archive $zip $app -Force
        Remove-Item $zip -Force

        # Run through powershell.exe so the default script policy on Windows does not block it.
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'Melvor2Chat\install.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'The installer reported a problem (see the message above).' }
    }
    catch {
        Write-Host ''
        Write-Host ('Could not install: ' + $_.Exception.Message) -ForegroundColor Red
    }
}
