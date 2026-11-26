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

The same line also works if you paste it into Command Prompt or PowerShell. If Windows answers step 3 with "Windows cannot access the specified device, path, or file", it is refusing to start PowerShell from the Run box: open the Start menu, type `PowerShell`, open **Windows PowerShell**, and paste the line there.

That's it. You only need to do this again after the game updates (see below).

---

## Guilds

Load your save, then click **Guild** in the top bar (next to Guide).

**First time:** read the short notice, type the **tester code** you were given into the box under it, and click **Enable Guilds**. Nothing is sent anywhere until you do. You only need the code once.

**Join a guild**

- Click **Find Guild**, search, and click **Ask to join**. An owner or officer approves you.
- Or have an owner or officer invite you. The invite shows up in the left column with a **Join** button.

**Start a guild**

1. Click **Create Guild**, type a name, and click **Create**. You are the owner.
2. Open the **Owner** tab to invite Steam friends, approve join requests, promote members to officer, and change the guild's name or description.
3. Friends need the mod installed with guilds enabled before you can invite them.

**Profiles**

Click a member's name in the **Members** tab to see their profile: what they are doing right now, all their skill levels, and their equipped gear. Click **< Back** to return.

**Train together (+5% XP per player)**

In the Members tab, what an online member is doing shows as a button.

1. Click it. If your character meets the game's requirements, it starts the same action.
2. While you and a guild mate are both online on the **exact same action** (same fishing spot, same tree, same ore, same recipe, same enemy), you each get **+5% XP** in that skill. Every extra guild mate on it adds another 5%, up to four others (+20%).
3. A green "Party bonus active" line appears in the Guild window, and the chat tells you when it starts and ends.

- If you can't join, the button is greyed out and hovering it says why, for example "Requires Fishing level 73".
- Joining by button works for Combat, Fishing, Woodcutting, Mining, Thieving, Cooking, Firemaking, Herblore and the smithing-style skills. For anything else, start the same action yourself and the bonus still applies.
- The bonus adds to your other XP bonuses the same way the game's own bonuses do, and it only applies while you are both online. It never applies to offline progress.
- It takes up to about a minute to notice a partner, and ends at once when you stop. After a partner stops or goes offline, it can take a couple of minutes for your bonus to end.

**Fight together**

Click a guild mate's fight in the Members tab to fight the same enemy or dungeon. You each fight your own copy of the enemy, and the mod links the two fights:

- **Their damage helps you.** Each guild mate on your enemy has their own attack bar. When it fills, they attack your enemy, and it hits or misses as often as their own attacks do. You get **15%** of their damage, or **8%** if they are more than 10 combat levels above you. Each hit that lands is rolled between a low and a high amount, like their own hits, and averages out to that share.
- **A Players tab** appears at the end of the tabs above your stats on the Combat page (friends icon; use the arrows if it is off the edge). It shows each player's health, damage per second, attack bar and gear.
- **Each player has a colour.** Their name, their attack bar and the numbers their hits make on the enemy all use it.
- **XP:** you only get combat XP for your own hits, plus the +5% per player bonus on your combat skills. Their hits just make kills, and so loot, faster.
- It only works while you are both online and actually fighting: not while an enemy is spawning, while paused, or during offline progress. Health and damage shown for others can be a few seconds old.

**Who can do what**

| | Member | Officer | Owner |
| --- | --- | --- | --- |
| Guild chat, see who is online, view profiles, train together | Yes | Yes | Yes |
| Invite people, approve join requests | | Yes | Yes |
| Kick | | Members | Anyone |
| Promote and demote, rename, hand over ownership, disband | | | Yes |

**Good to know**

- You can be in up to 3 guilds. A guild holds up to 50 members.
- Buttons that cannot be undone (Leave, Kick, Disband) need two clicks.
- Guild chat is one of the channels in the chat window (see below). Messages are kept for 14 days.

---

**Guild marketplace**

The **Marketplace** tab in the Guild window lets guild mates sell items to each other for gold.

- **Sell:** click **Sell an item**, pick a category tab and then an item from your bank, and choose how many and the price each. The items leave your bank straight away and wait on the market.
- **Sell from the bank:** select one item in your bank and click **Sell on guild market** under the game's own sell options. It opens the same form with that item chosen; nothing is listed until you confirm.
- **Price limits:** the price must be between 80% and 120% of what the game says the item is worth. The form shows the allowed range and refuses anything outside it.
- **Buy:** click **Buy** on a listing and choose how many. **Buy now** takes your gold and puts the items in your bank within a second or two.
- **Haggle:** in the same panel you can **Make offer** at a lower price (not below 80% of the item's value). The seller sees it under **Offers on your listings** and accepts or declines within 48 hours. If they accept, you pay and get the items automatically.
- **Getting paid:** the gold arrives by itself the next time you are in the game with a save loaded. The chat tells you what sold.
- **Cancel:** click **Cancel** twice on your own listing to get the unsold items back. Listings that do not sell in 14 days come back by themselves.

Good to know:

- Locked items and items with no gold value cannot be listed. Equipped gear is not in your bank, so unequip it first.
- You can have 20 listings per guild.
- Items you buy do not count as "found" for the completion log.
- If your bank is full, bought or returned items wait on the market until there is room.
- Leaving a guild cancels your listings there; the items still come back to you.
- **Delete my guild data** is refused while you have listings or anything waiting to be collected, so nothing gets lost.
- Everyone trading needs version 0.5.0 or newer.

**Guild Grounds**

The **Guild Grounds** tab in the Guild window shows places your guild builds up together. Each place has five tasks. When the guild has done all five, every member gets that place's bonus for 30 days.

- **Progress belongs to the guild.** Everything members do and donate goes to the same tasks, and every member gets a finished place's bonus, including someone who joined yesterday.
- **Amounts grow with the guild.** Each task needs its amount once for every member the guild has right now. A new member raises unfinished tasks and a member leaving lowers them.
- **Bonuses last 30 days.** A finished place hides its tasks and shows a bar counting down. In the last 7 days the tasks come back at zero; finishing them again adds 30 days. If the time runs out first, the bonus stops until the tasks are done again.
- **Who contributed:** each task bar is coloured by member. Hover over a colour to see the player and how much they gave. Guild mates can see what you contributed.

- **Tasks you do by playing:** each one names something specific, such as defeating monsters in one combat area, trapping a certain animal, running a named Agility course, pickpocketing a certain target, or making, catching or harvesting certain items. They count by themselves, including what your character did while the game was closed, and they count for every guild you are in. You keep whatever you make.
- **Tasks you donate to:** click **Donate**, pick an item from your bank and choose how many. Any item of the right kind is accepted, and better ones count for more: each step up counts 25% more, each step down 25% less. The panel shows what every item counts as.
- **Donations are final.** The items leave your bank for good and cannot be taken back. You click the Donate button twice to confirm.
- **Bonuses:** small passive bonuses such as +2% protection or 2% faster Fishing. They apply while the game is open and you are in the guild. The same bonus from two guilds does not add up.

Good to know:

- Locked bank items cannot be donated.
- If you give more than a task still needs, only what is needed is taken and the rest comes back.
- Counting starts when you first play with version 0.6.0; earlier kills are not counted.
- If you restore an older save, counting starts again from there.
- Up to version 0.6.1 a guild shared its progress. Since then everyone has their own, starting from what they contributed themselves.
- Needs version 0.6.0 or newer.

**Tester chat (optional)**

If you want to talk about the mod with other players or report a bug, click **Join tester chat** at the bottom left of the Guild window. A **Testers and bug reports** channel then appears in the chat window (F8), next to your guild channels.

- It is one channel shared by everyone who joined it, whatever guild they are in, or none.
- Everyone in it sees what you write there, with your Steam name. Do not post anything private.
- Nothing is sent to it or read from it until you join. Click **Leave tester chat** to stop; what you already wrote stays for the others.
- Messages are deleted after 14 days, and **Delete my guild data** removes yours straight away.
- Needs version 0.6.1 or newer.

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
| No Guild button, and you also use **Melvor Mod Loader** | Versions before 0.7.1 did not load when that loader was installed. Close the game and run the install line again. The two work side by side from 0.7.1. |
| Friends chat invite does nothing | Use **Copy ID** and `/join` as described above. |
| A member's profile says they have not shared one | They are on an older version. They need to run the install line again. |
| No party bonus | You both need the latest version, both online, on the exact same action. Give it a minute. |
| "Could not reach the guild server" | Check your internet connection and try again in a minute. Friends chat still works without the server. |
| Cannot invite a friend to the guild | They need the mod installed and **Enable Guilds** clicked once. |
| "This Steam account already enabled guilds on another PC" | Your guild key lives on the PC where you first enabled guilds. Ask the person who shared this mod to reset your guild account, then click **Enable Guilds** again. You keep your guilds. |
| "This server is in closed testing" or "That tester code is not right" | Type the tester code from the person who shared this mod into the box above **Enable Guilds**. |
| "Windows cannot access the specified device, path, or file" after pasting the install line into the Run box | Windows refused to start PowerShell from the Run box; nothing was installed. Open the Start menu, type `PowerShell`, open **Windows PowerShell**, and paste the line there. |
| No Guild button after a correct install, or the game log says "An Application Control policy has blocked this file" | Windows **Smart App Control** blocked a version from before 0.7.2, which was not code-signed. Close the game and run the install line again to get a signed version. See "Smart App Control" below. |
| The install window shows "Usage: Melvor2.Patcher" then "Patching failed" | Same cause: Smart App Control blocked the unsigned installer helper of a version before 0.7.2. Run the install line again. |
| The game will not start | Run the uninstall line, then verify the game files in Steam. |

### Check your install

If the mod still does not show, start the game, load a save, then run this line the same way as the install line. It only reads: it changes nothing and sends nothing anywhere.

```
powershell -NoExit -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/RASantos92/Multiplayer_mod/main/check.ps1 | iex"
```

It prints whether the game is patched, which mod files are there, and the mod's lines from the game log. Copy everything between the two `===` lines and send it to the person who shared this mod.

---

## Is this safe?

- **Your saves are backed up first.** Every install copies them to `%LOCALAPPDATA%\Melvor2Chat\save-backups`.
- **Friends chat is invite-only.** It uses a private Steam lobby that only people you invite can join.
- **It does not touch your account.** The mod does not use the game's cloud login and does not read or send your save.
- **Guilds are opt-in.** Nothing goes to the guild server until you click **Enable Guilds**.
- **Guild Grounds change your character.** Donated items are removed from your bank for good, and locations the guild finishes give small real bonuses (combat stats, Fishing and Ranching speed) while the game is open.
- **The marketplace moves real items and gold.** A trade cannot be undone by the mod. If a save is rolled back after a trade (an old backup, or the cloud save replacing the local one), items or gold can end up duplicated or lost; the mod cannot detect that. Trade with people you trust.
- **The party bonus is real XP, and shared fights give real loot.** The bonuses themselves are temporary and never written to your save, but the extra XP, kills and loot you earn with them stay on your character like any other.
- **It is easy to undo.** The original game file is kept and the uninstall line puts it back.
- **It is unofficial.** The game's developers do not support it, so use it at your own risk.

### Smart App Control

Some Windows 11 PCs have **Smart App Control** turned on (Windows Security > App & browser control). It blocks programs and DLLs that Windows does not recognise, and it can block this mod: the Guild button and chat icon never appear, or the installer fails with "Patching failed".

**From version 0.7.2 every release is code-signed**, which Smart App Control accepts, so you do not need to change any Windows setting. If you installed an older version and are blocked, close the game and run the install line again. The signature names the person who publishes this mod, verified by Microsoft; you can see it under Properties > Digital Signatures on the mod's DLL files.

If the mod is still blocked on 0.7.2 or later, run the check line under "Check your install" and send the output to the person who shared this mod. Turning Smart App Control off is your own decision: it lowers your PC's protection and Windows only lets you turn it back on by resetting Windows.

One part cannot be signed: the installer changes one of the game's own files on your PC. Windows has accepted that file so far, but it could block it in future.

### What guilds send to the server

Guilds need a small online server so a guild still exists when its members are offline. It is run by the owner of this repository, not by the game's developers.

Once you click **Enable Guilds**, the mod sends:

- your Steam ID and Steam display name
- the guilds you create or join, and your rank in them
- your guild chat messages (deleted after 14 days), and, only if you join the tester chat, the messages you write there, which every player in that chat can read
- what you are doing right now (the skill and the exact action), and when you were last online
- all your skill levels and the gear you have equipped
- while you are fighting: your health, damage per second, combat level, attack speed and chance to hit
- your marketplace listings and offers: the item, quantity and price
- for Guild Grounds: for the things its tasks ask for, how many you did since the last report (monsters defeated, animals trapped, Agility courses, Thieving targets, and items made, gathered, burned or buried), and the items you donate; guild mates can see how much you contributed to each task

It never sends your save, your bank, or anything about your Steam or game account. Other members of your guilds can see your name, rank, online status, current action, skill levels, equipped gear and, while you fight, your health and damage.

If you enabled guilds on an earlier version, the Guild window shows the updated notice once and waits for you to accept it before sending the new information.

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
4. Windows may show a blue "Windows protected your PC" box, because `install.cmd` is a plain script file that cannot carry a signature (the programs and DLLs it installs are signed from 0.7.2). Click **More info**, then **Run anyway**.

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
| `src/Melvor2.Chat/GameState` | Reads and drives the game's own model: current action, profile snapshot, joining an action, and the party XP bonus (a modifier added through the game's ModifierSystem). |
| `server/` | The guild API (Node on Vercel, MongoDB Atlas). See `server/README.md`. `server/scripts/fake-partner.mjs` is a throwaway guild member for testing profiles and the party bonus alone. |
| `tools/install.ps1`, `tools/uninstall.ps1` | Build and install from source. |
| `tools/package.ps1` | Builds `dist\Melvor2Chat.zip` for a release. |

**Code signing.** Unsigned builds can be blocked by Windows Smart App Control. `tools/sign.ps1` signs with Azure Artifact Signing (formerly Trusted Signing) when `tools/signing.local.json` exists (copy `tools/signing.example.json`), using your `az login` and the `sign` dotnet tool. `package.ps1` and `install.ps1` call it and say clearly whether the result is signed. No key or password is stored in the repository.

To publish a new version: run `tools\package.ps1`, then create a GitHub release and attach `dist\Melvor2Chat.zip` under exactly that file name. The install line always downloads the latest release.

The mod copies the look of the game's own UI from the live scene tree, because the game's scene files are packed. After a game update moves things, create an empty file `%APPDATA%\Games By Malcs\Melvor Idle 2\mod-probe\ui-probe.request`, load a save, and read `ui-probe.txt` in the same folder (see `src/Melvor2.Chat/UiProbe.cs`). A `game-probe.request` file in the same folder does the same for the game model: action ids, skills, gear and a short modifier test (`GameState/GameProbe.cs`).

To write another mod: add a class library beside `Melvor2.Chat` with a public static `ModEntry.Init()`. Use built-in Godot nodes and signals; custom `Node` subclasses are not registered with Godot's script system.

The game's own code is not in this repository. `game-ref/` and `decompiled/` are created locally and are gitignored.
