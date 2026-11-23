using System.Collections;
using System.Reflection;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Statistics;
using GamesByMalcs.Melvor2.Data;

namespace Melvor2.Chat.GameState;

/// <summary>
/// Reads the game's own lifetime counters that Guild Grounds tasks are measured by. Each is a statistic that
/// keeps one total per game object, for example:
///   MelvorBase:CombatEnemyKilled         monsters killed, per monster
///   MelvorBase:AgilityCourseCompleted    Agility courses completed, per course
///   MelvorBase:ThievingSuccessfulAction  successful Thieving actions, per target
///   MelvorBase:SmithingItemGained        items made by Smithing, per item (and the same for other skills)
///
/// The mod never counts events itself. It compares these totals with the last reading, so whatever the game
/// counted while it was closed or catching up is included, with no mod code running during that time.
/// Main thread only, with a game from <see cref="GameAccess.Current"/>.
/// </summary>
internal static class GroundsCounter
{
    private static Game? s_game;
    private static Dictionary<string, object> s_stats = new();
    private static readonly Dictionary<Type, PropertyInfo?> s_values = new();

    /// <summary>Total skill XP of the character: it never goes down, so a drop means a different save.</summary>
    public static long TotalXp(Game game) =>
        game.Data.TryGetObject<AggregateStatistic>("MelvorBase:TotalSkillExperience", out AggregateStatistic? xp) ? (long)xp.Value : 0;

    /// <summary>Every per-object statistic the game has, by id.</summary>
    public static IReadOnlyDictionary<string, object> All(Game game)
    {
        if (ReferenceEquals(game, s_game)) return s_stats;
        var found = new Dictionary<string, object>();
        foreach ((Type type, DataRegistry registry) in game.Data.Database.Registries)
        {
            if (!IsPerObject(type)) continue;
            if (registry.GetType().GetMethod("GetAllObjects", Type.EmptyTypes)?.Invoke(registry, null) is not IEnumerable all) continue;
            foreach (object? stat in all)
            {
                if (stat is INamespacedObject named && IsPerObject(stat.GetType())) found[named.Id] = stat;
            }
        }
        s_game = game;
        s_stats = found;
        return found;
    }

    /// <summary>The totals of one statistic, by game object id; null if the game has no such statistic.</summary>
    public static Dictionary<string, long>? Read(Game game, string statId)
    {
        if (!All(game).TryGetValue(statId, out object? stat)) return null;
        Type type = stat.GetType();
        if (!s_values.TryGetValue(type, out PropertyInfo? property))
        {
            property = type.GetProperty("Values");
            s_values[type] = property;
        }
        if (property?.GetValue(stat) is not IEnumerable values) return null;

        var totals = new Dictionary<string, long>();
        foreach (object pair in values)
        {
            // Each entry is a KeyValuePair<TObject, double>; the type differs per statistic.
            Type entry = pair.GetType();
            if (entry.GetProperty("Key")?.GetValue(pair) is INamespacedObject key && entry.GetProperty("Value")?.GetValue(pair) is double total)
            {
                totals[key.Id] = (long)total;
            }
        }
        return totals;
    }

    private static bool IsPerObject(Type? type)
    {
        for (; type != null; type = type.BaseType)
        {
            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(DictionaryStatistic<>)) return true;
        }
        return false;
    }
}
