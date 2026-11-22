using System.Text;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Characters;
using GamesByMalcs.Melvor2.Components.CombatAreas;
using GamesByMalcs.Melvor2.Core;
using GamesByMalcs.Melvor2.Entities.Combat;
using GamesByMalcs.Melvor2.GameMenus;
using Godot;

namespace Melvor2.Chat.GameState;

/// <summary>
/// Developer tool, like GameProbe. When mod-probe\combat-probe.request exists it waits until the player is
/// in a fight with the Combat page open, writes combat-probe.txt (ids, levels, the combat screen's tabs), then
/// adds outside damage for three seconds and records what the game does with it. This confirms what shared
/// combat relies on: the enemy dies and respawns normally and the player's own DPS figure does not move.
/// </summary>
internal static class CombatProbe
{
    private static readonly string s_dir = Path.Combine(OS.GetUserDataDir(), "mod-probe");
    private static readonly string s_request = Path.Combine(s_dir, "combat-probe.request");
    private static readonly string s_output = Path.Combine(s_dir, "combat-probe.txt");

    private static readonly StringBuilder s_log = new();
    private static bool s_done;
    private static int s_stage;
    private static int s_frames;
    private static double s_carry;
    private static double s_rate;
    private static int s_dealt;
    private static int s_kills;
    private static EnemyComponent? s_enemy;

    public static bool Requested => !s_done && File.Exists(s_request);

    public static void Tick(SceneTree tree, double delta)
    {
        if (s_done) return;
        Game? game = GameAccess.Current(tree);
        CombatEntity? combat = game == null ? null : CombatAccess.Find(game);
        if (game == null || combat == null) return;

        try
        {
            switch (s_stage)
            {
                case 0:
                    // Wait for about five seconds of fighting in total (kills in between do not reset it),
                    // so the DPS figure means something.
                    if (CombatAccess.IsFighting(combat)) s_frames++;
                    if (s_frames < 300) return;
                    Describe(tree, game, combat);
                    s_enemy = combat.Enemy;
                    s_enemy.Killed += OnKilled;
                    s_rate = Math.Max(1, combat.Enemy.Health.Max * 0.25);
                    s_log.AppendLine();
                    s_log.AppendLine("## Outside damage test: " + s_rate.ToString("0.#") + " per second for 3 seconds");
                    s_log.AppendLine("before: " + State(combat));
                    s_stage = 1;
                    s_frames = 0;
                    break;
                case 1:
                    s_carry += s_rate * delta;
                    int whole = (int)s_carry;
                    if (whole > 0)
                    {
                        s_carry -= whole;
                        s_dealt += CombatAccess.DealPartyDamage(combat, whole);
                    }
                    if (++s_frames % 30 == 0) s_log.AppendLine("  during: " + State(combat));
                    if (s_frames >= 180)
                    {
                        s_log.AppendLine("dealt in total: " + s_dealt + "  kills seen: " + s_kills);
                        s_stage = 2;
                        s_frames = 0;
                    }
                    break;
                case 2:
                    if (++s_frames % 60 == 0) s_log.AppendLine("  after: " + State(combat));
                    if (s_frames >= 360) Finish();
                    break;
            }
        }
        catch (Exception e)
        {
            s_log.AppendLine("!! " + e);
            Finish();
        }
    }

    private static void OnKilled(object? sender, EnemyKilledEventArgs e) => s_kills++;

    private static string State(CombatEntity combat) =>
        "state=" + combat.Action.State + " paused=" + combat.Action.IsPaused
        + " enemy hp=" + combat.Enemy.Health.Current + "/" + combat.Enemy.Health.Max
        + " ward=" + combat.Enemy.Ward.Current + "/" + combat.Enemy.Ward.Max
        + " my hp=" + combat.Player.Health.Current + "/" + combat.Player.Health.Max
        + " my dps=" + CombatAccess.Dps(combat).ToString("0.##") + " kills=" + s_kills;

    private static void Finish()
    {
        s_done = true;
        if (s_enemy != null) s_enemy.Killed -= OnKilled;
        Directory.CreateDirectory(s_dir);
        File.WriteAllText(s_output, s_log.ToString());
        File.Delete(s_request);
        ModEntry.Log("Combat probe written to " + s_output);
    }

    private static void Describe(SceneTree tree, Game game, CombatEntity combat)
    {
        s_log.AppendLine("# Melvor Idle 2 combat probe " + DateTime.Now.ToString("u"));
        s_log.AppendLine("ticks per second: " + Constants.TicksPerSecond + "  tick interval ms: " + Constants.TickInterval);
        s_log.AppendLine("my combat level: " + CombatAccess.Level(combat) + "  style: " + combat.Player.Stats.CombatStyle.Value.Id
            + "  attack interval ms: " + combat.Player.Stats.AttackInterval.Value);
        s_log.AppendLine("action description: " + combat.Action.CurrentDescription?.Id + " [" + combat.Action.CurrentDescription?.GetType().Name + "]");

        Section("Combat levels", () =>
        {
            foreach (var pair in combat.Player.CombatLevels.ActiveLevels)
            {
                s_log.AppendLine("  " + pair.Key.Id + "  level " + pair.Value.Level + "  experience component: "
                    + pair.Key.Component.Entity.Id + " / " + pair.Key.Component.Id);
            }
        });

        Section("Current fight", () =>
        {
            ActiveCombatArea? area = combat.Areas.CurrentArea;
            s_log.AppendLine("  area: " + area?.Area.Id + " [" + area?.Area.GetType().Name + "] name=" + area?.Area.DisplayName.Text
                + " unlocked=" + area?.UnlockRequirements.AreMet + " drops loot=" + area?.EnemiesDropLoot);
            s_log.AppendLine("  selected enemy: " + combat.Areas.SelectedEnemy?.Id + "  spawned enemy: " + combat.Enemy.Enemy?.Id
                + " level " + combat.Enemy.Enemy?.CombatLevel + " requirements met=" + combat.Enemy.Enemy?.Requirements.AreMet);
            s_log.AppendLine("  progress: " + combat.Areas.CurrentProgress + "/" + combat.Areas.MaxProgress);
            s_log.AppendLine("  tracker periods: " + string.Join("; ", combat.Tracker.CombatPeriods.Select(p =>
                "sample " + p.SamplePeriod + "ms x" + p.SampleCount + " recorded " + p.Damage.RecordedCount + " total " + p.Damage.Total)));
        });

        Section("Areas (" + combat.Areas.ActiveAreas.Count + ")", () =>
        {
            foreach (BaseCombatArea area in combat.Areas.ActiveAreas.Keys.Take(60))
            {
                string enemies = area is CombatArea normal
                    ? string.Join(", ", normal.Enemies.Select(e => e.Id + (e.Requirements.AreMet ? "" : "(locked)")))
                    : "";
                s_log.AppendLine("  " + area.Id + " [" + area.GetType().Name + "] unlocked=" + area.UnlockRequirements.AreMet + "  " + enemies);
            }
        });

        Section("Combat screen", () =>
        {
            GameView? view = GameUi.FindGameView(tree);
            Node? screen = view?.EntityViewContainer.GetChildren().FirstOrDefault(c => c is CombatActiveView);
            if (screen == null)
            {
                s_log.AppendLine("  Combat page is not open; open it and run the probe again for the tab layout.");
                return;
            }
            s_log.AppendLine("  path: " + screen.GetPath());
            foreach (string name in new[] { "PlayerInfoTabContainer", "EnemyInfoTabContainer" })
            {
                var tabs = screen.Get(name).As<TabContainer>();
                if (tabs == null)
                {
                    s_log.AppendLine("  " + name + ": not found");
                    continue;
                }
                s_log.AppendLine("  " + name + ": path=" + tabs.GetPath() + " current=" + tabs.CurrentTab + " tabs visible=" + tabs.TabsVisible
                    + " variation=" + tabs.ThemeTypeVariation);
                for (int i = 0; i < tabs.GetTabCount(); i++)
                {
                    s_log.AppendLine("    tab " + i + ": title='" + tabs.GetTabTitle(i) + "' icon=" + tabs.GetTabIcon(i)?.ResourcePath
                        + " hidden=" + tabs.IsTabHidden(i) + " control=" + tabs.GetTabControl(i)?.Name + " <" + tabs.GetTabControl(i)?.GetClass() + ">");
                }
                s_log.Append(UiProbe.DumpNode(tabs, 1));
                s_log.Append(UiProbe.DumpNode(tabs.GetTabBar(), 0));
            }
            s_log.AppendLine("  -- screen, three levels deep --");
            s_log.Append(UiProbe.DumpNode(screen, 3, withProperties: false));
        });
    }

    private static void Section(string title, Action body)
    {
        s_log.AppendLine();
        s_log.AppendLine("## " + title);
        try
        {
            body();
        }
        catch (Exception e)
        {
            s_log.AppendLine("  !! " + e.GetType().Name + ": " + e.Message);
        }
    }
}
