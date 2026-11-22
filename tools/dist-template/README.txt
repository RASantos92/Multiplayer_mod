Melvor Idle 2 - Guilds and Chat mod (unofficial)
================================================

Adds guilds and a chat window to Melvor Idle 2 for players who have this mod.
Tested on game version 0.11.6-alpha.1 (Windows, Steam).
Full guide: https://github.com/RASantos92/Multiplayer_mod

INSTALL
  1. Close Melvor Idle 2.
  2. Unzip this folder anywhere.
  3. Double-click install.cmd.
  4. Start the game from Steam as usual.

  If the game is not found, run:  install.cmd "D:\path\to\Melvor Idle 2"
  Run install.cmd again after every game update (updates remove the mod).

USE (load a save first)
  Guilds
  - Click Guild in the top bar, next to Guide.
  - Click Enable Guilds once. Then Create Guild, or Find Guild and Ask to join.
  - Owners use the Owner tab to invite friends, approve requests and set ranks.

  Chat
  - Click the speech-bubble icon in the bottom bar, or press F8.
  - The dropdown at the top picks the channel: Friends, or one of your guilds.
  - Friends chat: one person presses Host, then Invite. If the invite does not
    work, the host presses Copy ID and you type   /join <id>   in the chat box.

UNINSTALL
  Close the game and double-click uninstall.cmd.
  If anything still looks wrong: Steam > right-click the game > Properties >
  Installed Files > Verify integrity of game files.
  To erase your guild data from the server, click "Delete my guild data" in the
  Guild window before uninstalling.

WHAT IT CHANGES
  - Adds one small startup call to GamesByMalcs.Melvor2.dll (the original is kept
    next to it as GamesByMalcs.Melvor2.dll.orig).
  - Adds Melvor2.ModLoader.dll and a "mods" folder with Melvor2.Chat.dll.
  - Your saves are copied to %LOCALAPPDATA%\Melvor2Chat\save-backups first.

PRIVACY
  Friends chat goes through an invite-only Steam lobby.
  Guilds use a small online server run by the mod's author. Nothing is sent to
  it until you click Enable Guilds. After that it receives your Steam ID and
  Steam name, your guilds and rank, your guild chat messages (kept 14 days),
  and the skill and level you are training.
  The mod never reads or sends your save and does not use the game's cloud account.

This is a fan-made mod, not supported by the game's developers. Use at your own risk.
