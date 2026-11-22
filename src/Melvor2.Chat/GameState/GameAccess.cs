using System.Reflection;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Entities;
using GamesByMalcs.Melvor2.Entities.Agility;
using GamesByMalcs.Melvor2.Entities.Hunting;
using GamesByMalcs.Melvor2.Entities.Thieving;
using GamesByMalcs.Melvor2.Modifiers;
using Godot;

namespace Melvor2.Chat.GameState;

/// <summary>
/// Reaches the running game's model (the Game object) and says when it is safe to touch.
/// The game ticks on the main thread in normal play, but runs catch-up and offline progress on a background
/// thread with the scene tree paused. Mod code must only read or change game state from the main thread while
/// the tree is not paused.
/// </summary>
internal static class GameAccess
{
    /// <summary>The loaded game, or null on menus, while loading, or while offline progress is running.</summary>
    public static Game? Current(SceneTree tree)
    {
        if (tree.Paused) return null;
        Main? main = GameUi.FindMain(tree);
        if (main?.State is not IGameState state) return null;
        Game game = state.Game;
        if (game == null || !game.IsSaveLoaded || game.Flags.IsOffline) return null;
        return game;
    }

    /// <summary>
    /// The game's modifier system. Game keeps it private, but several skill components expose the same
    /// instance publicly; reflection is the fallback if those move.
    /// </summary>
    public static ModifierSystem? Modifiers(Game game)
    {
        foreach (GameEntity entity in game.Entities.GetAllObjects())
        {
            switch (entity)
            {
                case ThievingEntity thieving:
                    return thieving.Action.Modifiers;
                case AgilityEntity agility:
                    return agility.Action.Modifiers;
                case HuntingEntity hunting:
                    return hunting.Action.Modifiers;
            }
        }

        PropertyInfo? property = typeof(Game).GetProperty("Modifiers", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        return property?.GetValue(game) as ModifierSystem;
    }
}
