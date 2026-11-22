using GamesByMalcs.Melvor2.CustomControls;
using GamesByMalcs.Melvor2.GameMenus;
using Godot;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat;

/// <summary>
/// Adds the mod's buttons to the game's own bars while a save is loaded: a chat icon in the footer next to
/// the music icon, and a Guild button in the header next to Guide. The game rebuilds its UI every time a save
/// is loaded, so this re-injects whenever it sees a new game view.
/// </summary>
internal sealed class GameUiHook
{
    private readonly SceneTree _tree;
    private readonly ChatPanel _chat;
    private readonly GuildService _guilds;

    private ulong _viewId;
    private int _frames;
    private Button? _chatButton;
    private Control? _chatBadge;
    private Label? _chatBadgeLabel;
    private GuildWindow? _guild;
    private bool _escDown;

    public bool GuildWindowOpen => _guild is { IsOpen: true };

    public GameUiHook(SceneTree tree, ChatPanel chat, GuildService guilds)
    {
        _tree = tree;
        _chat = chat;
        _guilds = guilds;
        _chat.UnreadChanged += UpdateBadge;
    }

    public void Tick(double delta)
    {
        _guild?.Tick(delta);

        // Close the guild window on Esc, like the game's own popups.
        bool esc = Input.IsKeyPressed(Key.Escape);
        if (esc && !_escDown && _guild is { IsOpen: true }) _guild.Close();
        _escDown = esc;

        if (_frames++ % 30 != 0) return;

        GameView? view = GameUi.FindGameView(_tree);
        if (view == null)
        {
            _viewId = 0;
            _chatButton = null;
            _chatBadge = null;
            _chatBadgeLabel = null;
            _guild = null;
            return;
        }
        if (view.GetInstanceId() == _viewId) return;

        _viewId = view.GetInstanceId();
        Try("chat button", () => AddChatButton(view));
        NativeStyle? style = null;
        Try("native style", () => style = new NativeStyle(view));
        if (style != null)
        {
            Try("chat panel style", () => _chat.ApplyGameStyle(style));
            Try("guild window", () => _guild = new GuildWindow(view, style, _guilds));
            Try("guild button", () => AddGuildButton(view));
        }
        ModEntry.Log("Game UI hooked.");
    }

    private static void Try(string what, Action action)
    {
        try
        {
            action();
        }
        catch (Exception e)
        {
            // One failed piece must not take the others (or the game) down with it.
            ModEntry.Log("Could not add " + what + ": " + e);
        }
    }

    private void AddChatButton(GameView view)
    {
        Control music = view.Footer.Get("MusicButton").As<Control>();
        Node row = music.GetParent();

        Button button;
        try
        {
            button = new AnimatedButton();
        }
        catch (Exception)
        {
            button = new Button();
        }
        button.Name = "Melvor2ChatButton";
        button.ThemeTypeVariation = "TexturedButton8x";
        button.CustomMinimumSize = new Vector2(36, 36);
        button.SizeFlagsHorizontal = Control.SizeFlags.ShrinkCenter;
        button.SizeFlagsVertical = Control.SizeFlags.ShrinkCenter;
        button.MouseDefaultCursorShape = Control.CursorShape.PointingHand;
        button.FocusMode = Control.FocusModeEnum.None;
        button.Icon = Icons.Chat;
        button.IconAlignment = HorizontalAlignment.Center;
        button.ExpandIcon = true;
        button.TooltipText = "Chat (F8)";
        button.Pressed += _chat.Toggle;

        // Borrow the Event Log button's click sound and its little "New!" tag for the unread count.
        Node? eventLog = view.Footer.Get("EventLog").As<Node>();
        if (eventLog != null)
        {
            foreach (Node child in eventLog.GetChildren())
            {
                if (child is AudioStreamPlayer)
                {
                    Node sound = child.Duplicate();
                    sound.Set("Button", button);
                    button.AddChild(sound);
                }
                else if (child is Control tag && _chatBadge == null)
                {
                    _chatBadge = (Control)tag.Duplicate();
                    _chatBadgeLabel = NativeStyle.FindFirst<Label>(_chatBadge);
                    if (_chatBadgeLabel != null) _chatBadgeLabel.AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled;
                    foreach (Node n in _chatBadge.GetChildren())
                    {
                        if (n is CanvasItem item) item.Visible = true;
                    }
                    button.AddChild(_chatBadge);
                }
            }
        }

        row.AddChild(button);
        row.MoveChild(button, music.GetIndex() + 1);
        _chatButton = button;
        UpdateBadge();
    }

    private void UpdateBadge()
    {
        if (_chatBadge == null || !GodotObject.IsInstanceValid(_chatBadge)) return;
        _chatBadge.Visible = _chat.Unread > 0;
        if (_chatBadgeLabel != null) _chatBadgeLabel.Text = _chat.Unread > 99 ? "99+" : _chat.Unread.ToString();
    }

    private void AddGuildButton(GameView view)
    {
        Control guide = view.Header.Get("TutorialButton").As<Control>();
        Node row = guide.GetParent();

        var button = (Control)guide.Duplicate();
        button.Name = "Melvor2GuildButton";
        NativeStyle.RebindSound(button, button);

        TextureRect? icon = NativeStyle.FindFirst<TextureRect>(button);
        Texture2D? texture = Icons.Game("res://Assets/Icons/friends.png");
        if (icon != null && texture != null) icon.Texture = texture;

        Label? label = NativeStyle.FindFirst<Label>(button);
        if (label != null)
        {
            label.AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled;
            label.Text = "Guild";
        }

        if (button is BaseButtonContainer container)
        {
            container.Pressed += () => _guild?.Toggle();
        }
        else
        {
            throw new InvalidOperationException("Guide button is a " + button.GetType().Name + ", not a button container.");
        }

        row.AddChild(button);
        row.MoveChild(button, guide.GetIndex() + 1);
    }
}
