using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.GameMenus;
using Godot;

namespace Melvor2.Chat;

/// <summary>Finds the game's own UI nodes in the live scene tree.</summary>
internal static class GameUi
{
    private static Main? s_main;

    /// <summary>The game's root script node. It lives for the whole session.</summary>
    public static Main? FindMain(SceneTree tree)
    {
        if (s_main != null && GodotObject.IsInstanceValid(s_main)) return s_main;
        s_main = Find<Main>(tree.Root, 3);
        return s_main;
    }

    /// <summary>
    /// The in-game view (header, footer, popups). It only exists while a save is loaded; returns null on the
    /// main menu and loading screens. Main keeps the active view under its exported ApplicationViewContainer.
    /// </summary>
    public static GameView? FindGameView(SceneTree tree)
    {
        Main? main = FindMain(tree);
        if (main == null) return null;

        Node? container = main.Get("ApplicationViewContainer").As<Node>();
        if (container == null || !GodotObject.IsInstanceValid(container)) return null;
        foreach (Node child in container.GetChildren())
        {
            if (child is GameView view && view.IsInsideTree() && !view.IsQueuedForDeletion()) return view;
        }
        return null;
    }

    private static T? Find<T>(Node node, int depth) where T : Node
    {
        if (node is T match) return match;
        if (depth == 0) return null;
        foreach (Node child in node.GetChildren())
        {
            T? found = Find<T>(child, depth - 1);
            if (found != null) return found;
        }
        return null;
    }
}
