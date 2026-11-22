using System.Text;
using System.Text.Json;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Actions;
using GamesByMalcs.Melvor2.Components.Equipment;
using GamesByMalcs.Melvor2.Components.Experience;
using GamesByMalcs.Melvor2.Data;
using GamesByMalcs.Melvor2.Entities;
using GamesByMalcs.Melvor2.Entities.Combat;
using GamesByMalcs.Melvor2.Entities.Fishing;
using GamesByMalcs.Melvor2.Localization;
using GamesByMalcs.Melvor2.Modifiers;
using Godot;

namespace Melvor2.Chat.GameState;

/// <summary>
/// Developer tool, like UiProbe. When mod-probe\game-probe.request exists in the game's user-data folder, it
/// waits for a loaded save, writes game-probe.txt (current action ids, skills, equipped gear), then adds a
/// +5% XP modifier for the active skill for about two seconds and records the XP-per-action figure before,
/// during and after. This confirms the ids and the modifier behaviour the party boost relies on.
/// </summary>
internal static class GameProbe
{
    private sealed class ProbeSource : INamedObject
    {
        public ILocalizedString DisplayName { get; } = new LocalizedString("Guild Party Bonus (probe)");
    }

    private static readonly string s_dir = Path.Combine(OS.GetUserDataDir(), "mod-probe");
    private static readonly string s_request = Path.Combine(s_dir, "game-probe.request");
    private static readonly string s_output = Path.Combine(s_dir, "game-probe.txt");

    private static readonly StringBuilder s_log = new();
    private static readonly ProbeSource s_source = new();
    private static int s_stage;
    private static int s_frames;
    private static ModifierSystem? s_modifiers;
    private static Func<string>? s_readXp;
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
                    Describe(game);
                    BeginModifierTest(game);
                    s_stage = 1;
                    s_frames = 0;
                    break;
                case 1 when s_frames > 120:
                    s_log.AppendLine("with modifier:    " + (s_readXp?.Invoke() ?? "n/a"));
                    bool removed = s_modifiers?.Remove(s_source) ?? false;
                    s_log.AppendLine("removed: " + removed);
                    s_stage = 2;
                    s_frames = 0;
                    break;
                case 2 when s_frames > 120:
                    s_log.AppendLine("after removal:    " + (s_readXp?.Invoke() ?? "n/a"));
                    Finish();
                    break;
            }
        }
        catch (Exception e)
        {
            s_log.AppendLine("!! " + e);
            try
            {
                s_modifiers?.Remove(s_source);
            }
            catch (Exception)
            {
                // Best effort: never leave the probe's modifier behind.
            }
            Finish();
        }
    }

    private static void Finish()
    {
        s_done = true;
        Directory.CreateDirectory(s_dir);
        File.WriteAllText(s_output, s_log.ToString());
        File.Delete(s_request);
        ModEntry.Log("Game probe written to " + s_output);
    }

    private static void Describe(Game game)
    {
        s_log.AppendLine("# Melvor Idle 2 game probe " + DateTime.Now.ToString("u"));
        s_log.AppendLine("character: " + game.CharacterName);

        s_log.AppendLine();
        s_log.AppendLine("## Active actions");
        foreach (ActionComponent action in game.ActionManager.ActiveActions)
        {
            IDescribedObject? target = action.CurrentDescription;
            s_log.AppendLine("  component: " + action.GetType().FullName + "  started=" + action.IsStarted);
            s_log.AppendLine("  entity:    " + action.Entity.Id + "  (" + action.Entity.DisplayName.Message + ")  icon=" + action.Entity.IconPath);
            s_log.AppendLine("  target:    " + (target == null ? "null" : target.Id + "  [" + target.GetType().FullName + "]  name=" + target.DisplayName.Message));
            if (target is FishingRecipe recipe)
            {
                s_log.AppendLine("  location:  " + recipe.Location.Id + "  name=" + recipe.Location.DisplayName.Message);
                s_log.AppendLine("  requirements met: " + recipe.Requirements.AreMet + "  conditions: "
                    + string.Join("; ", recipe.Requirements.Conditions.Select(c => c.GetType().Name + (c is LevelCondition l ? "(" + l.Level + ")" : "") + "=" + c.IsMet)));
            }
        }
        if (!game.ActionManager.HasActiveAction) s_log.AppendLine("  (none)");

        s_log.AppendLine();
        s_log.AppendLine("## Skills");
        foreach (ILeveledEntity<ExperienceComponent> skill in game.LeveledEntities)
        {
            s_log.AppendLine("  " + skill.Id + "  level " + skill.Experience.Level + "/" + skill.Experience.LevelCap
                + "  name=" + skill.DisplayName.Message + "  icon=" + skill.IconPath
                + "  component keys=" + string.Join(",", ((GameEntity)skill).Components.Keys));
        }

        s_log.AppendLine();
        s_log.AppendLine("## Equipped gear");
        if (game.Entities.TryGetObjectById("MelvorBase:Combat", out GameEntity? found) && found is CombatEntity combat)
        {
            EquipmentComponent equipment = combat.Equipment;
            foreach (EquipmentSlot slot in equipment.Config.EquipmentSlots)
            {
                if (!equipment.TryGetActiveSlot(slot, out IActiveEquipmentSlot? active)) continue;
                string content = active.IsOccupied ? "(blocked by another item)"
                    : active.IsEmpty ? "(empty)"
                    : active.Equipped!.Item.Id + " x" + active.Quantity + "  icon=" + active.Equipped.Item.Icon?.ResourcePath;
                s_log.AppendLine("  " + slot.Id + "  grid=" + slot.GridPosition + "  " + content);
            }
        }
        else
        {
            s_log.AppendLine("  Combat entity not found");
        }
    }

    private static void BeginModifierTest(Game game)
    {
        s_log.AppendLine();
        s_log.AppendLine("## Modifier test (+5% XP on the active skill)");

        s_modifiers = GameAccess.Modifiers(game);
        s_log.AppendLine("modifier system found: " + (s_modifiers != null));
        ActionComponent? action = game.ActionManager.ActiveActions.FirstOrDefault();
        if (s_modifiers == null || action == null)
        {
            s_log.AppendLine("skipped: no modifier system or no active action");
            return;
        }

        if (action.Entity is FishingEntity fishing && action.CurrentDescription is FishingRecipe recipe
            && fishing.Action.Recipes.TryGetValue(recipe, out ActiveFishingRecipe? active))
        {
            ExperienceStats stats = active.Stats.Experience;
            s_readXp = () => "xp per action=" + stats.XpToAdd.Value.ToString("0.####")
                + "  base=" + stats.BaseXp.Value.ToString("0.####")
                + "  percent total=" + stats.PercentXPGained.Total.Value.ToString("0.####");
        }
        else
        {
            s_log.AppendLine("XP readout only implemented for Fishing in this probe; start fishing to see the numbers.");
        }

        s_log.AppendLine("before:           " + (s_readXp?.Invoke() ?? "n/a"));

        string json = "{\"Global\":[],\"Component\":[{\"Stat\":{\"StatsType\":\"MelvorBase:Experience\",\"Name\":\"PercentXPGained\"},"
            + "\"LocalContext\":{\"Component\":{\"Entity\":" + JsonSerializer.Serialize(action.Entity.Id) + ",\"Component\":\"Experience\"}},"
            + "\"Value\":0.05}]}";
        s_log.AppendLine("modifier json: " + json);
        using JsonDocument doc = JsonDocument.Parse(json);
        var values = new ModifierValues(game.Data, doc.RootElement);
        s_modifiers.Add(s_source, values);
        s_log.AppendLine("added");
    }
}
