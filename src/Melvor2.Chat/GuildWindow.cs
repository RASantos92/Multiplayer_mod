using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Data.Items;
using GamesByMalcs.Melvor2.Entities;
using GamesByMalcs.Melvor2.GameMenus;
using GamesByMalcs.Melvor2.InfoIcons;
using GamesByMalcs.Melvor2.Localization;
using GamesByMalcs.Melvor2.UIServices;
using Godot;
using Melvor2.Chat.GameState;
using Melvor2.Chat.Guilds;
using Steamworks;

namespace Melvor2.Chat;

/// <summary>
/// The Guild window: a full-screen dimmed backdrop with a framed window in the middle, styled after the game's
/// Mastery Guild window. Left: your guilds, invites and actions. Right: the selected guild with a Members tab
/// (everyone), a Manage tab (owner and officers) and a Marketplace tab (GuildWindow.Market.cs), or the
/// create / find screens.
/// Lists are rebuilt from GuildService state whenever it changes.
/// </summary>
internal sealed partial class GuildWindow
{
    private enum Mode { Empty, Guild, Create, Find, Profile }

    private readonly GameView _gameView;
    private readonly GuildService _service;
    private readonly PanelContainer _backdrop;
    private readonly VBoxContainer _left;
    private readonly VBoxContainer _leftFooter;
    private readonly HBoxContainer _tabs;
    private readonly Button _membersButton;
    private readonly Button _manageButton;
    private readonly VBoxContainer _page;
    private readonly Label _status;

    private Mode _mode = Mode.Empty;
    private string? _guildId;
    private bool _manage;
    private bool _rebuildPending;
    private double _sinceDetail;
    private string _testerCode = "";

    // Text typed into forms survives list rebuilds.
    private string _createName = "";
    private string _createDescription = "";
    private string _query = "";
    private string _settingsName = "";
    private string _settingsDescription = "";
    private List<SearchHit>? _hits;

    // Profile page state.
    private MemberInfo? _profileMember;
    private ProfileData? _profile;
    private bool _profileLoading;

    public bool IsOpen => GodotObject.IsInstanceValid(_backdrop) && _backdrop.Visible;

    public GuildWindow(GameView gameView, NativeStyle style, GuildService service)
    {
        _gameView = gameView;
        _service = service;

        _backdrop = new PanelContainer
        {
            Name = "Melvor2GuildWindow",
            Visible = false,
            ZIndex = 3, // Same layer as the game's own popups, above the header and footer.
            MouseFilter = Control.MouseFilterEnum.Stop,
        };
        _backdrop.SetAnchorsPreset(Control.LayoutPreset.FullRect);
        if (style.Backdrop != null) _backdrop.AddThemeStyleboxOverride("panel", style.Backdrop);
        _backdrop.GuiInput += OnBackdropInput;

        var center = new CenterContainer();
        _backdrop.AddChild(center);

        // Same stacking the game uses: frame, then title plaque and close button overlapping its top edge.
        var window = new MarginContainer();
        var frame = new PanelContainer { CustomMinimumSize = new Vector2(1040, 660) };
        if (style.WindowFrame != null) frame.AddThemeStyleboxOverride("panel", style.WindowFrame);
        window.AddChild(frame);
        window.AddChild(style.MakeWindowTitle("Guilds"));
        window.AddChild(style.MakeCloseButton(Close));
        center.AddChild(window);

        var rows = new VBoxContainer();
        rows.AddThemeConstantOverride("separation", 6);
        frame.AddChild(rows);

        var columns = new HBoxContainer { SizeFlagsVertical = Control.SizeFlags.ExpandFill };
        columns.AddThemeConstantOverride("separation", 8);
        rows.AddChild(columns);

        _status = new Label { Text = "", AutowrapMode = TextServer.AutowrapMode.WordSmart, HorizontalAlignment = HorizontalAlignment.Center };
        rows.AddChild(_status);

        // The guild list scrolls; the footer stays pinned to the bottom of the column.
        _left = new VBoxContainer();
        _left.AddThemeConstantOverride("separation", 6);
        _leftFooter = new VBoxContainer();
        _leftFooter.AddThemeConstantOverride("separation", 6);
        var leftColumn = new VBoxContainer { CustomMinimumSize = new Vector2(290, 0) };
        leftColumn.AddThemeConstantOverride("separation", 6);
        leftColumn.AddChild(Scroll(_left));
        leftColumn.AddChild(_leftFooter);
        columns.AddChild(style.MakeSection("Your Guilds", leftColumn));

        var right = new VBoxContainer { CustomMinimumSize = new Vector2(640, 0) };
        right.AddThemeConstantOverride("separation", 8);
        _tabs = new HBoxContainer();
        _tabs.AddThemeConstantOverride("separation", 4);
        var group = new ButtonGroup();
        _membersButton = TabButton("Members", group);
        _manageButton = TabButton("Manage", group);
        _marketButton = TabButton("Marketplace", group);
        _groundsButton = TabButton("Guild Grounds", group);
        _membersButton.Pressed += () => { _manage = false; _market = false; _grounds = false; RebuildPage(); };
        _manageButton.Pressed += () => { _manage = true; _market = false; _grounds = false; RefreshDetail(); RebuildPage(); };
        _marketButton.Pressed += OpenMarketTab;
        _groundsButton.Pressed += OpenGroundsTab;
        _tabs.AddChild(_membersButton);
        _tabs.AddChild(_manageButton);
        _tabs.AddChild(_marketButton);
        _tabs.AddChild(_groundsButton);
        right.AddChild(_tabs);

        _page = new VBoxContainer();
        _page.AddThemeConstantOverride("separation", 6);
        right.AddChild(Scroll(_page));

        Control rightSection = style.MakeSection("Guild", right);
        rightSection.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
        columns.AddChild(rightSection);

        gameView.AddChild(_backdrop);

        service.Changed += OnServiceChanged;
        service.Notice += OnNotice;
        ModEntry.Boost.Changed += OnServiceChanged; // The bonus line and Join buttons depend on it.
        ModEntry.Fight.Changed += OnServiceChanged;
        if (ModEntry.Market != null)
        {
            ModEntry.Market.Changed += OnServiceChanged;
            ModEntry.Market.Notice += OnNotice;
        }
        if (ModEntry.Grounds != null)
        {
            ModEntry.Grounds.Changed += OnServiceChanged;
            ModEntry.Grounds.Notice += OnNotice;
        }
        _backdrop.TreeExiting += () =>
        {
            if (ModEntry.Market != null)
            {
                ModEntry.Market.Changed -= OnServiceChanged;
                ModEntry.Market.Notice -= OnNotice;
            }
            if (ModEntry.Grounds != null)
            {
                ModEntry.Grounds.Changed -= OnServiceChanged;
                ModEntry.Grounds.Notice -= OnNotice;
            }
            service.Changed -= OnServiceChanged;
            service.Notice -= OnNotice;
            ModEntry.Boost.Changed -= OnServiceChanged;
            ModEntry.Fight.Changed -= OnServiceChanged;
        };
        Rebuild();
    }

    public void Open()
    {
        if (!GodotObject.IsInstanceValid(_backdrop)) return;
        _gameView.CloseExclusiveModals();
        _backdrop.Visible = true;
        _status.Text = "";
        RefreshDetail();
        Rebuild();
    }

    public void Close()
    {
        if (GodotObject.IsInstanceValid(_backdrop)) _backdrop.Visible = false;
    }

    public void Toggle()
    {
        if (IsOpen) Close();
        else Open();
    }

    /// <summary>Call every frame while a save is loaded.</summary>
    public void Tick(double delta)
    {
        if (!IsOpen) return;
        if (_rebuildPending && !TypingInside()) Rebuild();

        _sinceDetail += delta;
        if (_manage && _sinceDetail > 10) RefreshDetail();
        TickMarket(delta);
        TickGrounds(delta);
    }

    private void OnServiceChanged()
    {
        if (IsOpen) Rebuild();
    }

    private void OnNotice(string text)
    {
        if (GodotObject.IsInstanceValid(_status)) _status.Text = text;
    }

    private void RefreshDetail()
    {
        _sinceDetail = 0;
        GuildInfo? guild = _service.Find(_guildId);
        if (guild != null && guild.Rank != "member") _service.LoadDetail(guild.Id);
    }

    // ---- Building ----

    private void Rebuild()
    {
        if (!GodotObject.IsInstanceValid(_backdrop)) return;
        // Rebuilding would wipe a text box the player is typing in; wait until they leave it.
        if (TypingInside())
        {
            _rebuildPending = true;
            return;
        }
        _rebuildPending = false;

        if (_mode is Mode.Guild or Mode.Profile && _service.Find(_guildId) == null)
        {
            _mode = Mode.Empty;
            _guildId = null;
        }
        if (_mode == Mode.Empty && _service.Guilds.Count > 0) Select(_service.Guilds[0].Id, rebuild: false);

        RebuildLeft();
        RebuildPage();
    }

    private bool TypingInside()
    {
        Control? focus = _backdrop.GetViewport()?.GuiGetFocusOwner();
        return focus is LineEdit && _backdrop.IsAncestorOf(focus);
    }

    private void Select(string guildId, bool rebuild = true)
    {
        _mode = Mode.Guild;
        if (_guildId != guildId)
        {
            _guildId = guildId;
            _manage = false;
            GuildInfo? guild = _service.Find(guildId);
            _settingsName = guild?.Name ?? "";
            _settingsDescription = guild?.Description ?? "";
        }
        RefreshDetail();
        if (rebuild)
        {
            RebuildLeft();
            RebuildPage();
        }
    }

    private void RebuildLeft()
    {
        Clear(_left);
        Clear(_leftFooter);

        if (!_service.Enabled)
        {
            bool update = _service.NeedsConsent;
            _left.AddChild(Text(
                (update ? "Guilds now do more, so please read this again.\n\n" : "") +
                "Guilds use a small online server run by the person who shared this mod.\n\n" +
                "Enabling guilds sends your Steam ID and Steam name, the guilds you create or join, your guild " +
                "chat messages, what you are training or fighting right now, all your skill levels, your equipped " +
                "gear and, while you fight, your health, damage per second and combat level. Guild mates can see these.\n\n" +
                "It also turns on the party bonus: +5% XP for each guild mate who is online doing the exact same " +
                "action as you. In combat, guild mates fighting the same enemy also add part of their damage to " +
                "your fight: 15% of it if your combat levels are within 10, otherwise 8%. The XP and loot " +
                "you earn that way stay on your character.\n\n" +
                "The guild marketplace moves real items and gold: listing an item takes it out of your bank, " +
                "buying takes your gold and gives you the item, and your listings and offers are visible to your " +
                "guild mates.\n\n" +
                "Guild Grounds are tasks your guild does together. The mod reports how many monsters you " +
                "defeat, Agility laps you complete and Thieving actions you succeed at, including while the " +
                "game was closed, and guild mates can see what you contributed. Items you donate there leave " +
                "your bank for good. Finished locations give every member a small passive bonus.\n\n" +
                "It does not send your save or anything about your account. You can delete your guild data at any time."));
            if (!update)
            {
                _left.AddChild(Input(_testerCode, "Tester code (if you were given one)", 64, text => _testerCode = text));
            }
            Button enable = update
                ? Action("Accept and continue", "TexturedActionButtonGreen8x", _service.AcceptConsent)
                : Action("Enable Guilds", "TexturedActionButtonGreen8x", () => _service.Enable(_testerCode));
            enable.Disabled = _service.Busy || !_service.SteamReady;
            if (_service.Busy) enable.Text = "Connecting...";
            _left.AddChild(enable);
            return;
        }

        if (_service.Guilds.Count == 0) _left.AddChild(Text("You are not in a guild yet."));
        foreach (GuildInfo guild in _service.Guilds)
        {
            string id = guild.Id;
            Button button = Action(guild.Name + "  (" + RankName(guild.Rank) + ")", "TexturedButton8x", () => Select(id));
            button.ToggleMode = true;
            button.ButtonPressed = _mode == Mode.Guild && _guildId == id;
            button.ClipText = true;
            _left.AddChild(button);
        }

        if (_service.Invites.Count > 0)
        {
            _left.AddChild(Heading("Invites"));
            foreach (InviteInfo invite in _service.Invites)
            {
                string id = invite.GuildId;
                _left.AddChild(Text(invite.GuildName + " (from " + invite.ByName + ")"));
                _left.AddChild(Row(
                    Action("Join", "TexturedActionButtonGreen8x", () => _service.AnswerInvite(id, true)),
                    Action("Decline", "TexturedButton8x", () => _service.AnswerInvite(id, false))));
            }
        }

        if (_service.MyRequests.Count > 0)
        {
            _left.AddChild(Heading("Waiting for approval"));
            foreach ((string guildId, string guildName) in _service.MyRequests)
            {
                string id = guildId;
                _left.AddChild(Row(Grow(Text(guildName)), Action("Cancel", "TexturedButton8x", () => _service.CancelJoin(id))));
            }
        }

        _left.AddChild(new Control { CustomMinimumSize = new Vector2(0, 8) });
        _left.AddChild(Action("Create Guild", "TexturedActionButtonGreen8x", () => { _mode = Mode.Create; Rebuild(); }));
        _left.AddChild(Action("Find Guild", "TexturedButton8x", () => { _mode = Mode.Find; Rebuild(); }));

        _leftFooter.AddChild(Confirm("Delete my guild data", "TexturedButtonCancel8x", _service.DeleteMyData));
    }

    private void RebuildPage()
    {
        Clear(_page);
        GuildInfo? guild = _mode is Mode.Guild or Mode.Profile ? _service.Find(_guildId) : null;
        _tabs.Visible = guild != null && _mode == Mode.Guild;

        if (!_service.Enabled)
        {
            _page.AddChild(Text("Enable guilds on the left to create or join one."));
            return;
        }

        switch (_mode)
        {
            case Mode.Create:
                BuildCreate();
                break;
            case Mode.Find:
                BuildFind();
                break;
            case Mode.Profile when guild != null && _profileMember != null:
                BuildProfile(guild);
                break;
            case Mode.Guild when guild != null:
                _manageButton.Text = guild.Rank == "owner" ? "Owner" : "Manage";
                _membersButton.SetPressedNoSignal(!_manage && !_market && !_grounds);
                _manageButton.SetPressedNoSignal(_manage);
                _marketButton.SetPressedNoSignal(_market);
                _groundsButton.SetPressedNoSignal(_grounds);
                if (_grounds) BuildGrounds(guild);
                else if (_market) BuildMarket(guild);
                else if (_manage) BuildManage(guild);
                else BuildMembers(guild);
                break;
            default:
                _page.AddChild(Text("Create a guild, or find one to join."));
                break;
        }
    }

    private void BuildMembers(GuildInfo guild)
    {
        _page.AddChild(Heading(guild.Name));
        if (guild.Description.Length > 0) _page.AddChild(Text(guild.Description));
        AddBonusLine();

        List<MemberInfo> members = MembersOf(guild);
        int online = members.Count(IsOnline);
        _page.AddChild(Heading("Members (" + members.Count + ", " + online + " online)"));
        foreach (MemberInfo member in members)
        {
            bool isOnline = IsOnline(member);
            Label dot = Text("●");
            dot.Modulate = isOnline ? new Color(0.35f, 0.85f, 0.35f) : new Color(0.45f, 0.45f, 0.45f);
            // The name opens the member's profile.
            MemberInfo shown = member;
            Button name = Action(member.Name + (member.Id == _service.SteamId ? " (you)" : ""), "TexturedButton8x", () => OpenProfile(shown));
            name.CustomMinimumSize = new Vector2(220, 32);
            name.ClipText = true;
            name.TooltipText = "View profile";
            Label rank = Text(RankName(member.Rank));
            rank.CustomMinimumSize = new Vector2(80, 0);
            _page.AddChild(Row(dot, name, rank, Grow(ActivityControl(member, isOnline))));
        }

        _page.AddChild(new Control { CustomMinimumSize = new Vector2(0, 8) });
        if (guild.Rank == "owner")
        {
            _page.AddChild(Text("As owner you cannot leave. Transfer ownership or disband the guild on the Owner tab."));
        }
        else
        {
            string id = guild.Id;
            _page.AddChild(Row(Confirm("Leave guild", "TexturedButtonCancel8x", () => _service.Leave(id))));
        }
    }

    private void BuildManage(GuildInfo guild)
    {
        string id = guild.Id;
        if (guild.Rank == "member")
        {
            _page.AddChild(Text("Only the owner and officers can manage this guild."));
            return;
        }
        bool owner = guild.Rank == "owner";

        _page.AddChild(Heading("Join requests"));
        List<PendingInfo> requests = _service.JoinRequests.GetValueOrDefault(id) ?? new List<PendingInfo>();
        if (requests.Count == 0) _page.AddChild(Text("No requests."));
        foreach (PendingInfo request in requests)
        {
            string player = request.PlayerId;
            _page.AddChild(Row(Grow(Text(request.Name)),
                Action("Accept", "TexturedActionButtonGreen8x", () => _service.AnswerRequest(id, player, true)),
                Action("Decline", "TexturedButton8x", () => _service.AnswerRequest(id, player, false))));
        }

        _page.AddChild(Heading("Invite a Steam friend"));
        var friends = new OptionButton { SizeFlagsHorizontal = Control.SizeFlags.ExpandFill, FocusMode = Control.FocusModeEnum.None };
        List<(string Id, string Name)> friendList = SteamFriendList();
        foreach ((string _, string friendName) in friendList) friends.AddItem(friendName);
        Button inviteButton = Action("Invite", "TexturedButton8x", () =>
        {
            if (friends.Selected >= 0 && friends.Selected < friendList.Count) _service.Invite(id, friendList[friends.Selected].Id);
        });
        inviteButton.Disabled = friendList.Count == 0;
        _page.AddChild(Row(friends, inviteButton));
        _page.AddChild(Text("Your friend needs the mod with guilds enabled before they can be invited."));

        List<PendingInfo> invites = _service.SentInvites.GetValueOrDefault(id) ?? new List<PendingInfo>();
        if (invites.Count > 0)
        {
            _page.AddChild(Heading("Invites sent"));
            foreach (PendingInfo invite in invites)
            {
                string player = invite.PlayerId;
                _page.AddChild(Row(Grow(Text(invite.Name)), Action("Cancel", "TexturedButton8x", () => _service.AnswerRequest(id, player, false))));
            }
        }

        _page.AddChild(Heading("Members"));
        foreach (MemberInfo member in MembersOf(guild))
        {
            string player = member.Id;
            var row = new List<Control> { Grow(Text(member.Name + "  -  " + RankName(member.Rank))) };
            bool self = player == _service.SteamId;
            if (!self && owner)
            {
                row.Add(member.Rank == "officer"
                    ? Action("Demote", "TexturedButton8x", () => _service.SetRank(id, player, "member"))
                    : Action("Promote", "TexturedButton8x", () => _service.SetRank(id, player, "officer")));
                row.Add(Confirm("Make owner", "TexturedButton8x", () => _service.Transfer(id, player)));
            }
            if (!self && (owner || member.Rank == "member"))
            {
                row.Add(Confirm("Kick", "TexturedButtonCancel8x", () => _service.Kick(id, player)));
            }
            _page.AddChild(Row(row.ToArray()));
        }

        if (!owner) return;

        _page.AddChild(Heading("Guild settings"));
        LineEdit name = Input(_settingsName, "Guild name", 24, text => _settingsName = text);
        LineEdit description = Input(_settingsDescription, "Description", 200, text => _settingsDescription = text);
        _page.AddChild(name);
        _page.AddChild(description);
        _page.AddChild(Row(
            Action("Save", "TexturedActionButtonGreen8x", () => _service.Update(id, _settingsName.Trim(), _settingsDescription.Trim())),
            Confirm("Disband guild", "TexturedButtonCancel8x", () => _service.Disband(id))));
    }

    private void BuildCreate()
    {
        _page.AddChild(Heading("Create a guild"));
        _page.AddChild(Text("Name: 3 to 24 characters (letters, numbers, spaces, - and _)."));
        _page.AddChild(Input(_createName, "Guild name", 24, text => _createName = text));
        _page.AddChild(Input(_createDescription, "Description (optional)", 200, text => _createDescription = text));
        _page.AddChild(Row(
            Action("Create", "TexturedActionButtonGreen8x", () =>
            {
                string name = _createName.Trim();
                _service.CreateGuild(name, _createDescription.Trim(), ok =>
                {
                    if (!ok) return;
                    _createName = _createDescription = "";
                    _mode = Mode.Empty; // Rebuild selects the new guild once the list arrives.
                    _guildId = null;
                });
            }),
            Action("Cancel", "TexturedButton8x", () => { _mode = Mode.Empty; Rebuild(); })));
    }

    private void BuildFind()
    {
        _page.AddChild(Heading("Find a guild"));
        LineEdit query = Input(_query, "Search by name (leave empty to list guilds)", 24, text => _query = text);
        query.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
        void Search() => _service.Search(_query.Trim(), hits =>
        {
            _hits = hits;
            if (_mode == Mode.Find) Rebuild();
        });
        query.TextSubmitted += _ => { query.ReleaseFocus(); Search(); };
        _page.AddChild(Row(query, Action("Search", "TexturedButton8x", Search)));

        if (_hits == null) return;
        if (_hits.Count == 0) _page.AddChild(Text("No guilds found."));
        foreach (SearchHit hit in _hits)
        {
            string id = hit.Id;
            Control action;
            if (_service.Find(id) != null) action = Text("Member");
            else if (_service.MyRequests.Any(r => r.GuildId == id)) action = Text("Requested");
            else action = Action("Ask to join", "TexturedButton8x", () => _service.RequestJoin(id));

            string line = hit.Name + "  (" + hit.MemberCount + (hit.MemberCount == 1 ? " member)" : " members)");
            if (hit.Description.Length > 0) line += "\n" + hit.Description;
            _page.AddChild(Row(Grow(Text(line)), action));
        }
    }

    // ---- Profile, join and party bonus ----

    private void AddBonusLine()
    {
        PartyBoost boost = ModEntry.Boost;
        if (!boost.Active) return;
        string text = "Party bonus active: " + boost.PercentText + " " + boost.SkillName + " XP with " + boost.PartnerName + ".";
        double dps = ModEntry.Fight.BonusDps;
        if (dps > 0) text += " They add " + Math.Round(dps) + " damage per second to your fight.";
        Label line = Text(text);
        line.Modulate = new Color(0.45f, 0.9f, 0.45f);
        _page.AddChild(line);
    }

    /// <summary>
    /// What a member is doing. If it is something the local character could do too, it is a Join button;
    /// otherwise plain text with the reason in the tooltip.
    /// </summary>
    private Control ActivityControl(MemberInfo member, bool online)
    {
        if (!online || !member.HasAction || member.Id == _service.SteamId)
        {
            var plain = new HBoxContainer();
            plain.AddThemeConstantOverride("separation", 6);
            plain.AddChild(SkillIcon(online ? member : null));
            plain.AddChild(Grow(Text(Activity(member, online))));
            return plain;
        }

        string label = member.ActionName.Length > 0 ? member.ActionName : member.Skill;
        if (member.Level > 0) label += "  (level " + member.Level + ")";

        Game? game = ModEntry.CurrentGame();
        JoinCheck check = game == null
            ? new JoinCheck(JoinState.Unknown, "Not available right now.")
            : ActionJoiner.Check(game, member.ActionEntity, member.ActionTarget, member.ActionArea);

        string entity = member.ActionEntity;
        string target = member.ActionTarget;
        string area = member.ActionArea;
        bool fight = entity == CombatAccess.EntityId;
        Button join = Action(label, check.State == JoinState.Already ? "TexturedActionButtonGreen8x" : "TexturedButton8x", () => Join(entity, target, area));
        join.Icon = Icons.Skill(LocalId(member.ActionEntity));
        join.ExpandIcon = true;
        join.AddThemeConstantOverride("icon_max_width", 24);
        join.Alignment = HorizontalAlignment.Left;
        join.ClipText = true;
        join.CustomMinimumSize = new Vector2(0, 32);
        join.Disabled = check.State != JoinState.Ready;
        join.TooltipText = check.State switch
        {
            JoinState.Ready => fight
                ? "Click to fight this too. While you both fight it you each get +5% XP and part of the other's damage."
                : "Click to do this too. While you are both on it, you each get +5% XP.",
            JoinState.Already => fight ? "You are fighting this together." : "You are training this together.",
            _ => check.Reason,
        };
        return join;
    }

    private void Join(string entityId, string targetId, string areaId)
    {
        Game? game = ModEntry.CurrentGame();
        if (game == null)
        {
            OnNotice("Not available right now.");
            return;
        }
        JoinCheck result = ActionJoiner.Join(game, entityId, targetId, areaId);
        OnNotice(result.State == JoinState.Ready ? "Joined. Your party bonus starts within a few seconds; theirs within about a minute." : result.Reason);
        Rebuild();
    }

    private void OpenProfile(MemberInfo member)
    {
        _mode = Mode.Profile;
        _profileMember = member;
        _profile = null;
        _profileLoading = true;
        string id = member.Id;
        _service.LoadProfile(id, profile =>
        {
            if (_profileMember?.Id != id) return;
            _profile = profile;
            _profileLoading = false;
            if (IsOpen && _mode == Mode.Profile) RebuildPage();
        });
        RebuildPage();
    }

    private void BuildProfile(GuildInfo guild)
    {
        // Use the freshest copy of this member from the latest sync, if they are still in the guild.
        MemberInfo member = MembersOf(guild).FirstOrDefault(m => m.Id == _profileMember!.Id) ?? _profileMember!;
        bool online = IsOnline(member);

        _page.AddChild(Row(Action("< Back", "TexturedButton8x", () => { _mode = Mode.Guild; RebuildPage(); }),
            Grow(Heading(member.Name + "  -  " + RankName(member.Rank) + " of " + guild.Name))));

        _page.AddChild(Heading("Right now"));
        _page.AddChild(ActivityControl(member, online));

        if (_profileLoading)
        {
            _page.AddChild(Text("Loading profile..."));
            return;
        }
        if (_profile == null || !_profile.Shared)
        {
            _page.AddChild(Text("This member has not shared a profile yet. They need the latest version of the mod."));
            return;
        }

        Game? game = ModEntry.CurrentGame();

        _page.AddChild(Heading("Skills  (total level " + _profile.Skills.Sum(x => x.Level) + ")"));
        var skills = new GridContainer { Columns = 3 };
        skills.AddThemeConstantOverride("h_separation", 18);
        skills.AddThemeConstantOverride("v_separation", 4);
        foreach (ProfileSkill skill in _profile.Skills)
        {
            string name = LocalId(skill.Id);
            Texture2D? icon = Icons.Skill(name);
            if (game != null && game.Entities.TryGetObjectById(skill.Id, out GameEntity? entity) && entity != null)
            {
                name = entity.DisplayName.Text;
                icon = entity.Icon ?? icon;
            }
            Label label = Text(name);
            label.CustomMinimumSize = new Vector2(120, 0);
            Label level = Text(skill.Level.ToString());
            level.CustomMinimumSize = new Vector2(28, 0);
            level.HorizontalAlignment = HorizontalAlignment.Right;
            skills.AddChild(Row(IconRect(icon, 22), label, level));
        }
        _page.AddChild(skills);

        _page.AddChild(Heading("Equipped gear"));
        if (_profile.Gear.Count == 0) _page.AddChild(Text("Nothing equipped."));
        var gear = new GridContainer { Columns = 2 };
        gear.AddThemeConstantOverride("h_separation", 18);
        gear.AddThemeConstantOverride("v_separation", 4);
        foreach (ProfileGear piece in _profile.Gear)
        {
            gear.AddChild(GearEntry(game, piece));
        }
        _page.AddChild(gear);
    }

    /// <summary>One equipped item: the game's own item icon (with its tooltip) when available, plus the name.</summary>
    private static Control GearEntry(Game? game, ProfileGear piece)
    {
        Control icon = GearIcon(game, piece, out string name);
        Label label = Text(name + (piece.Quantity > 1 ? "  x" + piece.Quantity : "") + "\n" + LocalId(piece.Slot));
        label.CustomMinimumSize = new Vector2(200, 0);
        return Row(icon, label);
    }

    /// <summary>The item picture with a name tooltip, also used by the Players tab on the combat screen.</summary>
    internal static Control GearIcon(Game? game, ProfileGear piece, out string name)
    {
        name = LocalId(piece.Item);
        Texture2D? texture = Icons.Game("res://Assets/Items/" + name + ".png");
        if (game != null && game.Data.TryGetObject<Item>(piece.Item, out Item? item) && item != null)
        {
            name = ((ILocalizedString)item.DisplayName).Text;
            texture = item.Icon;
        }

        // A plain picture, not the game's pooled item icon: that one is built for costs and rewards and shows
        // "owned / needed" counts from the local player's bank, which is wrong for someone else's gear.
        TextureRect icon = IconRect(texture, 32);
        icon.MouseFilter = Control.MouseFilterEnum.Stop;
        icon.TooltipText = name + (piece.Quantity > 1 ? "  x" + piece.Quantity : "") + "\n" + LocalId(piece.Slot);
        return icon;
    }

    private static TextureRect SkillIcon(MemberInfo? member)
    {
        Texture2D? texture = member == null ? null
            : member.HasAction ? Icons.Skill(LocalId(member.ActionEntity)) ?? Icons.Skill(member.Skill)
            : Icons.Skill(member.Skill);
        return IconRect(texture, 24);
    }

    private static TextureRect IconRect(Texture2D? texture, int size) => new()
    {
        Texture = texture,
        CustomMinimumSize = new Vector2(size, size),
        ExpandMode = TextureRect.ExpandModeEnum.IgnoreSize,
        StretchMode = TextureRect.StretchModeEnum.KeepAspectCentered,
        SizeFlagsVertical = Control.SizeFlags.ShrinkCenter,
    };

    /// <summary>"MelvorBase:Fishing" to "Fishing".</summary>
    private static string LocalId(string id)
    {
        int colon = id.IndexOf(':');
        return colon >= 0 ? id.Substring(colon + 1) : id;
    }

    // ---- Data helpers ----

    private List<MemberInfo> MembersOf(GuildInfo guild)
    {
        List<MemberInfo> members = _service.Members.GetValueOrDefault(guild.Id) ?? new List<MemberInfo>();
        return members.OrderBy(m => m.Rank switch { "owner" => 0, "officer" => 1, _ => 2 })
            .ThenBy(m => m.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private bool IsOnline(MemberInfo member) => _service.ServerNow - member.LastSeen < GuildService.OnlineWindowMs;

    private string Activity(MemberInfo member, bool online)
    {
        if (online && member.ActionName.Length > 0) return member.ActionName + " (level " + member.Level + ")";
        if (online) return member.Skill.Length > 0 ? member.Skill + " (level " + member.Level + ")" : "Online";
        if (member.LastSeen <= 0) return "Offline";
        TimeSpan ago = TimeSpan.FromMilliseconds(Math.Max(0, _service.ServerNow - member.LastSeen));
        if (ago.TotalMinutes < 60) return "Last seen " + (int)ago.TotalMinutes + " min ago";
        if (ago.TotalHours < 48) return "Last seen " + (int)ago.TotalHours + " h ago";
        return "Last seen " + (int)ago.TotalDays + " days ago";
    }

    private static string RankName(string rank) => rank switch
    {
        "owner" => "Owner",
        "officer" => "Officer",
        _ => "Member",
    };

    private static List<(string Id, string Name)> SteamFriendList()
    {
        var list = new List<(string, string)>();
        try
        {
            int count = SteamFriends.GetFriendCount(EFriendFlags.k_EFriendFlagImmediate);
            for (int i = 0; i < count; i++)
            {
                CSteamID friend = SteamFriends.GetFriendByIndex(i, EFriendFlags.k_EFriendFlagImmediate);
                list.Add((friend.m_SteamID.ToString(), SteamFriends.GetFriendPersonaName(friend)));
            }
        }
        catch (Exception e)
        {
            ModEntry.Log("Could not read Steam friends: " + e.Message);
        }
        list.Sort((a, b) => string.Compare(a.Item2, b.Item2, StringComparison.OrdinalIgnoreCase));
        return list;
    }

    // ---- Control helpers ----

    // Clicks inside the window are consumed by its panels, so anything arriving here is outside it.
    private void OnBackdropInput(InputEvent input)
    {
        if (input is InputEventMouseButton { Pressed: true, ButtonIndex: MouseButton.Left }) Close();
    }

    private static void Clear(Node container)
    {
        foreach (Node child in container.GetChildren())
        {
            container.RemoveChild(child);
            child.QueueFree();
        }
    }

    private static ScrollContainer Scroll(Control content)
    {
        var scroll = new ScrollContainer
        {
            SizeFlagsVertical = Control.SizeFlags.ExpandFill,
            SizeFlagsHorizontal = Control.SizeFlags.ExpandFill,
            HorizontalScrollMode = ScrollContainer.ScrollMode.Disabled,
        };
        content.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
        scroll.AddChild(content);
        return scroll;
    }

    private static HBoxContainer Row(params Control[] items)
    {
        var row = new HBoxContainer();
        row.AddThemeConstantOverride("separation", 6);
        foreach (Control item in items) row.AddChild(item);
        return row;
    }

    private static Control Grow(Control control)
    {
        control.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
        return control;
    }

    private static Label Text(string text) => new()
    {
        Text = text,
        AutowrapMode = TextServer.AutowrapMode.WordSmart,
        AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled, // Player-written names must not be translated.
        VerticalAlignment = VerticalAlignment.Center,
    };

    private static Label Heading(string text)
    {
        Label label = Text(text);
        label.Modulate = new Color(0.95f, 0.8f, 0.35f);
        return label;
    }

    private static Button TabButton(string text, ButtonGroup group) => new()
    {
        Text = text,
        ToggleMode = true,
        ButtonGroup = group,
        ThemeTypeVariation = "TexturedTabButtonLeft",
        CustomMinimumSize = new Vector2(140, 36),
        MouseDefaultCursorShape = Control.CursorShape.PointingHand,
        FocusMode = Control.FocusModeEnum.None,
    };

    private static Button Action(string text, string variation, Action onPressed)
    {
        var button = new Button
        {
            Text = text,
            ThemeTypeVariation = variation,
            CustomMinimumSize = new Vector2(0, 36),
            MouseDefaultCursorShape = Control.CursorShape.PointingHand,
            FocusMode = Control.FocusModeEnum.None,
            AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled,
        };
        button.Pressed += onPressed;
        return button;
    }

    /// <summary>A button for actions that cannot be undone: the first click arms it, the second runs it.</summary>
    private static Button Confirm(string text, string variation, Action onConfirmed)
    {
        Button button = null!;
        ulong armedAt = 0;
        button = Action(text, variation, () =>
        {
            ulong now = Time.GetTicksMsec();
            if (armedAt != 0 && now - armedAt < 5000)
            {
                onConfirmed();
                return;
            }
            armedAt = now;
            button.Text = "Click again to confirm";
        });
        return button;
    }

    private static LineEdit Input(string text, string placeholder, int maxLength, Action<string> onChanged)
    {
        var input = new LineEdit { Text = text, PlaceholderText = placeholder, MaxLength = maxLength };
        input.TextChanged += value => onChanged(value);
        return input;
    }
}
