using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Actions;
using GamesByMalcs.Melvor2.Components.Experience;
using GamesByMalcs.Melvor2.Data;
using GamesByMalcs.Melvor2.Entities;
using GamesByMalcs.Melvor2.Entities.Combat;

namespace Melvor2.Chat.GameState;

/// <summary>
/// What the local player is doing, as stable game ids ("MelvorBase:Fishing" + "MelvorBase:RapidRuns") so it
/// means the same thing on every guild member's machine and in every language.
/// </summary>
internal sealed record ActivityInfo(string EntityId, string TargetId, string Name, string SkillName, int Level, string AreaId = "")
{
    /// <summary>Two players are on "the same action" when their keys match.</summary>
    public string Key => EntityId + "|" + TargetId;
}

internal static class ActivityTracker
{
    /// <summary>The single active action, or null when idle. Main thread, game accessible.</summary>
    public static ActivityInfo? Read(Game game, out ActionComponent? component)
    {
        component = null;
        foreach (ActionComponent action in game.ActionManager.ActiveActions)
        {
            IDescribedObject? target = action.CurrentDescription;
            if (!action.IsStarted || target == null) continue;

            GameEntity entity = action.Entity;
            int level = entity is ILeveledEntity<ExperienceComponent> leveled ? leveled.Experience.Level : 0;
            string skill = entity.DisplayName.Message;
            component = action;

            // Combat: the target is the enemy (or the dungeon); the area says where that enemy is fought, and
            // the level shown to guild mates is the overall combat level.
            string area = "";
            if (entity is CombatEntity combat)
            {
                level = CombatAccess.Level(combat);
                string? current = combat.Areas.CurrentArea?.Area.Id;
                if (current != null && current != target.Id) area = current;
            }
            return new ActivityInfo(entity.Id, target.Id, Clip(skill + ": " + target.DisplayName.Message, 60), Clip(skill, 40), level, area);
        }
        return null;
    }

    private static string Clip(string text, int max) => text.Length <= max ? text : text.Substring(0, max);
}
