using GamesByMalcs.Melvor2.GameMenus;
using Godot;

namespace Melvor2.Chat;

/// <summary>
/// Borrows the look of the game's own Mastery Guild window from the live scene tree: panel styles, the title
/// plaque and the red close button. The game's scene files are packed, so this is the only way to match it
/// exactly. Every lookup has a plain fallback, so a game update that moves things degrades the look, not the mod.
/// Paths come from tools' UI probe (see UiProbe.cs).
/// </summary>
internal sealed class NativeStyle
{
    private const string ViewPath = "HBoxContainer/MasteryGuildView";
    private const string SectionPath = ViewPath + "/MarginContainer/MainContainer/CategorySelect";

    private readonly Node? _view;
    private readonly Node? _section;

    public StyleBox? Backdrop { get; }
    public StyleBox? WindowFrame { get; }
    public StyleBox? SectionFrame { get; }

    public NativeStyle(GameView gameView)
    {
        Control popup = gameView.MasteryGuild;
        _view = popup.GetNodeOrNull(ViewPath);
        _section = popup.GetNodeOrNull(SectionPath);

        Backdrop = PanelStyle(popup);
        WindowFrame = PanelStyle(_view?.GetNodeOrNull("MarginContainer"));
        SectionFrame = PanelStyle(_section?.GetNodeOrNull("MarginContainer/PanelContainer"));
    }

    /// <summary>The large plaque that sits on the window's top edge.</summary>
    public Control MakeWindowTitle(string text) => MakePlaque(_view?.GetNodeOrNull("Control3"), text);

    /// <summary>The smaller plaque on top of an inner section.</summary>
    public Control MakeSectionTitle(string text) => MakePlaque(_section?.GetNodeOrNull("MarginContainer/Control3"), text);

    /// <summary>The red X in the window's top-right corner.</summary>
    public Control MakeCloseButton(Action onPressed)
    {
        Control holder;
        Button? button = null;
        if (_view?.GetNodeOrNull("Control2") is Control original)
        {
            holder = (Control)original.Duplicate();
            button = FindFirst<Button>(holder);
            RebindSound(holder, button);
        }
        else
        {
            holder = new Control { SizeFlagsVertical = Control.SizeFlags.ShrinkBegin };
        }

        if (button == null)
        {
            button = new Button
            {
                Text = "X",
                ThemeTypeVariation = "TexturedButtonCancel2x",
                CustomMinimumSize = new Vector2(32, 32),
                MouseDefaultCursorShape = Control.CursorShape.PointingHand,
            };
            button.AnchorLeft = button.AnchorRight = 1;
            button.OffsetLeft = -40;
            button.OffsetRight = -8;
            button.OffsetTop = -16;
            button.OffsetBottom = 16;
            holder.AddChild(button);
        }
        button.Pressed += onPressed;
        return holder;
    }

    /// <summary>A framed section with a plaque title, laid out like the game's "Task Categories" box.</summary>
    public Control MakeSection(string title, Control content)
    {
        var outer = new PanelContainer();
        outer.AddThemeStyleboxOverride("panel", new StyleBoxEmpty());

        var margin = new MarginContainer();
        margin.AddThemeConstantOverride("margin_top", 16);
        var frame = new PanelContainer();
        if (SectionFrame != null) frame.AddThemeStyleboxOverride("panel", SectionFrame);
        frame.AddChild(content);
        margin.AddChild(frame);
        // In the game's scene the plaque sits inside the margin container, beside the frame, so it
        // straddles the frame's top edge.
        margin.AddChild(MakeSectionTitle(title));

        outer.AddChild(margin);
        return outer;
    }

    /// <summary>Points a duplicated button's click-sound player at the copy instead of the original.</summary>
    public static void RebindSound(Node root, GodotObject? button)
    {
        if (button == null) return;
        foreach (Node node in Descendants(root))
        {
            if (node is not AudioStreamPlayer || node.GetType().Name != "ButtonAudioPlayer") continue;
            node.Set(button is BaseButton ? "Button" : "ButtonContainer", Variant.From(button));
        }
    }

    public static T? FindFirst<T>(Node root) where T : Node
    {
        foreach (Node node in Descendants(root))
        {
            if (node is T match) return match;
        }
        return null;
    }

    private static IEnumerable<Node> Descendants(Node root)
    {
        foreach (Node child in root.GetChildren())
        {
            yield return child;
            foreach (Node deeper in Descendants(child)) yield return deeper;
        }
    }

    private static Control MakePlaque(Node? original, string text)
    {
        if (original is Control source)
        {
            var copy = (Control)source.Duplicate();
            Label? label = FindFirst<Label>(copy);
            if (label != null)
            {
                label.AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled;
                label.Text = text;
                return copy;
            }
            copy.Free();
        }

        // Fallback: a plain centred label on the top edge.
        var holder = new Control { SizeFlagsVertical = Control.SizeFlags.ShrinkBegin, MouseFilter = Control.MouseFilterEnum.Ignore };
        var plain = new Label { Text = text, HorizontalAlignment = HorizontalAlignment.Center };
        plain.AnchorLeft = plain.AnchorRight = 0.5f;
        plain.OffsetLeft = -150;
        plain.OffsetRight = 150;
        plain.OffsetTop = -12;
        holder.AddChild(plain);
        return holder;
    }

    private static StyleBox? PanelStyle(Node? node) =>
        node is Control control && control.HasThemeStyleboxOverride("panel") ? control.GetThemeStylebox("panel") : null;
}
