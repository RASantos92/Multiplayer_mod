using Godot;

namespace Melvor2.Chat;

/// <summary>
/// Chat window built from stock Godot controls on its own CanvasLayer, so it floats over the game UI
/// and picks up the game's theme. Toggle with the "Chat" button (bottom right) or F8.
/// </summary>
internal sealed class ChatPanel
{
    private const int MaxLines = 400;

    private readonly Button _toggle;
    private readonly PanelContainer _panel;
    private readonly Label _status;
    private readonly RichTextLabel _log;
    private readonly LineEdit _input;
    private readonly Button _host;
    private readonly Button _invite;
    private readonly Button _copyId;
    private readonly Button _leave;

    private SteamLobbyService? _lobby;
    private int _lines;
    private int _unread;

    public ChatPanel(Node root)
    {
        var layer = new CanvasLayer { Name = "Melvor2ChatLayer", Layer = 90 };

        _toggle = new Button { Text = "Chat", FocusMode = Control.FocusModeEnum.None, TooltipText = "Friends chat (F8)" };
        AnchorBottomRight(_toggle, left: -110, top: -46, right: -10, bottom: -10);
        _toggle.Pressed += Toggle;

        _panel = new PanelContainer { Visible = false };
        AnchorBottomRight(_panel, left: -450, top: -440, right: -10, bottom: -52);

        var margin = new MarginContainer();
        foreach (string side in new[] { "margin_left", "margin_top", "margin_right", "margin_bottom" })
        {
            margin.AddThemeConstantOverride(side, 8);
        }

        var box = new VBoxContainer();

        var header = new HBoxContainer();
        header.AddChild(new Label { Text = "Friends chat", SizeFlagsHorizontal = Control.SizeFlags.ExpandFill });
        _host = MakeButton("Host", "Create a friends-only chat");
        _invite = MakeButton("Invite", "Invite Steam friends");
        _copyId = MakeButton("Copy ID", "Copy the chat ID so a friend can type /join <id>");
        _leave = MakeButton("Leave", "Leave the chat");
        header.AddChild(_host);
        header.AddChild(_invite);
        header.AddChild(_copyId);
        header.AddChild(_leave);

        _status = new Label { Text = "Not connected", AutowrapMode = TextServer.AutowrapMode.WordSmart };

        _log = new RichTextLabel
        {
            BbcodeEnabled = false, // Text from other players is never parsed as markup.
            ScrollFollowing = true,
            SelectionEnabled = true,
            SizeFlagsVertical = Control.SizeFlags.ExpandFill,
            CustomMinimumSize = new Vector2(0, 200),
        };

        _input = new LineEdit { PlaceholderText = "Type a message, or /join <id>", MaxLength = 300, Editable = false };
        _input.TextSubmitted += OnSubmitted;

        box.AddChild(header);
        box.AddChild(_status);
        box.AddChild(_log);
        box.AddChild(_input);
        margin.AddChild(box);
        _panel.AddChild(margin);
        layer.AddChild(_panel);
        layer.AddChild(_toggle);

        // The game's Main node is still being constructed when the mod loads, so add on the next idle step.
        root.CallDeferred(Node.MethodName.AddChild, layer);
        Refresh();
    }

    public void Bind(SteamLobbyService lobby)
    {
        _lobby = lobby;
        lobby.SystemMessage += AddSystemLine;
        lobby.ChatMessage += AddChatLine;
        lobby.StateChanged += Refresh;

        _host.Pressed += lobby.Host;
        _invite.Pressed += lobby.Invite;
        _leave.Pressed += lobby.Leave;
        _copyId.Pressed += () =>
        {
            if (!lobby.InLobby) return;
            DisplayServer.ClipboardSet(lobby.LobbyId.ToString());
            AddSystemLine("Chat ID copied. Your friend types: /join " + lobby.LobbyId);
        };

        _input.Editable = true;
        AddSystemLine("Steam ready. Press Host to start a chat, or accept a friend's invite.");
        Refresh();
    }

    public void Toggle()
    {
        _panel.Visible = !_panel.Visible;
        if (_panel.Visible)
        {
            _unread = 0;
            _input.GrabFocus();
        }
        else
        {
            _input.ReleaseFocus();
        }
        UpdateToggleText();
    }

    public void AddSystemLine(string text) => AddLine("* " + text, countUnread: false);

    private void AddChatLine(string name, string text) => AddLine(name + ": " + text, countUnread: true);

    private void AddLine(string line, bool countUnread)
    {
        if (_lines >= MaxLines)
        {
            _log.Clear();
            _lines = 0;
            _log.AddText("* Older messages cleared.\n");
        }
        _log.AddText("[" + DateTime.Now.ToString("HH:mm") + "] " + line + "\n");
        _lines++;

        if (countUnread && !_panel.Visible)
        {
            _unread++;
            UpdateToggleText();
        }
    }

    private void OnSubmitted(string text)
    {
        _input.Clear();
        text = text.Trim();
        if (text.Length == 0 || _lobby == null) return;

        if (text.StartsWith("/join ", StringComparison.OrdinalIgnoreCase))
        {
            if (ulong.TryParse(text.AsSpan(6).Trim(), out ulong id)) _lobby.Join(id);
            else AddSystemLine("Usage: /join <chat id>");
            return;
        }
        if (text.StartsWith('/'))
        {
            AddSystemLine("Unknown command. Available: /join <chat id>");
            return;
        }
        _lobby.SendChat(text);
    }

    private void Refresh()
    {
        bool ready = _lobby != null;
        bool inLobby = ready && _lobby!.InLobby;
        _host.Disabled = !ready || inLobby;
        _invite.Disabled = !inLobby;
        _copyId.Disabled = !inLobby;
        _leave.Disabled = !inLobby;

        if (!ready) _status.Text = "Waiting for Steam...";
        else if (!inLobby) _status.Text = "Not in a chat";
        else
        {
            IReadOnlyList<string> names = _lobby!.GetMemberNames();
            _status.Text = "In chat (" + names.Count + "): " + string.Join(", ", names);
        }
    }

    private void UpdateToggleText() => _toggle.Text = _unread > 0 ? "Chat (" + _unread + ")" : "Chat";

    private static Button MakeButton(string text, string tooltip) =>
        new() { Text = text, TooltipText = tooltip, FocusMode = Control.FocusModeEnum.None };

    private static void AnchorBottomRight(Control control, float left, float top, float right, float bottom)
    {
        control.AnchorLeft = 1;
        control.AnchorTop = 1;
        control.AnchorRight = 1;
        control.AnchorBottom = 1;
        control.OffsetLeft = left;
        control.OffsetTop = top;
        control.OffsetRight = right;
        control.OffsetBottom = bottom;
    }
}
