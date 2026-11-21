# One-line uninstaller for the Melvor Idle 2 friends-chat mod.
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/RASantos92/Multiplayer_mod/main/uninstall.ps1 | iex"
#
# Uses the copy the installer left in %LOCALAPPDATA%\Melvor2Chat, downloading it again if it is gone.

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $url = 'https://github.com/RASantos92/Multiplayer_mod/releases/latest/download/Melvor2Chat.zip'
    $base = Join-Path $env:LOCALAPPDATA 'Melvor2Chat'
    $zip = Join-Path $base 'Melvor2Chat.zip'
    $app = Join-Path $base 'app'
    $script = Join-Path $app 'Melvor2Chat\uninstall.ps1'

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

        if (Get-Process Melvor2 -ErrorAction SilentlyContinue) {
            throw 'Melvor Idle 2 is running. Close the game, then run this again.'
        }

        if (-not (Test-Path $script)) {
            New-Item -ItemType Directory -Force $base | Out-Null
            Write-Host 'Downloading the uninstaller...'
            Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
            Expand-Archive $zip $app -Force
            Remove-Item $zip -Force
        }

        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
        if ($LASTEXITCODE -ne 0) { throw 'The uninstaller reported a problem (see the message above).' }
    }
    catch {
        Write-Host ''
        Write-Host ('Could not uninstall: ' + $_.Exception.Message) -ForegroundColor Red
    }
}
