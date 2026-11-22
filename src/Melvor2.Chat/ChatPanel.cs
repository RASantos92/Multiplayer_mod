using Godot;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat;

/// <summary>
/// Chat window built from stock Godot controls on its own CanvasLayer, so it floats over the game UI.
/// Opened by the footer chat icon (added by GameUiHook while a save is loaded) or F8 anywhere.
/// Channels: "Friends" (an invite-only Steam lobby) plus one per guild the player is in (via the guild server).
/// </summary>
internal sealed class ChatPanel
{
    private const int MaxLines = 400;

    private readonly MarginContainer _panel;
    private readonly PanelContainer _plainFrame;
    private readonly VBoxContainer _content;
    private readonly OptionButton _channels;
    private readonly HBoxContainer _friendsBar;
    private readonly Label _status;
    private readonly RichTextLabel _log;
    private readonly LineEdit _input;
    private readonly Button _host;
    private readonly Button _invite;
    private readonly Button _copyId;
    private readonly Button _leave;

    private readonly List<string> _friendLines = new();
    private readonly List<string?> _channelIds = new() { null };
    private SteamLobbyService? _lobby;
    private GuildService? _guilds;
    private string? _channel; // null = Friends, otherwise a guild id
    private bool _styled;

    /// <summary>Messages received while the window was closed or on another channel.</summary>
    public int Unread { get; private set; }

    public bool IsOpen => _panel.Visible;

    /// <summary>True while a guild channel is on screen, so the guild server is polled quickly.</summary>
    public bool ShowingGuildChannel => _panel.Visible && _channel != null;

    public event Action? UnreadChanged;

    public ChatPanel(Node root)
    {
        var layer = new CanvasLayer { Name = "Melvor2ChatLayer", Layer = 90 };

        // Bottom-right, just above the game's footer bar.
        _panel = new MarginContainer { Visible = false };
        _panel.AnchorLeft = _panel.AnchorTop = _panel.AnchorRight = _panel.AnchorBottom = 1;
        _panel.OffsetLeft = -470;
        _panel.OffsetTop = -490;
        _panel.OffsetRight = -8;
        _panel.OffsetBottom = -50;

        _content = new VBoxContainer();
        _content.AddThemeConstantOverride("separation", 6);

        _channels = new OptionButton { FocusMode = Control.FocusModeEnum.None, Visible = false, AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled };
        _channels.AddItem("Friends");
        _channels.ItemSelected += index => SwitchChannel(_channelIds[(int)index]);

        _friendsBar = new HBoxContainer();
        _friendsBar.AddThemeConstantOverride("separation", 4);
        _host = MakeButton("Host", "Create a friends-only chat", "TexturedActionButtonGreen8x");
        _invite = MakeButton("Invite", "Invite Steam friends", "TexturedButton8x");
        _copyId = MakeButton("Copy ID", "Copy the chat ID so a friend can type /join <id>", "TexturedButton8x");
        _leave = MakeButton("Leave", "Leave the chat", "TexturedButtonCancel8x");
        _friendsBar.AddChild(_host);
        _friendsBar.AddChild(_invite);
        _friendsBar.AddChild(_copyId);
        _friendsBar.AddChild(new Control { SizeFlagsHorizontal = Control.SizeFlags.ExpandFill });
        _friendsBar.AddChild(_leave);

        _status = new Label { Text = "Not connected", AutowrapMode = TextServer.AutowrapMode.WordSmart, AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled };

        _log = new RichTextLabel
        {
            BbcodeEnabled = false, // Text from other players is never parsed as markup.
            ScrollFollowing = true,
            SelectionEnabled = true,
            SizeFlagsVertical = Control.SizeFlags.ExpandFill,
            CustomMinimumSize = new Vector2(0, 200),
            AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled,
        };

        _input = new LineEdit { PlaceholderText = "Type a message, or /join <id>", MaxLength = 300, Editable = false };
        _input.TextSubmitted += OnSubmitted;

        _content.AddChild(_channels);
        _content.AddChild(_friendsBar);
        _content.AddChild(_status);
        _content.AddChild(_log);
        _content.AddChild(_input);

        // Plain frame until a save is loaded and the game's own panel style can be borrowed.
        _plainFrame = new PanelContainer();
        var margin = new MarginContainer();
        foreach (string side in new[] { "margin_left", "margin_top", "margin_right", "margin_bottom" })
        {
            margin.AddThemeConstantOverride(side, 8);
        }
        margin.AddChild(_content);
        _plainFrame.AddChild(margin);
        _panel.AddChild(_plainFrame);
        layer.AddChild(_panel);

        // The game's Main node is still being constructed when the mod loads, so add on the next idle step.
        root.CallDeferred(Node.MethodName.AddChild, layer);
        Refresh();
    }

    /// <summary>Swaps the plain frame for the game's framed-section look with a title plaque. Done once.</summary>
    public void ApplyGameStyle(NativeStyle style)
    {
        if (_styled || style.SectionFrame == null) return;
        _styled = true;

        _content.GetParent().RemoveChild(_content);
        _panel.RemoveChild(_plainFrame);
        _plainFrame.QueueFree();
        _panel.AddChild(style.MakeSection("Chat", _content));
    }

    public void Bind(SteamLobbyService lobby)
    {
        _lobby = lobby;
        lobby.SystemMessage += AddSystemLine;
        lobby.ChatMessage += (name, text) => AddFriendLine(name + ": " + text, countUnread: true);
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

        AddSystemLine("Steam ready. Press Host to start a chat, or accept a friend's invite.");
        Refresh();
    }

    public void BindGuilds(GuildService guilds)
    {
        _guilds = guilds;
        guilds.Changed += RebuildChannels;
        guilds.MessageReceived += OnGuildMessage;
        RebuildChannels();
    }

    public void Toggle()
    {
        _panel.Visible = !_panel.Visible;
        if (_panel.Visible)
        {
            SetUnread(0);
            _input.GrabFocus();
        }
        else
        {
            _input.ReleaseFocus();
        }
    }

    public void AddSystemLine(string text) => AddFriendLine("* " + text, countUnread: false);

    // ---- Channels ----

    private void RebuildChannels()
    {
        if (_guilds == null) return;
        _channelIds.Clear();
        _channelIds.Add(null);
        _channels.Clear();
        _channels.AddItem("Friends");
        foreach (GuildInfo guild in _guilds.Guilds)
        {
            _channelIds.Add(guild.Id);
            _channels.AddItem("Guild: " + guild.Name);
        }
        _channels.Visible = _channelIds.Count > 1;

        int index = _channelIds.IndexOf(_channel);
        if (index < 0)
        {
            // The guild we were looking at is gone (left, kicked or disbanded).
            SwitchChannel(null);
            index = 0;
        }
        _channels.Select(index);
        Refresh();
    }

    private void SwitchChannel(string? channel)
    {
        _channel = channel;
        _log.Clear();
        if (channel == null)
        {
            foreach (string line in _friendLines) _log.AddText(line + "\n");
        }
        else if (_guilds != null && _guilds.Lines.TryGetValue(channel, out List<ChatLine>? lines))
        {
            foreach (ChatLine line in lines) _log.AddText(Format(line) + "\n");
        }
        Refresh();
    }

    private void OnGuildMessage(ChatLine line)
    {
        if (_channel == line.GuildId) _log.AddText(Format(line) + "\n");

        // History loaded on login and my own messages are not "new".
        bool recent = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - line.At < 30_000;
        bool mine = _guilds != null && line.PlayerId == _guilds.SteamId;
        if (recent && !mine && !(_panel.Visible && _channel == line.GuildId)) SetUnread(Unread + 1);
    }

    private static string Format(ChatLine line)
    {
        DateTime local = DateTimeOffset.FromUnixTimeMilliseconds(line.At).LocalDateTime;
        string stamp = local.Date == DateTime.Today ? local.ToString("HH:mm") : local.ToString("MMM d HH:mm");
        return "[" + stamp + "] " + line.Name + ": " + line.Body;
    }

    private void AddFriendLine(string line, bool countUnread)
    {
        string stamped = "[" + DateTime.Now.ToString("HH:mm") + "] " + line;
        _friendLines.Add(stamped);
        if (_friendLines.Count > MaxLines) _friendLines.RemoveAt(0);
        if (_channel == null) _log.AddText(stamped + "\n");

        if (countUnread && !(_panel.Visible && _channel == null)) SetUnread(Unread + 1);
    }

    private void SetUnread(int value)
    {
        if (Unread == value) return;
        Unread = value;
        UnreadChanged?.Invoke();
    }

    private void OnSubmitted(string text)
    {
        _input.Clear();
        text = text.Trim();
        if (text.Length == 0) return;

        if (_channel != null)
        {
            _guilds?.SendMessage(_channel, text);
            return;
        }

        if (_lobby == null) return;
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
        bool friends = _channel == null;
        _friendsBar.Visible = friends;
        _input.PlaceholderText = friends ? "Type a message, or /join <id>" : "Message your guild";

        if (!friends)
        {
            _input.Editable = true;
            GuildInfo? guild = _guilds?.Find(_channel);
            int online = 0;
            int total = 0;
            if (_guilds != null && guild != null && _guilds.Members.TryGetValue(guild.Id, out List<MemberInfo>? members))
            {
                total = members.Count;
                online = members.Count(m => _guilds.ServerNow - m.LastSeen < GuildService.OnlineWindowMs);
            }
            _status.Text = guild == null ? "" : guild.Name + ": " + online + " of " + total + " online";
            return;
        }

        bool ready = _lobby != null;
        bool inLobby = ready && _lobby!.InLobby;
        _input.Editable = ready;
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

    private static Button MakeButton(string text, string tooltip, string variation) => new()
    {
        Text = text,
        TooltipText = tooltip,
        ThemeTypeVariation = variation,
        FocusMode = Control.FocusModeEnum.None,
        MouseDefaultCursorShape = Control.CursorShape.PointingHand,
    };
}
