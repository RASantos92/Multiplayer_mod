using GamesByMalcs.Melvor2.Platforms;
using GamesByMalcs.Melvor2.Platforms.Steam;
using Godot;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat;

/// <summary>Found and called by Melvor2.ModLoader.</summary>
public static class ModEntry
{
    public const string Version = "0.2.0";

    private static SceneTree? s_tree;
    private static ChatPanel? s_panel;
    private static SteamLobbyService? s_lobby;
    private static GameUiHook? s_hook;
    private static GuildService? s_guilds;
    private static bool s_failed;
    private static bool s_hotkeyDown;

    public static void Init()
    {
        // Only built-in Godot nodes and signals are used (no custom Node subclasses),
        // so the mod needs no Godot script registration.
        s_tree = (SceneTree)Engine.GetMainLoop();
        s_tree.ProcessFrame += OnFrame;
        Log("v" + Version + " loaded.");
        try
        {
            Log(UiProbe.Describe());
        }
        catch (Exception e)
        {
            Log("probe unavailable: " + e);
        }
    }

    internal static void Log(string message) => GD.Print("[Chat] " + message);

    private static void OnFrame()
    {
        if (s_failed) return;
        try
        {
            if (s_panel == null)
            {
                s_panel = new ChatPanel(s_tree!.Root);
                s_panel.AddSystemLine("Chat mod v" + Version + ". Waiting for Steam...");
                s_guilds = new GuildService();
                s_panel.BindGuilds(s_guilds);
                s_hook = new GameUiHook(s_tree, s_panel, s_guilds);
            }

            // The game initialises Steam in Main._Ready; wait for it instead of starting a second session.
            if (s_lobby == null && PlatformManager.CurrentPlatform is SteamPlatform { IsInitialized: true })
            {
                s_lobby = new SteamLobbyService();
                s_panel.Bind(s_lobby);
                s_lobby.JoinFromCommandLine(OS.GetCmdlineArgs());
                s_guilds!.Start();
                Log("Steam ready.");
            }

            // Guild server: run finished network callbacks, then poll on its own schedule.
            double delta = s_tree!.Root.GetProcessDeltaTime();
            GuildApi.Pump();
            if (s_guilds != null)
            {
                s_guilds.Active = s_panel.ShowingGuildChannel || (s_hook?.GuildWindowOpen ?? false);
                s_guilds.Tick(delta);
            }

            try
            {
                s_hook?.Tick(delta);
            }
            catch (Exception e)
            {
                // The native buttons depend on the game's internals; if they break, keep F8 chat working.
                s_hook = null;
                Log("Game UI hook disabled after error: " + e);
            }
            if (UiProbe.Requested) UiProbe.Tick(s_tree!);

            bool down = Input.IsKeyPressed(Key.F8);
            if (down && !s_hotkeyDown) s_panel.Toggle();
            s_hotkeyDown = down;
        }
        catch (Exception e)
        {
            s_failed = true;
            GD.PrintErr("[Chat] Disabled after error: " + e);
            Log("Disabled after error: " + e);
        }
    }
}
