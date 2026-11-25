# Read-only check for the Melvor Idle 2 chat and guild mod. Run it from the README line:
#   powershell -NoExit -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/RASantos92/Multiplayer_mod/main/check.ps1 | iex"
#
# Prints whether the game DLL is patched, which mod files are present and the mod's lines from the game log.
# It changes nothing, sends nothing, and does not read the guild key in mod-data.

& {
  $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
  if (-not $steam) { $steam = 'C:\Program Files (x86)\Steam' }
  $libs = @($steam)
  $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
  if (Test-Path $vdf) { Get-Content $vdf | ForEach-Object { if ($_ -match '"path"\s+"(.+)"') { $libs += $Matches[1].Replace('\\', '\') } } }
  $game = $libs | ForEach-Object { Join-Path $_ 'steamapps\common\Melvor Idle 2' } | Where-Object { Test-Path (Join-Path $_ 'Melvor2.exe') } | Select-Object -First 1
  '=== Melvor 2 mod check ==='
  if (-not $game) { 'Game folder: NOT FOUND'; return }
  $data = Join-Path $game 'data_GamesByMalcs.Melvor2_windows_x86_64'
  $dll = Join-Path $data 'GamesByMalcs.Melvor2.dll'
  $patched = [IO.File]::ReadAllText($dll, [Text.Encoding]::GetEncoding(28591)).Contains('Melvor2ModBootstrap')
  "Game running now:   $([bool](Get-Process Melvor2 -ErrorAction SilentlyContinue))"
  "Game DLL patched:   $patched   (changed $((Get-Item $dll).LastWriteTime))"
  foreach ($f in "$data\GamesByMalcs.Melvor2.dll.orig", "$data\Melvor2.ModLoader.dll", "$game\mods\Melvor2.Chat.dll", "$game\override.cfg") {
    $i = Get-Item $f -ErrorAction SilentlyContinue
    $v = if ($i -and $i.Extension -eq '.dll' -and $i.VersionInfo.FileVersion) { "v$($i.VersionInfo.FileVersion)  " } else { '' }
    $s = if ($i) { "yes  $v(changed $($i.LastWriteTime))" } else { 'no' }
    "{0,-28} {1}" -f (Split-Path $f -Leaf), $s
  }
  $log = Join-Path $env:APPDATA 'Games By Malcs\Melvor Idle 2\logs\godot.log'
  if (Test-Path $log) {
    "--- game log (last start: $((Get-Item $log).LastWriteTime)) ---"
    $lines = Select-String -Path $log -Pattern 'Game Version|\[ModLoader\]|\[Chat\]|Application Control|Melvor2\.Chat|Melvor2\.ModLoader' | Where-Object { $_.Line -notmatch 'probe dir' } | ForEach-Object { $_.Line.Replace($env:USERPROFILE, '~') } | Select-Object -First 25
    if ($lines) { $lines } else { '(no mod lines in the log: the mod did not start)' }
  } else { 'Game log: not found' }
  '--- Windows security ---'
  $sac = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
  $sacText = switch ($sac) { 0 { 'Off' } 1 { 'On' } 2 { 'Evaluation' } default { 'unknown' } }
  "Smart App Control:  $sacText"
  try {
    $av = (Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction Stop | ForEach-Object { $_.displayName } | Sort-Object -Unique) -join ', '
    "Antivirus:          $av"
  } catch { 'Antivirus:          (could not read)' }
  try {
    $blocks = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; StartTime = (Get-Date).AddDays(-3) } -ErrorAction Stop |
      Where-Object { $_.Message -match 'Melvor' } | Select-Object -First 4
    if ($blocks) {
      'Windows blocked or flagged these files (newest first):'
      foreach ($b in $blocks) {
        $m = ($b.Message -replace '\s+', ' ').Replace($env:USERPROFILE, '~')
        "  [$($b.TimeCreated)] id $($b.Id): $($m.Substring(0, [Math]::Min(260, $m.Length)))"
      }
    } else { 'Windows code-integrity log: nothing about Melvor in the last 3 days' }
  } catch { "Windows code-integrity log: nothing found or could not read ($($_.Exception.Message))" }
  '=== end ==='
}
