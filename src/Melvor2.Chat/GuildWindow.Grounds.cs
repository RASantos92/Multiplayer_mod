using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Data.Items;
using GamesByMalcs.Melvor2.GameMenus.Pages;
using Godot;
using Melvor2.Chat.GameState;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat;

/// <summary>
/// The Guild Grounds tab of the Guild window: the guild's locations, the five tasks at each with a progress
/// bar coloured by who contributed, the bonus a finished location gives and how long it still lasts, and a
/// panel to donate items from the bank to a task.
/// </summary>
internal sealed partial class GuildWindow
{
    private static readonly Color s_green = new(0.45f, 0.9f, 0.45f);
    private static readonly Color s_dim = new(0.75f, 0.72f, 0.66f);
    private static readonly Color s_others = new(0.55f, 0.55f, 0.55f);

    /// <summary>One colour per contributor on a task's bar; far apart so neighbours are easy to tell.</summary>
    private static readonly Color[] s_palette =
    {
        new(0.30f, 0.69f, 0.31f), new(0.26f, 0.59f, 0.98f), new(1.00f, 0.76f, 0.03f), new(0.91f, 0.30f, 0.24f),
        new(0.67f, 0.40f, 0.86f), new(0.10f, 0.74f, 0.74f), new(1.00f, 0.55f, 0.20f), new(0.93f, 0.45f, 0.70f),
    };

    private const long DayMs = 24L * 60 * 60 * 1000;

    private bool _grounds;
    private Button _groundsButton = null!;
    private double _sinceGrounds;

    /// <summary>Sections the player opened or folded by hand: "tier:0" or "loc:gatehouse".</summary>
    private readonly Dictionary<string, bool> _groundsOpen = new();

    private string? _donateTask;
    private string? _donateItem;
    private int _donateQty = 1;

    private void OpenGroundsTab()
    {
        _manage = false;
        _market = false;
        _grounds = true;
        _sinceGrounds = 0;
        _donateTask = null;
        if (_guildId != null) ModEntry.Grounds?.Load(_guildId, force: true);
        RebuildPage();
    }

    /// <summary>While the tab is showing, pick up progress other members make.</summary>
    private void TickGrounds(double delta)
    {
        if (!_grounds || _guildId == null) return;
        _sinceGrounds += delta;
        if (_sinceGrounds < 2) return;
        _sinceGrounds = 0;
        ModEntry.Grounds?.Load(_guildId);
    }

    private void BuildGrounds(GuildInfo guild)
    {
        GroundsService? grounds = ModEntry.Grounds;
        Game? game = ModEntry.CurrentGame();
        if (grounds == null || game == null)
        {
            _page.AddChild(Text("Guild Grounds are available while your save is loaded and the game is running."));
            return;
        }
        grounds.Load(guild.Id);
        _numbers.Clear();

        if (!grounds.Tiers.TryGetValue(guild.Id, out List<GroundsTier>? tiers) || tiers.Count == 0)
        {
            _page.AddChild(Text("Loading..."));
            return;
        }

        GroundsTask? donating = _donateTask == null ? null
            : tiers.SelectMany(t => t.Locations).SelectMany(l => l.Tasks).FirstOrDefault(t => t.Id == _donateTask);
        if (donating != null && !donating.Done)
        {
            BuildDonate(game, guild, grounds, donating);
            return;
        }
        _donateTask = null;

        int size = Math.Max(1, _service.Members.TryGetValue(guild.Id, out List<MemberInfo>? roster) ? roster.Count : 1);
        _page.AddChild(Text("The guild works on these tasks together. Finish all five at a location and every member gets its bonus for 30 days; "
            + "in the last 7 days the tasks come back so the guild can add another 30. Amounts grow with the guild: they are for "
            + size + (size == 1 ? " member" : " members") + " now. "
            + "Tasks without a Donate button count by themselves as you play, also while the game is closed, and you keep what you make. Donated items are gone for good. "
            + "Hover over a bar to see who contributed."));

        // Each member keeps one colour on every bar.
        var colours = new Dictionary<string, Color>();
        foreach (MemberInfo member in (roster ?? new List<MemberInfo>()).OrderBy(m => m.Id, StringComparer.Ordinal))
        {
            colours[member.Id] = s_palette[colours.Count % s_palette.Length];
        }

        // By default only the first tier that still has work is open; clicks are remembered while the game runs.
        int firstOpen = tiers.FindIndex(t => t.Locations.Any(l => l.State != "active"));
        for (int number = 0; number < tiers.Count; number++)
        {
            GroundsTier tier = tiers[number];
            string tierKey = "tier:" + number;
            bool tierOpen = _groundsOpen.TryGetValue(tierKey, out bool chosen) ? chosen : number == Math.Max(0, firstOpen);
            int finished = tier.Locations.Count(l => l.Done);
            Button tierHead = Fold(tierOpen, "Tier " + (number + 1) + ": " + tier.Name + "   (" + finished + " of " + tier.Locations.Count + " built)", 18, tierKey);
            tierHead.AddThemeColorOverride("font_color", new Color(0.95f, 0.8f, 0.4f));
            _page.AddChild(tierHead);
            if (!tierOpen) continue;

            foreach (GroundsLocation location in tier.Locations)
            {
                _page.AddChild(new HSeparator());
                string key = "loc:" + location.Id;
                bool active = location.State == "active";
                bool known = GroundsBonus.Knows(location.BonusId);
                Label bonus = Short(location.Done
                    ? (known ? "Bonus active: " : "Bonus earned (update the mod to receive it): ") + location.BonusText
                    : "Reward: " + location.BonusText);
                bonus.Modulate = location.Done && known ? s_green : s_dim;
                bonus.HorizontalAlignment = HorizontalAlignment.Right;

                if (active)
                {
                    // Nothing to do here until the last week: just the name and how long the bonus lasts.
                    Label built = Text(location.Name + "   (built)");
                    built.AddThemeFontSizeOverride("font_size", 17);
                    _page.AddChild(Row(built, Grow(bonus)));
                    AddCountdown(location, "The tasks come back for the last 7 days, so the guild can add another 30.");
                    continue;
                }

                bool open = _groundsOpen.TryGetValue(key, out bool picked) ? picked : true;
                Button name = Fold(open, location.Name + "   (" + location.Tasks.Count(t => t.Done) + "/" + location.Tasks.Count + ")", 17, key);
                _page.AddChild(Row(name, Grow(bonus)));
                if (location.State == "renew") AddCountdown(location, "Finish the tasks again to add 30 days. If the time runs out first, the bonus stops until they are done.");
                if (!open) continue;

                var table = new GridContainer { Columns = 4, SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
                table.AddThemeConstantOverride("h_separation", 12);
                table.AddThemeConstantOverride("v_separation", 4);
                foreach (GroundsTask task in location.Tasks) AddTaskRow(table, grounds, task, colours);
                _page.AddChild(table);
            }
            _page.AddChild(new HSeparator());
        }
    }

    /// <summary>A heading that opens or closes the section under it.</summary>
    private Button Fold(bool open, string text, int fontSize, string key)
    {
        var button = new Button
        {
            Text = (open ? "-  " : "+  ") + text,
            Flat = true,
            Alignment = HorizontalAlignment.Left,
            FocusMode = Control.FocusModeEnum.None,
            MouseDefaultCursorShape = Control.CursorShape.PointingHand,
            TooltipText = open ? "Click to fold away" : "Click to open",
        };
        button.AddThemeFontSizeOverride("font_size", fontSize);
        button.Pressed += () =>
        {
            _groundsOpen[key] = !open;
            RebuildMarket();
        };
        return button;
    }

    /// <summary>A bar that empties as a location's 30 days run out, with the time left beside it.</summary>
    private void AddCountdown(GroundsLocation location, string hint)
    {
        if (location.Until <= 0) return; // a server from before bonuses ran out
        long left = Math.Max(0, location.Until - _service.ServerNow);
        var bar = new ProgressBar
        {
            MinValue = 0,
            MaxValue = Math.Max(30 * DayMs, left),
            Value = left,
            ShowPercentage = false,
            CustomMinimumSize = new Vector2(0, 12),
            SizeFlagsHorizontal = Control.SizeFlags.ExpandFill,
            SizeFlagsVertical = Control.SizeFlags.ShrinkCenter,
            TooltipText = hint,
        };
        long days = left / DayMs;
        long hours = left / (60 * 60 * 1000);
        string time = days >= 2 ? days + " days left" : hours >= 2 ? hours + " hours left" : "less than 2 hours left";
        Label label = Short(location.State == "renew" ? time + ": renew now" : time);
        label.CustomMinimumSize = new Vector2(190, 0);
        label.HorizontalAlignment = HorizontalAlignment.Right;
        label.Modulate = location.State == "renew" ? new Color(1f, 0.76f, 0.3f) : s_dim;
        label.TooltipText = hint;
        label.MouseFilter = Control.MouseFilterEnum.Stop;
        _page.AddChild(Row(bar, label));
    }

    /// <summary>
    /// A task's progress bar, split into one coloured piece per contributor (the largest first) and a grey one
    /// for everyone the server did not list. Hovering a piece names the player and what they gave.
    /// </summary>
    private static Control GiverBar(GroundsTask task, Dictionary<string, Color> colours, string summary)
    {
        long need = Math.Max(1, task.Need);
        long have = Math.Clamp(task.Have, 0, need);
        var pieces = new HBoxContainer { MouseFilter = Control.MouseFilterEnum.Pass };
        pieces.AddThemeConstantOverride("separation", 0);

        void Piece(long amount, Color colour, string tip)
        {
            if (amount <= 0) return;
            pieces.AddChild(new ColorRect
            {
                Color = colour,
                SizeFlagsHorizontal = Control.SizeFlags.ExpandFill,
                SizeFlagsStretchRatio = amount,
                TooltipText = tip,
                MouseFilter = Control.MouseFilterEnum.Stop,
            });
        }

        long shown = 0;
        int spare = 0;
        foreach (GroundsGiver giver in task.Top)
        {
            long amount = Math.Min(giver.Amount, have - shown);
            if (amount <= 0) break;
            if (!colours.TryGetValue(giver.Id, out Color colour))
            {
                // Someone who has left the guild since.
                colour = s_palette[(colours.Count + spare++) % s_palette.Length].Darkened(0.35f);
            }
            Piece(amount, colour, giver.Name + ": " + GroundsService.Amount(giver.Amount) + " (" + (giver.Amount * 100 / need) + "% of the task)");
            shown += amount;
        }
        Piece(have - shown, s_others, (task.Top.Count > 0 ? "Other members: " : "The guild: ") + GroundsService.Amount(have - shown));
        Piece(need - have, new Color(0, 0, 0, 0), summary);

        var frame = new PanelContainer
        {
            CustomMinimumSize = new Vector2(150, 16),
            SizeFlagsVertical = Control.SizeFlags.ShrinkCenter,
            TooltipText = summary,
        };
        frame.AddThemeStyleboxOverride("panel", new StyleBoxFlat
        {
            BgColor = new Color(0.08f, 0.08f, 0.08f, 0.85f),
            BorderColor = new Color(0, 0, 0, 0.9f),
            BorderWidthLeft = 1, BorderWidthTop = 1, BorderWidthRight = 1, BorderWidthBottom = 1,
            ContentMarginLeft = 1, ContentMarginTop = 1, ContentMarginRight = 1, ContentMarginBottom = 1,
        });
        frame.AddChild(pieces);
        return frame;
    }

    private void AddTaskRow(GridContainer table, GroundsService grounds, GroundsTask task, Dictionary<string, Color> colours)
    {
        string givers = task.Top.Count == 0
            ? (task.Done ? "Done." : "Nobody has contributed yet.")
            : string.Join("\n", task.Top.Select(g => g.Name + ": " + GroundsService.Amount(g.Amount)));

        Label text = Text(task.Text);
        text.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
        text.TooltipText = givers;
        text.MouseFilter = Control.MouseFilterEnum.Stop;
        if (task.Done) text.Modulate = s_green;
        table.AddChild(text);

        table.AddChild(GiverBar(task, colours, givers));

        Label count = Short(GroundsService.Amount(Math.Min(task.Have, task.Need)) + " / " + GroundsService.Amount(task.Need));
        count.HorizontalAlignment = HorizontalAlignment.Right;
        count.CustomMinimumSize = new Vector2(96, 0);
        if (task.Done) count.Modulate = s_green;
        table.AddChild(count);

        if (task.Kind == "donate" && !task.Done)
        {
            string id = task.Id;
            Button donate = Action("Donate", "TexturedActionButtonGreen8x", () =>
            {
                _donateTask = id;
                _donateItem = null;
                RebuildMarket();
            });
            // The game's button style is sized for big actions; this one sits in a table row.
            donate.AddThemeFontSizeOverride("font_size", 14);
            donate.CustomMinimumSize = new Vector2(84, 24);
            donate.SizeFlagsVertical = Control.SizeFlags.ShrinkCenter;
            donate.SizeFlagsHorizontal = Control.SizeFlags.ShrinkCenter;
            donate.Disabled = grounds.Busy;
            table.AddChild(donate);
        }
        else if (!task.Done && task.Stat.Length > 0)
        {
            string stat = task.Stat;
            Button travel = Action("Travel", "TexturedButton8x", () => Travel(stat));
            travel.AddThemeFontSizeOverride("font_size", 14);
            travel.CustomMinimumSize = new Vector2(84, 24);
            travel.SizeFlagsVertical = Control.SizeFlags.ShrinkCenter;
            travel.SizeFlagsHorizontal = Control.SizeFlags.ShrinkCenter;
            travel.TooltipText = "Go to the page where this is done. It does not start or stop anything.";
            table.AddChild(travel);
        }
        else
        {
            Label state = Short(task.Done ? "Done" : "");
            state.CustomMinimumSize = new Vector2(96, 0);
            state.HorizontalAlignment = HorizontalAlignment.Center;
            state.Modulate = s_green;
            table.AddChild(state);
        }
    }

    /// <summary>
    /// Opens the game page of the skill a task is counted by, the same way clicking it in the sidebar does,
    /// and closes the Guild window. The game's counters are named after the skill ("SmithingItemGained",
    /// "CombatEnemyKilled", "BankItemBuried"), which is how the page is found.
    /// </summary>
    private void Travel(string stat)
    {
        Game? game = ModEntry.CurrentGame();
        if (game == null)
        {
            OnNotice("Not available right now.");
            return;
        }
        // Pages are named after their skill ("MelvorBase:Combat"), and so are the counters.
        string counter = LocalId(stat);
        GamePage? page = null;
        foreach (GamePage candidate in game.Data.Database.GetRegistry<GamePage>().GetAllObjects())
        {
            string name = LocalId(candidate.Id);
            if (name.Length == 0 || !counter.StartsWith(name, StringComparison.Ordinal)) continue;
            if (page == null || name.Length > LocalId(page.Id).Length) page = candidate;
        }
        if (page == null)
        {
            OnNotice("There is no page to go to for this task.");
            return;
        }

        // If the sidebar has an entry for this page that is still locked, say so instead of opening it.
        PageNavigationOption? option = game.Layout.Sidebar.Options.Concat(game.Layout.Sidebar.LegacyOptions)
            .FirstOrDefault(o => ReferenceEquals(o.Page, page) || o.Entity?.Id == page.Id);
        if (option?.Requirements is { AreMet: false })
        {
            OnNotice("You have not unlocked " + option.DisplayName.Message + " yet.");
            return;
        }
        Close();
        _gameView.SetCurrentPage(page);
    }

    private void BuildDonate(Game game, GuildInfo guild, GroundsService grounds, GroundsTask task)
    {
        long left = Math.Max(0, task.Need - task.Have);
        _page.AddChild(Heading(task.Text));
        _page.AddChild(Text("Still needed: " + GroundsService.Amount(left) + " of " + GroundsService.Amount(task.Need)
            + ". Donated items leave your bank for good."));

        Button back = Action("Back to the grounds", "TexturedButton8x", () =>
        {
            _donateTask = null;
            _donateItem = null;
            RebuildMarket();
        });
        back.CustomMinimumSize = new Vector2(190, 34);
        back.SizeFlagsHorizontal = Control.SizeFlags.ShrinkBegin;

        List<(BankItem Bank, long Worth)> have = GroundsService.Donatable(game, task);
        (BankItem Bank, long Worth) chosen = have.FirstOrDefault(h => h.Bank.Item.Id == _donateItem);

        if (chosen.Bank == null)
        {
            _donateItem = null;
            if (have.Count == 0)
            {
                _page.AddChild(Text("Nothing in your bank can be donated to this task (locked items are left out). It accepts:"));
            }
            else
            {
                _page.AddChild(Text("Pick what to give. Better items count for more:"));
                var grid = new GridContainer { Columns = 2, SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
                grid.AddThemeConstantOverride("h_separation", 8);
                grid.AddThemeConstantOverride("v_separation", 4);
                foreach ((BankItem bank, long worth) in have)
                {
                    string id = bank.Item.Id;
                    int most = (int)Math.Min(bank.Quantity, Math.Min(GroundsService.Needed(task, worth), int.MaxValue));
                    Button pick = Action(BankAccess.Name(bank.Item, bank.Quantity) + "  x" + bank.Quantity.ToString("N0") + "   (counts as "
                        + GroundsService.Amount(worth) + " each)", "TexturedButton8x", () =>
                        {
                            _donateItem = id;
                            _donateQty = most;
                            RebuildMarket();
                        });
                    pick.Icon = bank.Item.Icon;
                    pick.ExpandIcon = true;
                    pick.AddThemeConstantOverride("icon_max_width", 24);
                    pick.Alignment = HorizontalAlignment.Left;
                    pick.ClipText = true;
                    pick.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
                    grid.AddChild(pick);
                }
                _page.AddChild(grid);
                _page.AddChild(Text("Everything this task accepts:"));
            }

            // The whole list, so players know what to go and gather.
            var all = new GridContainer { Columns = 3, SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
            all.AddThemeConstantOverride("h_separation", 14);
            all.AddThemeConstantOverride("v_separation", 2);
            foreach (GroundsItem accepted in task.Items)
            {
                Item? item = BankAccess.FindItem(game, accepted.Item);
                if (item == null) continue;
                Label line = Short(BankAccess.Name(item, 2) + ": " + GroundsService.Amount(accepted.Worth) + " each");
                line.Modulate = s_dim;
                all.AddChild(Row(IconRect(item.Icon, 20), line));
            }
            _page.AddChild(all);
            _page.AddChild(back);
            return;
        }

        Item giving = chosen.Bank.Item;
        long worthEach = chosen.Worth;
        int max = (int)Math.Max(1, Math.Min(chosen.Bank.Quantity, Math.Min(GroundsService.Needed(task, worthEach), int.MaxValue)));
        _donateQty = Math.Clamp(_donateQty, 1, max);

        _page.AddChild(Row(IconRect(giving.Icon, 32), Grow(Text("You have " + chosen.Bank.Quantity.ToString("N0") + " "
            + BankAccess.Name(giving, chosen.Bank.Quantity) + ". Each counts as " + GroundsService.Amount(worthEach) + ". "
            + max.ToString("N0") + " is the most this task can still use from you."))));

        Label total = Text("");
        void Refresh() => total.Text = "Adds " + GroundsService.Amount(Math.Min(left, _donateQty * worthEach)) + " of the "
            + GroundsService.Amount(left) + " still needed.";
        _page.AddChild(Row(Short("How many"), Number("The quantity", 1, max, _donateQty, v =>
        {
            _donateQty = (int)v;
            Refresh();
        }), Grow(total)));
        Refresh();

        Button give = Confirm("Donate (cannot be undone)", "TexturedActionButtonGreen8x", () =>
        {
            if (!CommitNumbers()) return;
            grounds.Donate(game, guild.Id, task, giving, _donateQty);
            _donateItem = null;
            RebuildMarket();
        });
        give.Disabled = grounds.Busy;
        Button other = Action("Pick something else", "TexturedButton8x", () =>
        {
            _donateItem = null;
            RebuildMarket();
        });
        give.CustomMinimumSize = new Vector2(250, 36);
        other.CustomMinimumSize = new Vector2(190, 36);
        _page.AddChild(Row(give, other));
        _page.AddChild(back);
    }
}
