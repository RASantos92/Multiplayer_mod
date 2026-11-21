using GamesByMalcs.Melvor2.Platforms;
using GamesByMalcs.Melvor2.Platforms.Steam;
using Godot;

namespace Melvor2.Chat;

/// <summary>Found and called by Melvor2.ModLoader.</summary>
public static class ModEntry
{
    public const string Version = "0.1.0";

    private static SceneTree? s_tree;
    private static ChatPanel? s_panel;
    private static SteamLobbyService? s_lobby;
    private static bool s_failed;
    private static bool s_hotkeyDown;

    public static void Init()
    {
        // Only built-in Godot nodes and signals are used (no custom Node subclasses),
        // so the mod needs no Godot script registration.
        s_tree = (SceneTree)Engine.GetMainLoop();
        s_tree.ProcessFrame += OnFrame;
        Log("v" + Version + " loaded.");
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
            }

            // The game initialises Steam in Main._Ready; wait for it instead of starting a second session.
            if (s_lobby == null && PlatformManager.CurrentPlatform is SteamPlatform { IsInitialized: true })
            {
                s_lobby = new SteamLobbyService();
                s_panel.Bind(s_lobby);
                s_lobby.JoinFromCommandLine(OS.GetCmdlineArgs());
                Log("Steam ready.");
            }

            bool down = Input.IsKeyPressed(Key.F8);
            if (down && !s_hotkeyDown) s_panel.Toggle();
            s_hotkeyDown = down;
        }
        catch (Exception e)
        {
            s_failed = true;
            GD.PrintErr("[Chat] Disabled after error: " + e);
        }
    }
}
