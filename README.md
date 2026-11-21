# Melvor Idle 2 mods

Unofficial mods for Melvor Idle 2 (tested on 0.11.6-alpha.1, Godot 4.7.2, .NET 10).

- `tools/Melvor2.Patcher` adds a small bootstrap to the game DLL so it loads the mod loader.
- `src/Melvor2.ModLoader` loads every DLL in `<game>\mods` and calls `ModEntry.Init()`.
- `src/Melvor2.Chat` is a friends chat over Steam lobbies. Open it with the Chat button (bottom right) or F8.

## Install / uninstall

Close the game, then:

```powershell
.\tools\install.ps1
.\tools\uninstall.ps1
```

Run `install.ps1` again after each game update. Saves are copied to `save-backups/` on every install.

## Sharing with friends

```powershell
.\tools\package.ps1
```

Creates `dist\Melvor2Chat-<version>.zip` with the mod, a self-contained patcher and double-click
install/uninstall scripts. It contains none of the game's files.

## Using the chat

1. Everyone installs the mod and is on the same game version.
2. One person opens Chat, presses **Host**, then **Invite**.
3. If the Steam overlay invite does not work, press **Copy ID** and have friends type `/join <id>`.

## Writing another mod

Create a class library next to `Melvor2.Chat` with a public static `ModEntry.Init()`. Use built-in Godot
nodes and signals; custom `Node` subclasses are not registered with Godot's script system.

## Notes

- `game-ref/` and `decompiled/` hold the developer's code. They are gitignored; do not share them.
- The mod does not use the game's cloud backend and does not read or send save data.
- Logs: `%APPDATA%\Games By Malcs\Melvor Idle 2\logs` (look for `[ModLoader]` and `[Chat]`).
