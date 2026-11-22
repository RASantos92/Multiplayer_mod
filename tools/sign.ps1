# Code-signs files with Azure Artifact Signing (formerly Trusted Signing), so Windows Smart App Control
# accepts them. Dot-source this file, then call Invoke-CodeSign.
#
# Setup (once, see README "Code signing"):
#   1. Copy tools\signing.example.json to tools\signing.local.json and fill in your endpoint, account and
#      certificate profile names. These are not secrets, but the file is gitignored because it is per person.
#   2. Install the Azure CLI and run:  az login
#   3. dotnet tool install --global sign --prerelease
#
# No password or key is stored here: signing uses your Azure sign-in, and the private key never leaves Azure.

function Get-SigningConfig {
    $file = Join-Path $PSScriptRoot 'signing.local.json'
    if (-not (Test-Path $file)) { return $null }
    $config = Get-Content $file -Raw | ConvertFrom-Json
    foreach ($name in 'endpoint', 'account', 'certificateProfile') {
        if (-not $config.$name) { throw "tools\signing.local.json is missing '$name'." }
    }
    return $config
}

# Signs every listed file. Returns $true if all are signed and valid, $false if signing is not configured.
# Throws if signing was configured but failed, so an unsigned release is never produced by accident.
function Invoke-CodeSign {
    param([Parameter(Mandatory)][string[]]$Path)

    $config = Get-SigningConfig
    if (-not $config) {
        Write-Warning 'Code signing is not configured (tools\signing.local.json). Files are UNSIGNED and Windows Smart App Control may block them.'
        return $false
    }

    $sign = (Get-Command sign -ErrorAction SilentlyContinue).Source
    if (-not $sign) { $sign = Join-Path $env:USERPROFILE '.dotnet\tools\sign.exe' }
    if (-not (Test-Path $sign)) { throw 'The "sign" tool is not installed. Run: dotnet tool install --global sign --prerelease' }

    foreach ($file in $Path) {
        $full = (Resolve-Path $file).Path
        $dir = Split-Path $full -Parent
        $leaf = Split-Path $full -Leaf

        # Current option names first; older versions of the tool call the same service "trusted-signing".
        & $sign code artifact-signing `
            --artifact-signing-endpoint $config.endpoint `
            --artifact-signing-account $config.account `
            --artifact-signing-certificate-profile $config.certificateProfile `
            -b $dir $leaf
        if ($LASTEXITCODE -ne 0) {
            & $sign code trusted-signing -tse $config.endpoint -tsa $config.account -tscp $config.certificateProfile -b $dir $leaf
        }
        if ($LASTEXITCODE -ne 0) { throw "Signing failed for $leaf. Check 'az login' and your role on the certificate profile." }

        $signature = Get-AuthenticodeSignature $full
        if ($signature.Status -ne 'Valid') { throw "$leaf was signed but Windows reports its signature as '$($signature.Status)'." }
        Write-Host "Signed $leaf ($($signature.SignerCertificate.Subject))"
    }
    return $true
}
