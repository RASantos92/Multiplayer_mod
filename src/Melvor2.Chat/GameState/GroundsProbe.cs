using System.Collections;
using System.Reflection;
using System.Text;
using System.Text.Json;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Statistics;
using GamesByMalcs.Melvor2.Data;
using GamesByMalcs.Melvor2.Localization;
using GamesByMalcs.Melvor2.Modifiers;
using Godot;

namespace Melvor2.Chat.GameState;

/// <summary>
/// Developer tool for Guild Grounds. When mod-probe\grounds-probe.request exists in the game's user-data
/// folder, it waits for a loaded save and writes grounds-probe.txt with:
///   - the game's gathering recipes, agility courses, thieving targets and combat areas (ids, names, levels);
///   - the lifetime counters Guild Grounds wants to read, now and again ten seconds later;
///   - whether each of the five tier one bonuses can be added and removed as a modifier.
/// It only reads, apart from the modifiers, which it removes again straight away.
/// </summary>
internal static class GroundsProbe
{
    private sealed class ProbeSource : INamedObject
    {
        public ILocalizedString DisplayName { get; } = new LocalizedString("Guild Grounds (probe)");
    }

    /// <summary>Data classes worth listing, by type name.</summary>
    private static readonly HashSet<string> s_wanted = new()
    {
        "WoodcuttingRecipe", "MiningRecipe", "FishingRecipe", "FishingLocation", "FarmingRecipe", "FarmingCategory",
        "RanchingAnimal", "RanchingAnimalVariant", "RanchingCategory", "HuntingAnimal", "HuntingAnimalSpecies",
        "AgilityLocation", "AgilityCourse", "ThievingLocation", "ThievingRecipe",
        "CombatArea", "Dungeon", "CombatAreaCategory", "BankTagCategory", "CombatStyle",
        "ArtisanRecipe", "CookingRecipe", "HerbloreRecipe", "FiremakingRecipe", "GrainMillRecipe", "Enemy",
    };

    /// <summary>Properties that only add noise to the listing.</summary>
    private static readonly HashSet<string> s_skip = new()
    {
        "Namespace", "LocalId", "Id", "Icon", "IconPath", "Description", "Media", "Texture", "Sprite", "Background",
        "Attacks", "Passives", "Drops", "Stats", "Levels", "AttackStances", "DisplayRequirements", "UnlockRequirements",
    };

    private static readonly string s_dir = Path.Combine(OS.GetUserDataDir(), "mod-probe");
    private static readonly string s_request = Path.Combine(s_dir, "grounds-probe.request");
    private static readonly string s_output = Path.Combine(s_dir, "grounds-probe.txt");

    private static readonly StringBuilder s_log = new();
    private static readonly ProbeSource s_source = new();
    private static int s_stage;
    private static int s_frames;
    private static bool s_done;

    public static bool Requested => !s_done && File.Exists(s_request);

    public static void Tick(SceneTree tree)
    {
        if (s_done) return;
        Game? game = GameAccess.Current(tree);
        if (game == null)
        {
            s_frames = 0;
            return;
        }
        s_frames++;

        try
        {
            switch (s_stage)
            {
                case 0 when s_frames > 240:
                    s_log.AppendLine("# Melvor Idle 2 grounds probe " + DateTime.Now.ToString("u"));
                    s_log.AppendLine();
                    s_log.AppendLine("## Counters (first reading)");
                    Counters(game);
                    Modifiers(game);
                    Items(game);
                    Tables(game);
                    s_stage = 1;
                    s_frames = 0;
                    break;
                case 1 when s_frames > 600:
                    s_log.AppendLine();
                    s_log.AppendLine("## Counters (about ten seconds later)");
                    Counters(game);
                    Finish();
                    break;
            }
        }
        catch (Exception e)
        {
            s_log.AppendLine("!! " + e);
            Finish();
        }
    }

    private static void Finish()
    {
        s_done = true;
        Directory.CreateDirectory(s_dir);
        File.WriteAllText(s_output, s_log.ToString());
        File.Delete(s_request);
        ModEntry.Log("Grounds probe written to " + s_output);
    }

    private static string Character(string stat, double value, string extra) =>
        "{\"Global\":[],\"Component\":[{\"Stat\":{\"StatsType\":\"MelvorBase:Character\",\"Name\":\"" + stat + "\"},"
        + "\"LocalContext\":{\"Component\":{\"Entity\":\"MelvorBase:Combat\",\"Component\":\"Player\"}" + extra + "},"
        + "\"Value\":" + value.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}]}";

    private static string Component(string statsType, string stat, string entity, string component, double value) =>
        "{\"Global\":[],\"Component\":[{\"Stat\":{\"StatsType\":\"" + statsType + "\",\"Name\":\"" + stat + "\"},"
        + "\"LocalContext\":{\"Component\":{\"Entity\":\"" + entity + "\",\"Component\":\"" + component + "\"}},"
        + "\"Value\":" + value.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}]}";

    private static void Counters(Game game)
    {
        foreach (AggregateStatistic stat in game.Data.Database.GetRegistry<AggregateStatistic>().GetAllObjects().OrderBy(s => s.Id))
        {
            s_log.AppendLine("  " + stat.Id + " = " + stat.Value.ToString("0.##") + "   (" + Safe(() => stat.DisplayName) + ")");
        }
        foreach (SimpleStatistic stat in game.Data.Database.GetRegistry<SimpleStatistic>().GetAllObjects().OrderBy(s => s.Id))
        {
            if (stat.Value != 0) s_log.AppendLine("  " + stat.Id + " = " + stat.Value.ToString("0.##"));
        }

        // Kills per monster: the per-enemy dictionary behind CombatTotalEnemiesKilled.
        foreach ((Type type, DataRegistry registry) in game.Data.Database.Registries)
        {
            if (type.Name != "EnemyStatistic" && type.Name != "AgilityCourseStatistic" && type.Name != "ThievingRecipeStatistic") continue;
            foreach (object stat in All(registry))
            {
                if (stat is not INamespacedObject named) continue;
                if (!named.Id.EndsWith("EnemyKilled") && !named.Id.EndsWith("CourseCompleted") && !named.Id.EndsWith("SuccessfulAction")) continue;
                s_log.AppendLine("  " + named.Id + "  [" + stat.GetType().FullName + "]");
                if (stat.GetType().GetProperty("Values")?.GetValue(stat) is not IEnumerable values) continue;
                foreach (object pair in values)
                {
                    object? key = pair.GetType().GetProperty("Key")?.GetValue(pair);
                    object? value = pair.GetType().GetProperty("Value")?.GetValue(pair);
                    s_log.AppendLine("      " + ((key as INamespacedObject)?.Id ?? "?") + " = " + value);
                }
            }
        }
    }

    private static void Modifiers(Game game)
    {
        s_log.AppendLine();
        s_log.AppendLine("## Bonus modifiers (each is added, then removed)");
        ModifierSystem? modifiers = GameAccess.Modifiers(game);
        if (modifiers == null)
        {
            s_log.AppendLine("  no modifier system found");
            return;
        }
        // One at a time, so a refusal names the bonus; these are exactly the entries the mod would apply.
        foreach (string id in GroundsBonus.AllIds())
        {
            string json = "{\"Global\":[],\"Component\":[" + string.Join(",", GroundsBonus.Entries(id, 3)) + "]}";
            try
            {
                using JsonDocument doc = JsonDocument.Parse(json);
                var values = new ModifierValues(game.Data, doc.RootElement);
                modifiers.Add(s_source, values);
                bool removed = modifiers.Remove(s_source);
                s_log.AppendLine("  ok       " + id + "   removed=" + removed);
            }
            catch (Exception e)
            {
                s_log.AppendLine("  FAILED   " + id + "   " + (e.InnerException ?? e).GetType().Name + ": " + (e.InnerException ?? e).Message);
                s_log.AppendLine("           " + json);
                try
                {
                    modifiers.Remove(s_source);
                }
                catch (Exception)
                {
                    // Best effort: never leave the probe's modifier behind.
                }
            }
        }
    }

    /// <summary>Every item: id, name and gold value, one per line.</summary>
    private static void Items(Game game)
    {
        s_log.AppendLine();
        s_log.AppendLine("## Items");
        foreach (GamesByMalcs.Melvor2.Data.Items.Item item in game.Data.Database.GetRegistry<GamesByMalcs.Melvor2.Data.Items.Item>().GetAllObjects().OrderBy(i => i.Id))
        {
            s_log.AppendLine("  " + item.Id + " | " + Safe(() => BankAccess.Name(item)) + " | " + Safe(() => BankAccess.ValueOf(item).ToString()));
        }
    }

    private static void Tables(Game game)
    {
        var registries = new List<(Type Type, object Registry)>();
        foreach ((Type type, DataRegistry registry) in game.Data.Database.Registries) registries.Add((type, registry));
        foreach ((Type type, INamespacedDataClassRegistry registry) in game.Data.Database.DataClassRegistries)
        {
            if (registries.All(r => r.Type != type)) registries.Add((type, registry));
        }

        s_log.AppendLine();
        s_log.AppendLine("## All data classes: " + string.Join(", ", registries.Select(r => r.Type.Name).OrderBy(n => n)));

        foreach ((Type type, object registry) in registries.OrderBy(r => r.Type.Name))
        {
            if (!s_wanted.Contains(type.Name)) continue;
            s_log.AppendLine();
            s_log.AppendLine("## " + type.Name);
            foreach (object item in All(registry))
            {
                s_log.AppendLine("  " + ((item as INamespacedObject)?.Id ?? item.ToString()));
                foreach (PropertyInfo property in item.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (s_skip.Contains(property.Name) || property.GetIndexParameters().Length > 0) continue;
                    string text = Safe(() => Show(property.GetValue(item), 0));
                    if (text.Length > 0) s_log.AppendLine("      " + property.Name + ": " + text);
                }
            }
        }
    }

    private static IEnumerable<object> All(object registry)
    {
        MethodInfo? method = registry.GetType().GetMethod("GetAllObjects", Type.EmptyTypes);
        if (method?.Invoke(registry, null) is not IEnumerable all) yield break;
        foreach (object? item in all)
        {
            if (item != null) yield return item;
        }
    }

    private static string Safe(Func<string> read)
    {
        try
        {
            return read();
        }
        catch (Exception e)
        {
            return "<" + (e.InnerException ?? e).GetType().Name + ">";
        }
    }

    /// <summary>A short, readable form of a value: ids for game objects, levels for requirements.</summary>
    private static string Show(object? value, int depth)
    {
        switch (value)
        {
            case null:
                return "";
            case string text:
                return text;
            case bool or Enum:
                return value.ToString() ?? "";
            case IFormattable number when value.GetType().IsPrimitive || value is decimal:
                return number.ToString(null, System.Globalization.CultureInfo.InvariantCulture);
            case INamespacedObject named:
                return named.Id;
            case IPluralString plural:
                return plural.GetPluralText(1);
            case ILocalizedString localized:
                return localized.Message;
            case Godot.GodotObject:
                return "";
        }

        Type type = value.GetType();
        if (type.Name == "LevelCondition") return "Level(" + type.GetProperty("Level")?.GetValue(value) + ")";
        if (depth >= 3) return type.Name;

        if (value is IEnumerable list)
        {
            var parts = new List<string>();
            foreach (object? item in list)
            {
                if (parts.Count >= 30)
                {
                    parts.Add("...");
                    break;
                }
                string part = Show(item, depth + 1);
                if (part.Length > 0) parts.Add(part);
            }
            return parts.Count == 0 ? "" : "[" + string.Join(", ", parts) + "]";
        }

        var fields = new List<string>();
        foreach (PropertyInfo property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (s_skip.Contains(property.Name) || property.GetIndexParameters().Length > 0) continue;
            string part = Safe(() => Show(property.GetValue(value), depth + 1));
            if (part.Length > 0) fields.Add(property.Name + "=" + part);
            if (fields.Count >= 12) break;
        }
        return type.Name + "{" + string.Join(", ", fields) + "}";
    }
}
