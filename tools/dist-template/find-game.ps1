# Finds the Melvor Idle 2 install folder by checking every Steam library.
function Find-Melvor2 {
    param([string]$GameDir)
    $marker = 'data_GamesByMalcs.Melvor2_windows_x86_64\GamesByMalcs.Melvor2.dll'
    $candidates = @()
    if ($GameDir) { $candidates += $GameDir }

    $steam = $null
    try { $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath } catch {}
    if (-not $steam) { $steam = 'C:\Program Files (x86)\Steam' }
    $libraries = @($steam)
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        foreach ($line in Get-Content $vdf) {
            if ($line -match '"path"\s+"(.+)"') { $libraries += $Matches[1].Replace('\\', '\') }
        }
    }
    foreach ($lib in $libraries) { $candidates += (Join-Path $lib 'steamapps\common\Melvor Idle 2') }

    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir $marker)) { return (Resolve-Path $dir).Path }
    }
    throw 'Could not find Melvor Idle 2. Run: install.cmd "D:\path\to\Melvor Idle 2"'
}
