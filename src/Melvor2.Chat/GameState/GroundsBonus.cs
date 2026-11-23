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

    /// <summary>The stats behind "speed:Skill" and "double:Skill": stats type, component, interval stats, doubling stat.</summary>
    private static readonly Dictionary<string, (string Type, string Component, string[] Interval, string? Doubling)> s_skills = new()
    {
        ["Woodcutting"] = ("WoodcuttingAction", "Action", new[] { "PercentInterval" }, "DoublingChance"),
        ["Mining"] = ("MiningAction", "Action", new[] { "PercentInterval" }, "DoublingChance"),
        ["Fishing"] = ("FishingAction", "Action", new[] { "PercentMinInterval", "PercentMaxInterval" }, "DoublingChance"),
        ["Smithing"] = ("ArtisanAction", "Action", new[] { "PercentInterval" }, "DoublingChance"),
        ["Crafting"] = ("ArtisanAction", "Action", new[] { "PercentInterval" }, "DoublingChance"),
        ["Fletching"] = ("ArtisanAction", "Action", new[] { "PercentInterval" }, "DoublingChance"),
        ["Runecrafting"] = ("ArtisanAction", "Action", new[] { "PercentInterval" }, "DoublingChance"),
        ["Beastcrafting"] = ("ArtisanAction", "Action", new[] { "PercentInterval" }, "DoublingChance"),
        ["Cooking"] = ("CookingAction", "Action", new[] { "PercentInterval" }, "DoublingChance"),
        ["Herblore"] = ("HerbloreAction", "Action", Array.Empty<string>(), "DoublingChance"),
        ["Farming"] = ("FarmingAction", "Passive", new[] { "PercentInterval" }, "DoublingChance"),
        ["Ranching"] = ("RanchingAction", "Passive", new[] { "PercentProductInterval" }, "DoublingChance"),
        ["Thieving"] = ("ThievingAction", "Action", new[] { "PercentInterval" }, "DoublingChance"),
        ["Hunting"] = ("HuntingAction", "Action", Array.Empty<string>(), "DoublingChance"),
    };

    /// <summary>Skills that "xp:Skill" may name, and that "xp:NonCombat" covers.</summary>
    private static readonly string[] s_nonCombat =
    {
        "Woodcutting", "Mining", "Fishing", "Firemaking", "Smithing", "Cooking", "Crafting", "Runecrafting", "Fletching", "Farming",
        "Ranching", "Hunting", "Beastcrafting", "Agility", "Herblore", "Thieving", "Astrology",
    };

    private static readonly string[] s_combatXp = { "Prayer", "Slayer" };

    /// <summary>Every bonus id this version can apply, for the developer probe.</summary>
    internal static IEnumerable<string> AllIds()
    {
        foreach (string id in new[] { "protection", "accuracy", "rangedAccuracy", "meleeAccuracy", "magicAccuracy", "damageTaken", "damageDealt",
                     "rangedDamage", "meleeDamage", "magicDamage", "maxHitpoints", "fishingSpeed", "ranchingSpeed", "xp:NonCombat" }) yield return id;
        foreach (string skill in s_nonCombat.Concat(s_combatXp)) yield return "xp:" + skill;
        foreach ((string skill, var stats) in s_skills)
        {
            if (stats.Interval.Length > 0) yield return "speed:" + skill;
            if (stats.Doubling != null) yield return "double:" + skill;
        }
    }

    /// <summary>
    /// The modifier entries for one bonus; empty for a bonus this version does not know.
    /// Ids are either a fixed name ("protection") or a family and a skill ("xp:Mining", "speed:Crafting",
    /// "double:Smithing"): more XP, shorter actions, or a chance to double what the skill produces.
    /// </summary>
    internal static List<string> Entries(string id, long percent)
    {
        double value = percent / 100.0;
        const string player = "\"Component\":{\"Entity\":\"MelvorBase:Combat\",\"Component\":\"Player\"}";
        static string Style(string style) => player + ",\"CombatStyle\":\"MelvorBase:" + style + "\"";
        static string Of(string skill, string component) => "\"Component\":{\"Entity\":\"MelvorBase:" + skill + "\",\"Component\":\"" + component + "\"}";
        var list = new List<string>();
        if (percent <= 0) return list;

        int colon = id.IndexOf(':');
        if (colon > 0)
        {
            string family = id.Substring(0, colon);
            string skill = id.Substring(colon + 1);
            if (family == "xp")
            {
                IEnumerable<string> skills = skill == "NonCombat" ? s_nonCombat
                    : s_nonCombat.Contains(skill) || s_combatXp.Contains(skill) ? new[] { skill } : Array.Empty<string>();
                foreach (string one in skills) list.Add(Entry("MelvorBase:Experience", "PercentXPGained", Of(one, "Experience"), value));
            }
            else if (s_skills.TryGetValue(skill, out var stats))
            {
                if (family == "speed")
                {
                    foreach (string stat in stats.Interval) list.Add(Entry("MelvorBase:" + stats.Type, stat, Of(skill, stats.Component), -value));
                }
                else if (family == "double" && stats.Doubling != null)
                {
                    list.Add(Entry("MelvorBase:" + stats.Type, stats.Doubling, Of(skill, stats.Component), value));
                }
            }
            return list;
        }

        switch (id)
        {
            case "protection":
                list.Add(Entry("MelvorBase:Character", "PercentProtectionRating", player, value));
                break;
            case "accuracy":
                list.Add(Entry("MelvorBase:Character", "PercentAccuracyRating", player, value));
                break;
            case "rangedAccuracy":
                list.Add(Entry("MelvorBase:Character", "PercentAccuracyRating", Style("Ranged"), value));
                break;
            case "meleeAccuracy":
                list.Add(Entry("MelvorBase:Character", "PercentAccuracyRating", Style("Melee"), value));
                break;
            case "magicAccuracy":
                list.Add(Entry("MelvorBase:Character", "PercentAccuracyRating", Style("Magic"), value));
                break;
            case "damageTaken":
                list.Add(Entry("MelvorBase:Character", "PercentDamageTaken", player, -value));
                break;
            case "damageDealt":
                list.Add(Entry("MelvorBase:Character", "PercentDamageDealt", player, value));
                break;
            case "rangedDamage":
                list.Add(Entry("MelvorBase:Character", "PercentMaxHit", Style("Ranged"), value));
                break;
            case "meleeDamage":
                list.Add(Entry("MelvorBase:Character", "PercentMaxHit", Style("Melee"), value));
                break;
            case "magicDamage":
                list.Add(Entry("MelvorBase:Character", "PercentMaxHit", Style("Magic"), value));
                break;
            case "maxHitpoints":
                list.Add(Entry("MelvorBase:Character", "PercentMaxHitpoints", player, value));
                break;
            case "fishingSpeed":
                return Entries("speed:Fishing", percent);
            case "ranchingSpeed":
                return Entries("speed:Ranching", percent);
        }
        return list;
    }

    private static string Entry(string statsType, string stat, string context, double value) =>
        "{\"Stat\":{\"StatsType\":\"" + statsType + "\",\"Name\":\"" + stat + "\"},\"LocalContext\":{" + context + "},\"Value\":"
        + value.ToString(CultureInfo.InvariantCulture) + "}";
}
