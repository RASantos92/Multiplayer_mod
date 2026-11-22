# Melvor Idle 2 Guilds and Chat

Chat with your Steam friends and run a guild inside **Melvor Idle 2**.

This is an unofficial, fan-made mod. Windows and Steam only. Tested on game version `0.11.6-alpha.1`.

---

## Install (about 1 minute)

**1. Close Melvor Idle 2.**

**2. Press the Windows key + R.** A small "Run" box opens.

**3. Copy this whole line, paste it into the box, and press Enter:**

```
powershell -NoExit -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/RASantos92/Multiplayer_mod/main/install.ps1 | iex"
```

**4. A window opens and does the work. Wait for the word `Installed`.** Then close the window and start the game from Steam as usual. If Steam asks how to launch, pick the first option.

The same line also works if you paste it into Command Prompt or PowerShell.

That's it. You only need to do this again after the game updates (see below).

---

## Guilds

Load your save, then click **Guild** in the top bar (next to Guide).

**First time:** read the short notice and click **Enable Guilds**. Nothing is sent anywhere until you do.

**Join a guild**

- Click **Find Guild**, search, and click **Ask to join**. An owner or officer approves you.
- Or have an owner or officer invite you. The invite shows up in the left column with a **Join** button.

**Start a guild**

1. Click **Create Guild**, type a name, and click **Create**. You are the owner.
2. Open the **Owner** tab to invite Steam friends, approve join requests, promote members to officer, and change the guild's name or description.
3. Friends need the mod installed with guilds enabled before you can invite them.

**Who can do what**

| | Member | Officer | Owner |
| --- | --- | --- | --- |
| Guild chat, see who is online and what they are training | Yes | Yes | Yes |
| Invite people, approve join requests | | Yes | Yes |
| Kick | | Members | Anyone |
| Promote and demote, rename, hand over ownership, disband | | | Yes |

**Good to know**

- You can be in up to 3 guilds. A guild holds up to 50 members.
- Buttons that cannot be undone (Leave, Kick, Disband) need two clicks.
- Guild chat is one of the channels in the chat window (see below). Messages are kept for 14 days.

---

## How to chat

Click the speech-bubble icon in the bottom bar (next to the music icon), or press **F8**.

The dropdown at the top of the chat picks the channel: **Friends**, or one of your guilds.

**Guild chat** just works once you are in a guild: pick the guild's channel and type.

**Friends chat** is a private room for people you invite, guild or not:

1. **One** person clicks **Host**, then **Invite**, and picks friends from the Steam list.
2. Everyone else accepts the Steam invite. You are now in the same chat.
3. Type a message and press Enter.

**If the invite does not show up:**

1. The host clicks **Copy ID** and sends the number to you (Discord, text, anything).
2. You open Chat and type `/join` followed by the number, for example `/join 109775241234567890`.

**Good to know**

- Everyone needs the mod installed.
- Everyone needs the same version of the game.
- Up to 8 people can be in one friends chat.

---

## After a game update

Game updates remove the mod. When the Guild button and chat icon disappear, close the game and run the install line again. Your guilds are safe: they live on the server, not in the game files.

If the mod stops working after an update, the game probably changed and the mod needs a fix. Let the person who shared this with you know.

---

## Uninstall

Close the game, press the Windows key + R, paste this line, and press Enter:

```
powershell -NoExit -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/RASantos92/Multiplayer_mod/main/uninstall.ps1 | iex"
```

If anything still looks wrong, Steam can repair the game: right-click **Melvor Idle 2** in your library, choose **Properties**, then **Installed Files**, then **Verify integrity of game files**.

Uninstalling does not remove you from your guilds. To erase your guild data from the server, click **Delete my guild data** in the Guild window before you uninstall.

---

## Problems

| What you see | What to do |
| --- | --- |
| "Melvor Idle 2 is running" | Close the game completely, then run the install line again. |
| "Could not find Melvor Idle 2" | Install the game through Steam first. If it is installed, use the manual install below. |
| No Guild button or chat icon in the game | Load a save first; they only show in game. If still missing, run the install line again. Game updates remove the mod. |
| Friends chat invite does nothing | Use **Copy ID** and `/join` as described above. |
| "Could not reach the guild server" | Check your internet connection and try again in a minute. Friends chat still works without the server. |
| Cannot invite a friend to the guild | They need the mod installed and **Enable Guilds** clicked once. |
| "This Steam account already enabled guilds on another PC" | Your guild key lives on the PC where you first enabled guilds. Ask the person who shared this mod to reset it. |
| The game will not start | Run the uninstall line, then verify the game files in Steam. |

---

## Is this safe?

- **Your saves are backed up first.** Every install copies them to `%LOCALAPPDATA%\Melvor2Chat\save-backups`.
- **Friends chat is invite-only.** It uses a private Steam lobby that only people you invite can join.
- **It does not touch your account.** The mod does not use the game's cloud login and does not read or send your save.
- **Guilds are opt-in.** Nothing goes to the guild server until you click **Enable Guilds**.
- **It is easy to undo.** The original game file is kept and the uninstall line puts it back.
- **It is unofficial.** The game's developers do not support it, so use it at your own risk.

### What guilds send to the server

Guilds need a small online server so a guild still exists when its members are offline. It is run by the owner of this repository, not by the game's developers.

Once you click **Enable Guilds**, the mod sends:

- your Steam ID and Steam display name
- the guilds you create or join, and your rank in them
- your guild chat messages (deleted after 14 days)
- the skill and level you are currently training, and when you were last online

It never sends your save, your items, or anything about your Steam or game account. Other members of your guilds can see your name, rank, online status and current skill.

The server cannot check Steam logins, so your identity is a secret key stored on your PC in `%APPDATA%\Games By Malcs\Melvor Idle 2\mod-data`. Keep that folder if you reinstall Windows.

**Delete my guild data** in the Guild window erases your record, memberships and messages from the server.

<details>
<summary>What exactly does the installer change?</summary>

- Adds one small startup call to `GamesByMalcs.Melvor2.dll` so the game loads mods. The original is kept beside it as `GamesByMalcs.Melvor2.dll.orig`.
- Adds `Melvor2.ModLoader.dll` to the game's data folder.
- Adds a `mods` folder containing `Melvor2.Chat.dll`.

</details>

<details>
<summary>Manual install (download a zip instead)</summary>

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
| `src/Melvor2.Chat` | The mod: chat window, Steam lobby code, the buttons added to the game's bars, and the guild window (`Guilds/` talks to the server). |
| `server/` | The guild API (Node on Vercel, MongoDB Atlas). See `server/README.md`. |
| `tools/install.ps1`, `tools/uninstall.ps1` | Build and install from source. |
| `tools/package.ps1` | Builds `dist\Melvor2Chat.zip` for a release. |

To publish a new version: run `tools\package.ps1`, then create a GitHub release and attach `dist\Melvor2Chat.zip` under exactly that file name. The install line always downloads the latest release.

The mod copies the look of the game's own UI from the live scene tree, because the game's scene files are packed. After a game update moves things, create an empty file `%APPDATA%\Games By Malcs\Melvor Idle 2\mod-probe\ui-probe.request`, load a save, and read `ui-probe.txt` in the same folder (see `src/Melvor2.Chat/UiProbe.cs`).

To write another mod: add a class library beside `Melvor2.Chat` with a public static `ModEntry.Init()`. Use built-in Godot nodes and signals; custom `Node` subclasses are not registered with Godot's script system.

The game's own code is not in this repository. `game-ref/` and `decompiled/` are created locally and are gitignored.
