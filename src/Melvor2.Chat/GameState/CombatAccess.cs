using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Characters;
using GamesByMalcs.Melvor2.Components.CombatTracker;
using GamesByMalcs.Melvor2.Entities;
using GamesByMalcs.Melvor2.Entities.Combat;

namespace Melvor2.Chat.GameState;

/// <summary>What a player in a fight shares with guild mates.</summary>
internal sealed record CombatInfo(int Hp, int MaxHp, int Dps, int Level, int IntervalMs, int HitPercent, int MinHit = 0, int MaxHit = 0);

/// <summary>
/// Reads and nudges the game's combat model. Only call from the main thread with a game from
/// <see cref="GameAccess.Current"/>, which already excludes offline and catch-up progress.
/// </summary>
internal static class CombatAccess
{
    public const string EntityId = "MelvorBase:Combat";

    public static CombatEntity? Find(Game game) =>
        game.Entities.TryGetObjectById(EntityId, out GameEntity? found) ? found as CombatEntity : null;

    /// <summary>True only while an enemy is up and taking hits: not spawning, not paused.</summary>
    public static bool IsFighting(CombatEntity combat) =>
        combat.Action.IsStarted && combat.Action.State == CombatActionState.Fighting && !combat.Action.IsPaused;

    /// <summary>
    /// My own damage per second, the same figure as the game's footer readout. Damage added by
    /// <see cref="DealPartyDamage"/> is not part of it, because the game only counts damage dealt by the player.
    /// </summary>
    public static double Dps(CombatEntity combat)
    {
        IReadonlyCombatTrackerPeriod? period = combat.Tracker.CombatPeriods.FirstOrDefault();
        if (period == null || period.Damage.RecordedCount <= 0 || period.SamplePeriod <= 0) return 0;
        return period.Damage.Total / (period.Damage.RecordedCount * period.SamplePeriod) * 1000.0;
    }

    public static CombatInfo Read(CombatEntity combat)
    {
        (int min, int max) = HitRange(combat);
        return new CombatInfo(
            Math.Max(0, combat.Player.Health.Current), Math.Max(1, combat.Player.Health.Max),
            (int)Math.Clamp(Math.Round(Dps(combat)), 0, 1_000_000_000), Math.Max(0, Level(combat)),
            (int)Math.Clamp(Math.Round(combat.Player.Stats.AttackInterval.Value), 250, 60000),
            (int)Math.Clamp(Math.Round((combat.Player.TargetStats?.HitChance.Value ?? 1.0) * 100), 1, 100),
            min, max);
    }

    private static CombatEntity? s_watched;
    private static DamageWatcher? s_watcher;
    private static bool s_watcherFailed;

    /// <summary>
    /// My smallest and largest hit over all my attacks, the figures the game shows on the stats panel; (0, 0)
    /// when they cannot be read. Uses the game's own watcher, kept for as long as the same save is loaded.
    /// </summary>
    public static (int Min, int Max) HitRange(CombatEntity combat)
    {
        if (s_watcherFailed) return (0, 0);
        try
        {
            if (!ReferenceEquals(combat, s_watched))
            {
                s_watcher?.Dispose();
                s_watcher = null;
                s_watched = combat;
                s_watcher = new AllAttacksDamageWatcher(combat.Player);
            }
            int max = Math.Clamp(s_watcher?.Maximum ?? 0, 0, 1_000_000_000);
            int min = Math.Clamp(s_watcher?.Minimum ?? 0, 0, max);
            return (min, max);
        }
        catch (Exception e)
        {
            s_watcherFailed = true;
            ModEntry.Log("Hit range not available: " + e.Message);
            return (0, 0);
        }
    }

    /// <summary>The overall combat level the game shows for the current combat style.</summary>
    public static int Level(CombatEntity combat) =>
        combat.Player.Stats.CombatStyle.Value.ComputeCombatLevel(combat.Player.CombatLevels);

    /// <summary>
    /// Lowers the enemy's health with no attacker, so the game gives no XP for it and does not count it as the
    /// player's damage. Death, loot and the next spawn follow the game's normal path. Returns the damage done.
    /// Does nothing unless a fight is in progress: killing an enemy that is still spawning would stall combat.
    /// </summary>
    public static int DealPartyDamage(CombatEntity combat, int amount)
    {
        if (amount <= 0 || !IsFighting(combat) || combat.Enemy.Health.Current <= 0) return 0;
        return combat.Enemy.Health.Damage(new ModifiedDamage(amount, 0, 0, 0, amount), HealthChangeCause.Attack, null, combat.Enemy, null);
    }
}
