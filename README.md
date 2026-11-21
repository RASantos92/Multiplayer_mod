# Melvor Idle 2 Friends Chat

Chat with your Steam friends inside **Melvor Idle 2**.

This is an unofficial, fan-made mod. Windows and Steam only. Tested on game version `0.11.6-alpha.1`.

---

## Install (about 1 minute)

**1. Close Melvor Idle 2.**

**2. Open PowerShell.** Click the Windows Start button, type `powershell`, and press Enter. A blue or black window opens.

**3. Copy this line, paste it into that window, and press Enter:**

```powershell
irm https://raw.githubusercontent.com/RASantos92/Multiplayer_mod/main/install.ps1 | iex
```

**4. Wait for the word `Installed`.** Then close the window and start the game from Steam as usual. If Steam asks how to launch, pick the first option.

That's it. You only need to do this again after the game updates (see below).

---

## How to chat

1. In the game, click the **Chat** button in the bottom-right corner, or press **F8**.
2. **One** person clicks **Host**, then **Invite**, and picks friends from the Steam list.
3. Everyone else accepts the Steam invite. You are now in the same chat.
4. Type a message and press Enter.

**If the invite does not show up:**

1. The host clicks **Copy ID** and sends the number to you (Discord, text, anything).
2. You open Chat and type `/join` followed by the number, for example `/join 109775241234567890`.

**Good to know**

- Everyone needs the mod installed.
- Everyone needs the same version of the game.
- Up to 8 people can be in one chat.

---

## After a game update

Game updates remove the mod. When the Chat button disappears, close the game and run the install line again.

If the mod stops working after an update, the game probably changed and the mod needs a fix. Let the person who shared this with you know.

---

## Uninstall

Close the game, open PowerShell, and run:

```powershell
irm https://raw.githubusercontent.com/RASantos92/Multiplayer_mod/main/uninstall.ps1 | iex
```

If anything still looks wrong, Steam can repair the game: right-click **Melvor Idle 2** in your library, choose **Properties**, then **Installed Files**, then **Verify integrity of game files**.

---

## Problems

| What you see | What to do |
| --- | --- |
| "Melvor Idle 2 is running" | Close the game completely, then run the install line again. |
| "Could not find Melvor Idle 2" | Install the game through Steam first. If it is installed, use the manual install below. |
| No Chat button in the game | Run the install line again. Game updates remove the mod. |
| Invite does nothing | Use **Copy ID** and `/join` as described above. |
| The game will not start | Run the uninstall line, then verify the game files in Steam. |

---

## Is this safe?

- **Your saves are backed up first.** Every install copies them to `%LOCALAPPDATA%\Melvor2Chat\save-backups`.
- **Chat is friends-only.** It uses a private Steam lobby that only people you invite can join.
- **It does not touch your account.** The mod does not use the game's cloud login and does not read or send your save.
- **It is easy to undo.** The original game file is kept and the uninstall line puts it back.
- **It is unofficial.** The game's developers do not support it, so use it at your own risk.

<details>
<summary>What exactly does the installer change?</summary>

- Adds one small startup call to `GamesByMalcs.Melvor2.dll` so the game loads mods. The original is kept beside it as `GamesByMalcs.Melvor2.dll.orig`.
- Adds `Melvor2.ModLoader.dll` to the game's data folder.
- Adds a `mods` folder containing `Melvor2.Chat.dll`.

</details>

<details>
<summary>Manual install (no PowerShell line)</summary>

1. Download [Melvor2Chat.zip](https://github.com/RASantos92/Multiplayer_mod/releases/latest/download/Melvor2Chat.zip).
2. Right-click the zip and choose **Extract All**.
3. Close the game and double-click `install.cmd` in the extracted folder.
4. Windows may show a blue "Windows protected your PC" box because the files are not signed. Click **More info**, then **Run anyway**.

To remove it, double-click `uninstall.cmd`.

</details>

---

## For developers

Requires the .NET 10 SDK and the game installed through Steam.

| Path | What it is |
| --- | --- |
| `tools/Melvor2.Patcher` | Adds the bootstrap call to the game DLL. |
| `src/Melvor2.ModLoader` | Loads every DLL in `<game>\mods` and calls `ModEntry.Init()`. |
| `src/Melvor2.Chat` | The chat window and Steam lobby code. |
| `tools/install.ps1`, `tools/uninstall.ps1` | Build and install from source. |
| `tools/package.ps1` | Builds `dist\Melvor2Chat.zip` for a release. |

To publish a new version: run `tools\package.ps1`, then create a GitHub release and attach `dist\Melvor2Chat.zip` under exactly that file name. The install line always downloads the latest release.

To write another mod: add a class library beside `Melvor2.Chat` with a public static `ModEntry.Init()`. Use built-in Godot nodes and signals; custom `Node` subclasses are not registered with Godot's script system.

The game's own code is not in this repository. `game-ref/` and `decompiled/` are created locally and are gitignored.
