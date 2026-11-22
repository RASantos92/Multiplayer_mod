using System.Collections;
using System.Reflection;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Actions;
using GamesByMalcs.Melvor2.Components.CombatAreas;
using GamesByMalcs.Melvor2.Components.Experience;
using GamesByMalcs.Melvor2.Conditions;
using GamesByMalcs.Melvor2.Data;
using GamesByMalcs.Melvor2.Entities;
using GamesByMalcs.Melvor2.Entities.Combat;
using GamesByMalcs.Melvor2.Entities.Fishing;
using GamesByMalcs.Melvor2.Entities.Mining;
using GamesByMalcs.Melvor2.Entities.Thieving;
using GamesByMalcs.Melvor2.Entities.Woodcutting;

namespace Melvor2.Chat.GameState;

internal enum JoinState
{
    /// <summary>Can be started now.</summary>
    Ready,

    /// <summary>The local player is already doing exactly this.</summary>
    Already,

    /// <summary>Requirements are not met; Reason says what is missing.</summary>
    Locked,

    /// <summary>The mod cannot start this kind of activity (yet).</summary>
    Unsupported,

    /// <summary>The ids do not exist in this game version.</summary>
    Unknown,
}

internal readonly record struct JoinCheck(JoinState State, string Reason);

/// <summary>
/// Starts, on the local character, the same action a guild mate is doing. Uses the game's own public start
/// methods. Those toggle (asking for the action you are already doing stops it) and most skip the level locks
/// that the game's UI enforces, so every start goes through Check() first.
/// Main thread only, and only while GameAccess.Current() returns a game.
/// </summary>
internal static class ActionJoiner
{
    /// <param name="areaId">For combat: the area the enemy is fought in, when the other player sent one.</param>
    public static JoinCheck Check(Game game, string entityId, string targetId, string areaId = "") =>
        Resolve(game, entityId, targetId, areaId, out _);

    public static JoinCheck Join(Game game, string entityId, string targetId, string areaId = "")
    {
        JoinCheck check = Resolve(game, entityId, targetId, areaId, out Action? start);
        if (check.State != JoinState.Ready || start == null) return check;
        try
        {
            start();
            return check;
        }
        catch (Exception e)
        {
            ModEntry.Log("Join failed for " + entityId + " / " + targetId + ": " + e);
            return new JoinCheck(JoinState.Unsupported, "The game refused to start this action.");
        }
    }

    private static JoinCheck Resolve(Game game, string entityId, string targetId, string areaId, out Action? start)
    {
        start = null;
        if (!game.Entities.TryGetObjectById(entityId, out GameEntity? entity) || entity == null)
        {
            return new JoinCheck(JoinState.Unknown, "Your game does not have this activity.");
        }

        ActionComponent? active = game.ActionManager.ActiveActions.FirstOrDefault(a => a.IsStarted);
        if (active != null && active.Entity.Id == entityId && active.CurrentDescription?.Id == targetId)
        {
            return new JoinCheck(JoinState.Already, "You are already doing this.");
        }

        switch (entity)
        {
            case CombatEntity combat:
                return ResolveCombat(combat, targetId, areaId, out start);
            case FishingEntity fishing:
            {
                var pair = Find(fishing.Action.Recipes, targetId);
                if (pair == null) return Missing();
                var (recipe, activeRecipe) = pair.Value;
                JoinCheck locked = Requirements(recipe, recipe.Location);
                if (locked.State != JoinState.Ready) return locked;
                start = () => fishing.Action.SelectRecipe(activeRecipe);
                return Ok();
            }
            case WoodcuttingEntity woodcutting:
            {
                var pair = Find(woodcutting.Action.Trees, targetId);
                if (pair == null) return Missing();
                var (recipe, tree) = pair.Value;
                JoinCheck locked = Requirements(recipe, null);
                if (locked.State != JoinState.Ready) return locked;
                start = () => woodcutting.Action.SelectTree(tree);
                return Ok();
            }
            case MiningEntity mining:
            {
                var pair = Find(mining.Action.Rocks, targetId);
                if (pair == null) return Missing();
                var (recipe, rock) = pair.Value;
                JoinCheck locked = Requirements(recipe, null);
                if (locked.State != JoinState.Ready) return locked;
                start = () => mining.Action.SelectRock(rock);
                return Ok();
            }
            case ThievingEntity thieving:
            {
                var pair = Find(thieving.Action.ActiveRecipes, targetId);
                if (pair == null) return Missing();
                var (recipe, activeRecipe) = pair.Value;
                JoinCheck locked = Requirements(recipe, null);
                if (locked.State != JoinState.Ready) return locked;
                if (!thieving.Action.CanThieveRecipe(activeRecipe)) return new JoinCheck(JoinState.Locked, "You cannot pickpocket this target yet.");
                start = () => thieving.Action.TryStartActiveRecipe(activeRecipe);
                return Ok();
            }
        }

        return ResolveCrafting(entity, targetId, out start);
    }

    /// <summary>
    /// Combat: the target is a dungeon, or an enemy inside a normal area. Selecting either starts the fight
    /// (and swaps straight to it when already fighting something else). The game's select methods check
    /// nothing, so the area's and the enemy's own unlock rules are checked here, as the game's menu does.
    /// </summary>
    private static JoinCheck ResolveCombat(CombatEntity combat, string targetId, string areaId, out Action? start)
    {
        start = null;
        CombatAreasComponent areas = combat.Areas;

        foreach (BaseCombatArea area in areas.ActiveAreas.Keys)
        {
            if (area is not Dungeon dungeon || dungeon.Id != targetId) continue;
            JoinCheck locked = Unlocked(dungeon.UnlockRequirements, dungeon.DisplayRequirements);
            if (locked.State != JoinState.Ready) return locked;
            start = () => areas.SelectDungeon(dungeon);
            return Ok();
        }

        // Prefer the area the other player is in; an enemy can appear in more than one.
        foreach (bool exactArea in new[] { true, false })
        {
            foreach (BaseCombatArea area in areas.ActiveAreas.Keys)
            {
                if (area is not CombatArea normal || exactArea != (normal.Id == areaId)) continue;
                Enemy? enemy = normal.Enemies.FirstOrDefault(e => e.Id == targetId);
                if (enemy == null) continue;

                JoinCheck locked = Unlocked(normal.UnlockRequirements, normal.DisplayRequirements, enemy.Requirements, enemy.DisplayRequirements);
                if (locked.State != JoinState.Ready)
                {
                    if (exactArea) return locked;
                    continue;
                }
                start = () => areas.SelectEnemy(normal, enemy);
                return Ok();
            }
        }

        bool exists = areas.ActiveAreas.Keys.OfType<CombatArea>().Any(a => a.Enemies.Any(e => e.Id == targetId));
        return exists ? new JoinCheck(JoinState.Locked, "You have not unlocked this enemy yet.") : Missing();
    }

    /// <summary>
    /// Cooking, Firemaking, Herblore, Smithing and the other artisan skills share one generic base class
    /// (CraftingActionComponent&lt;TRecipe, TActiveRecipe&gt;), so they are driven by reflection over its public
    /// members: ActiveRecipes, SelectRecipe, CanCreateRecipe and StartCreating.
    /// </summary>
    private static JoinCheck ResolveCrafting(GameEntity entity, string targetId, out Action? start)
    {
        start = null;
        const BindingFlags Public = BindingFlags.Instance | BindingFlags.Public;

        object? action = entity.GetType().GetProperty("Action", Public)?.GetValue(entity);
        if (action == null || !IsCraftingComponent(action.GetType()))
        {
            return new JoinCheck(JoinState.Unsupported, "Joining this kind of activity is not supported yet. Start it yourself to share the bonus.");
        }

        Type type = action.GetType();
        if (type.GetProperty("ActiveRecipes", Public)?.GetValue(action) is not IDictionary recipes) return Missing();

        object? recipe = null;
        object? activeRecipe = null;
        foreach (DictionaryEntry entry in recipes)
        {
            if (entry.Key is INamespacedObject named && named.Id == targetId)
            {
                recipe = entry.Key;
                activeRecipe = entry.Value;
                break;
            }
        }
        if (recipe == null || activeRecipe == null) return Missing();

        JoinCheck locked = Requirements(recipe, null);
        if (locked.State != JoinState.Ready) return locked;

        MethodInfo? select = type.GetMethod("SelectRecipe", Public, new[] { activeRecipe.GetType() }) ?? FindMethod(type, "SelectRecipe");
        MethodInfo? canCreate = FindMethod(type, "CanCreateRecipe");
        MethodInfo? startCreating = type.GetMethod("StartCreating", Public, Type.EmptyTypes);
        if (select == null || startCreating == null) return new JoinCheck(JoinState.Unsupported, "Joining this skill is not supported in this game version.");

        if (canCreate != null && canCreate.Invoke(action, new[] { activeRecipe }) is false)
        {
            return new JoinCheck(JoinState.Locked, "You do not have the materials for this.");
        }

        object selectedAction = action;
        object selectedRecipe = activeRecipe;
        start = () =>
        {
            select.Invoke(selectedAction, new[] { selectedRecipe });
            // StartCreating toggles: only press it if selecting did not already start the action.
            if (selectedAction is ActionComponent component && !component.IsStarted) startCreating.Invoke(selectedAction, null);
        };
        return Ok();
    }

    private static bool IsCraftingComponent(Type? type)
    {
        for (; type != null; type = type.BaseType)
        {
            if (type.IsGenericType && type.GetGenericTypeDefinition().Name.StartsWith("CraftingActionComponent")) return true;
        }
        return false;
    }

    private static MethodInfo? FindMethod(Type type, string name) =>
        type.GetMethods(BindingFlags.Instance | BindingFlags.Public).FirstOrDefault(m => m.Name == name && m.GetParameters().Length == 1);

    private static (TKey Key, TValue Value)? Find<TKey, TValue>(IReadOnlyDictionary<TKey, TValue> map, string id)
        where TKey : notnull, INamespacedObject
    {
        foreach (KeyValuePair<TKey, TValue> pair in map)
        {
            if (pair.Key.Id == id) return (pair.Key, pair.Value);
        }
        return null;
    }

    /// <summary>
    /// The game's own unlock rules for a recipe and, where there is one, the place it belongs to. Read through
    /// the conventional property names (Requirements, DisplayRequirements) so every recipe type is covered.
    /// </summary>
    private static JoinCheck Requirements(object recipe, object? location)
    {
        foreach (object? holder in new[] { recipe, location })
        {
            if (holder == null) continue;
            foreach (string property in new[] { "Requirements", "DisplayRequirements" })
            {
                if (holder.GetType().GetProperty(property, BindingFlags.Instance | BindingFlags.Public)?.GetValue(holder) is not ConditionGroup group) continue;
                JoinCheck locked = Unlocked(group);
                if (locked.State != JoinState.Ready) return locked;
            }
        }
        return Ok();
    }

    /// <summary>Ready when every group is met; otherwise Locked, naming the missing level where there is one.</summary>
    private static JoinCheck Unlocked(params ConditionGroup?[] groups)
    {
        foreach (ConditionGroup? group in groups)
        {
            if (group == null || group.AreMet) continue;
            foreach (Condition condition in group.Conditions)
            {
                if (condition.IsMet) continue;
                if (condition is LevelCondition level)
                {
                    string skill = level.Component?.Entity?.DisplayName.Text ?? "skill";
                    return new JoinCheck(JoinState.Locked, "Requires " + skill + " level " + level.Level + ".");
                }
            }
            return new JoinCheck(JoinState.Locked, "You have not unlocked this yet.");
        }
        return Ok();
    }

    private static JoinCheck Ok() => new(JoinState.Ready, "");

    private static JoinCheck Missing() => new(JoinState.Unknown, "Your game does not have this action.");
}
