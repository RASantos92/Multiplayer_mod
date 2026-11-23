using System.Globalization;
using System.Text.Json;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Data;
using GamesByMalcs.Melvor2.Localization;
using GamesByMalcs.Melvor2.Modifiers;

namespace Melvor2.Chat.GameState;

/// <summary>
/// The passive bonuses a guild has earned on its Guild Grounds, applied as one game modifier.
///
/// The server only names a bonus and its size; what each name does is fixed here, and every size is capped,
/// so a server can never hand the game arbitrary modifier data. The game does not save modifiers: the bonus
/// exists only while the mod keeps it in place, and it is only ever added or removed on the main thread with
/// a game that is safe to touch.
/// </summary>
internal sealed class GroundsBonus
{
    /// <summary>No single bonus may exceed this many percent, whatever the server says.</summary>
    private const long MaxPercent = 25;

    private sealed class Source : INamedObject
    {
        public ILocalizedString DisplayName { get; } = new LocalizedString("Guild Grounds");
    }

    private readonly Source _source = new();
    private Game? _game;
    private ModifierSystem? _modifiers;
    private string _applied = "";
    private string _refused = "";

    /// <summary>True if this mod version knows how to apply the bonus.</summary>
    public static bool Knows(string id) => Entries(id, 1).Count > 0;

    /// <summary>Main thread, game accessible. <paramref name="bonuses"/> is bonus id to percent; empty removes it.</summary>
    public void Update(Game game, IReadOnlyDictionary<string, long> bonuses)
    {
        if (!ReferenceEquals(game, _game))
        {
            // Another save was loaded: the old game, and the modifier with it, are gone.
            _game = game;
            _modifiers = null;
            _applied = "";
            _refused = "";
        }

        var entries = new List<string>();
        foreach ((string id, long percent) in bonuses.OrderBy(b => b.Key, StringComparer.Ordinal))
        {
            entries.AddRange(Entries(id, Math.Clamp(percent, 0, MaxPercent)));
        }
        string wanted = string.Join(",", entries);
        if (wanted == _applied || (wanted.Length > 0 && wanted == _refused)) return;

        try
        {
            _modifiers ??= GameAccess.Modifiers(game);
            if (_modifiers == null) throw new InvalidOperationException("modifier system not found");
            _modifiers.Remove(_source);
            _applied = "";
            if (wanted.Length == 0)
            {
                ModEntry.Log("Guild Grounds bonuses off.");
                return;
            }
            using JsonDocument doc = JsonDocument.Parse("{\"Global\":[],\"Component\":[" + wanted + "]}");
            _modifiers.Add(_source, new ModifierValues(game.Data, doc.RootElement));
            _applied = wanted;
            ModEntry.Log("Guild Grounds bonuses on: " + string.Join(", ", bonuses.Select(b => b.Key + " " + b.Value + "%")));
        }
        catch (Exception e)
        {
            // The game refused it. Do not retry the same set every tick.
            _refused = wanted;
            ModEntry.Log("Guild Grounds bonuses not applied: " + e.Message);
        }
    }

    /// <summary>The modifier entries for one bonus; empty for a bonus this version does not know.</summary>
    private static List<string> Entries(string id, long percent)
    {
        double value = percent / 100.0;
        const string player = "\"Component\":{\"Entity\":\"MelvorBase:Combat\",\"Component\":\"Player\"}";
        const string fishing = "\"Component\":{\"Entity\":\"MelvorBase:Fishing\",\"Component\":\"Action\"}";
        const string ranching = "\"Component\":{\"Entity\":\"MelvorBase:Ranching\",\"Component\":\"Passive\"}";
        var list = new List<string>();
        if (percent <= 0) return list;
        switch (id)
        {
            case "protection":
                list.Add(Entry("MelvorBase:Character", "PercentProtectionRating", player, value));
                break;
            case "rangedAccuracy":
                list.Add(Entry("MelvorBase:Character", "PercentAccuracyRating", player + ",\"CombatStyle\":\"MelvorBase:Ranged\"", value));
                break;
            case "accuracy":
                list.Add(Entry("MelvorBase:Character", "PercentAccuracyRating", player, value));
                break;
            case "damageTaken":
                list.Add(Entry("MelvorBase:Character", "PercentDamageTaken", player, -value));
                break;
            case "fishingSpeed":
                list.Add(Entry("MelvorBase:FishingAction", "PercentMinInterval", fishing, -value));
                list.Add(Entry("MelvorBase:FishingAction", "PercentMaxInterval", fishing, -value));
                break;
            case "ranchingSpeed":
                list.Add(Entry("MelvorBase:RanchingAction", "PercentProductInterval", ranching, -value));
                break;
        }
        return list;
    }

    private static string Entry(string statsType, string stat, string context, double value) =>
        "{\"Stat\":{\"StatsType\":\"" + statsType + "\",\"Name\":\"" + stat + "\"},\"LocalContext\":{" + context + "},\"Value\":"
        + value.ToString(CultureInfo.InvariantCulture) + "}";
}
