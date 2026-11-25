using GamesByMalcs.Melvor2.Platforms;
using GamesByMalcs.Melvor2.Platforms.Steam;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Actions;
using Godot;
using Melvor2.Chat.GameState;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat;

/// <summary>Found and called by Melvor2.ModLoader.</summary>
public static class ModEntry
{
    public const string Version = "0.7.2";

    private static SceneTree? s_tree;
    private static ChatPanel? s_panel;
    private static SteamLobbyService? s_lobby;
    private static GameUiHook? s_hook;
    private static GuildService? s_guilds;
    private static bool s_failed;
    private static ActivityInfo? s_activity;
    private static CombatInfo? s_combat;
    private static double s_sinceMarket;
    private static double s_sinceGameWork;
    private static double s_sinceProfile = 60;
    private static double s_sinceInput;
    private static Vector2 s_lastMouse;

    /// <summary>The party XP bonus (one per game session).</summary>
    internal static PartyBoost Boost { get; } = new();

    /// <summary>Shared combat: the guild mates in my fight and the damage they add.</summary>
    internal static PartyCombat Fight { get; } = new();

    /// <summary>The guild marketplace (created with the guild service).</summary>
    internal static MarketService? Market { get; private set; }

    /// <summary>Guild Grounds: the player's own tasks and the bonuses they earn (created with the guild service).</summary>
    internal static GroundsService? Grounds { get; private set; }

    private static readonly GroundsBonus s_groundsBonus = new();
    private static readonly Dictionary<string, long> s_noBonuses = new();

    /// <summary>The loaded game when it is safe to touch (main thread, not paused), otherwise null.</summary>
    internal static Game? CurrentGame() => s_tree == null ? null : GameAccess.Current(s_tree);
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

    /// <summary>
    /// Twice a second, while the game model is safe to touch: note what the character is doing, keep the party
    /// bonus in step with the latest guild sync, and offer the profile for upload when it changes.
    /// </summary>
    private static void GameWork(double delta)
    {
        s_sinceGameWork += delta;
        s_sinceProfile += delta;
        if (s_sinceGameWork < 0.5 || s_guilds == null) return;
        s_sinceGameWork = 0;

        Game? game = CurrentGame();
        if (game == null)
        {
            // Menus, loading, or offline progress running on another thread: touch nothing.
            s_activity = null;
            s_combat = null;
            s_guilds.Party = false;
            s_guilds.CombatParty = false;
            s_guilds.Fighting = false;
            Fight.Clear();
            return;
        }

        try
        {
            s_activity = ActivityTracker.Read(game, out ActionComponent? component);
            s_combat = component?.Entity is GamesByMalcs.Melvor2.Entities.Combat.CombatEntity combat ? CombatAccess.Read(combat) : null;
            s_guilds.Fighting = s_combat != null;

            if (!s_guilds.Enabled)
            {
                Boost.Clear();
                Fight.Clear();
                s_guilds.Party = false;
                s_guilds.CombatParty = false;
                return;
            }

            IReadOnlyList<MemberInfo> party = s_activity == null ? Array.Empty<MemberInfo>() : s_guilds.FindParty(s_activity.Key);
            Boost.Update(game, s_activity, component, party, s_guilds.LastSyncUtc);
            Fight.Update(s_combat, party, s_guilds.LastSyncUtc, s_guilds.ServerNow);
            s_guilds.Party = party.Count > 0 || Boost.Active;
            s_guilds.CombatParty = s_combat != null && party.Count > 0;

            if (s_sinceProfile >= 10)
            {
                s_sinceProfile = 0;
                s_guilds.OfferProfile(ProfileSnapshot.Build(game));
            }
        }
        catch (Exception e)
        {
            Log("Game work failed: " + e);
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
                s_guilds = new GuildService { Activity = () => s_activity, Combat = () => s_combat };
                Boost.Changed += () => s_panel.AddSystemLine(Boost.Active
                    ? "Party bonus on: " + Boost.PercentText + " " + Boost.SkillName + " XP while you train with " + Boost.PartnerName + "."
                    : "Party bonus ended.");
                Market = new MarketService(s_guilds);
                Market.Notice += text => s_panel.AddSystemLine("Marketplace: " + text);
                Grounds = new GroundsService(s_guilds);
                Grounds.Notice += text => s_panel.AddSystemLine("Guild Grounds: " + text);
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
                // Anyone at the keyboard? A guild screen left open overnight should not keep syncing fast.
                Vector2 mouse = s_tree.Root.GetMousePosition();
                if (mouse != s_lastMouse || Input.IsAnythingPressed()) s_sinceInput = 0;
                else s_sinceInput += delta;
                s_lastMouse = mouse;
                s_guilds.SinceInput = s_sinceInput;
                s_guilds.Active = s_panel.ShowingGuildChannel || (s_hook?.GuildWindowOpen ?? false);
                s_guilds.Tick(delta);
                GameWork(delta);
                Fight.Frame(CurrentGame(), delta);
                s_sinceMarket += delta;
                if (s_sinceMarket >= 0.5)
                {
                    s_sinceMarket = 0;
                    try
                    {
                        Market?.Tick(CurrentGame());
                    }
                    catch (Exception e)
                    {
                        Log("Marketplace work failed: " + e);
                    }
                    try
                    {
                        Game? game = CurrentGame();
                        Grounds?.Tick(game);
                        if (game != null && Grounds != null) s_groundsBonus.Update(game, s_guilds.Enabled ? Grounds.Bonuses : s_noBonuses);
                    }
                    catch (Exception e)
                    {
                        Log("Guild Grounds work failed: " + e);
                    }
                }
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
            if (GameState.GameProbe.Requested) GameState.GameProbe.Tick(s_tree!);
            if (GameState.CombatProbe.Requested) GameState.CombatProbe.Tick(s_tree!, delta);
            if (GameState.BankProbe.Requested) GameState.BankProbe.Tick(s_tree!);
            if (GameState.GroundsProbe.Requested) GameState.GroundsProbe.Tick(s_tree!);

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
