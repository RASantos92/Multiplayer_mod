using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Statistics;
using GamesByMalcs.Melvor2.Entities.Agility.Statistics;
using GamesByMalcs.Melvor2.Entities.Combat.Statistics;
using GamesByMalcs.Melvor2.Entities.Thieving.Statistics;

namespace Melvor2.Chat.GameState;

/// <summary>
/// Reads the game's own lifetime counters that Guild Grounds tasks are measured by: monsters killed (per
/// monster), Agility courses completed (per course) and successful Thieving actions (per target).
///
/// The mod never counts events itself. It compares these totals with the last reading, so whatever the game
/// counted while it was closed or catching up is included, with no mod code running during that time.
/// Main thread only, with a game from <see cref="GameAccess.Current"/>.
/// </summary>
internal static class GroundsCounter
{
    public const string Kills = "kills";
    public const string Laps = "laps";
    public const string Steals = "steals";

    public static readonly string[] Kinds = { Kills, Laps, Steals };

    /// <summary>Total skill XP of the character: it never goes down, so a drop means a different save.</summary>
    public static long TotalXp(Game game) =>
        game.Data.TryGetObject<AggregateStatistic>("MelvorBase:TotalSkillExperience", out AggregateStatistic? xp) ? (long)xp.Value : 0;

    /// <summary>Kind, then game id, then the lifetime total.</summary>
    public static Dictionary<string, Dictionary<string, long>> Read(Game game)
    {
        var kills = new Dictionary<string, long>();
        var laps = new Dictionary<string, long>();
        var steals = new Dictionary<string, long>();

        if (game.Data.TryGetObject<EnemyStatistic>("MelvorBase:CombatEnemyKilled", out EnemyStatistic? killed))
        {
            foreach (var pair in killed.Values) kills[pair.Key.Id] = (long)pair.Value;
        }
        if (game.Data.TryGetObject<AgilityCourseStatistic>("MelvorBase:AgilityCourseCompleted", out AgilityCourseStatistic? courses))
        {
            foreach (var pair in courses.Values) laps[pair.Key.Id] = (long)pair.Value;
        }
        if (game.Data.TryGetObject<ThievingRecipeStatistic>("MelvorBase:ThievingSuccessfulAction", out ThievingRecipeStatistic? thefts))
        {
            foreach (var pair in thefts.Values) steals[pair.Key.Id] = (long)pair.Value;
        }
        return new Dictionary<string, Dictionary<string, long>> { [Kills] = kills, [Laps] = laps, [Steals] = steals };
    }
}
