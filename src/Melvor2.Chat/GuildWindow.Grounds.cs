using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Data.Items;
using Godot;
using Melvor2.Chat.GameState;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat;

/// <summary>
/// The Guild Grounds tab of the Guild window: the guild's locations, the five tasks at each with a progress
/// bar, the bonus a finished location gives, and a panel to donate items from the bank to a task.
/// </summary>
internal sealed partial class GuildWindow
{
    private static readonly Color s_green = new(0.45f, 0.9f, 0.45f);
    private static readonly Color s_dim = new(0.75f, 0.72f, 0.66f);

    private bool _grounds;
    private Button _groundsButton = null!;
    private double _sinceGrounds;

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

        _page.AddChild(Text("Your guild works on these together. Finish all five tasks at a location and every member gets its bonus. "
            + "Kills, Agility laps and Thieving count as you play, also while the game is closed. Donated items are gone for good."));

        for (int number = 0; number < tiers.Count; number++)
        {
            GroundsTier tier = tiers[number];
            _page.AddChild(Heading("Tier " + (number + 1) + ": " + tier.Name));
            foreach (GroundsLocation location in tier.Locations)
            {
                _page.AddChild(new HSeparator());
                bool known = GroundsBonus.Knows(location.BonusId);
                Label name = Short(location.Name);
                name.AddThemeFontSizeOverride("font_size", 18);
                Label bonus = Short(location.Done
                    ? (known ? "Bonus active: " : "Bonus earned (update the mod to receive it): ") + location.BonusText
                    : "Reward: " + location.BonusText);
                bonus.Modulate = location.Done && known ? s_green : s_dim;
                bonus.HorizontalAlignment = HorizontalAlignment.Right;
                _page.AddChild(Row(name, Grow(bonus)));

                var table = new GridContainer { Columns = 4, SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
                table.AddThemeConstantOverride("h_separation", 12);
                table.AddThemeConstantOverride("v_separation", 4);
                foreach (GroundsTask task in location.Tasks) AddTaskRow(table, grounds, task);
                _page.AddChild(table);
            }
        }
    }

    private void AddTaskRow(GridContainer table, GroundsService grounds, GroundsTask task)
    {
        string givers = task.Top.Count == 0 ? "Nobody has contributed yet."
            : "Top contributors: " + string.Join(", ", task.Top.Select(g => (g.Id == _service.SteamId ? "You" : g.Name) + " " + GroundsService.Amount(g.Amount)))
              + (task.Mine > 0 && task.Top.All(g => g.Id != _service.SteamId) ? ". You " + GroundsService.Amount(task.Mine) : "") + ".";

        Label text = Text(task.Text);
        text.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
        text.TooltipText = givers;
        text.MouseFilter = Control.MouseFilterEnum.Stop;
        if (task.Done) text.Modulate = s_green;
        table.AddChild(text);

        var bar = new ProgressBar
        {
            MinValue = 0,
            MaxValue = Math.Max(1, task.Need),
            Value = Math.Min(task.Have, task.Need),
            ShowPercentage = false,
            CustomMinimumSize = new Vector2(150, 16),
            SizeFlagsVertical = Control.SizeFlags.ShrinkCenter,
            TooltipText = givers,
        };
        table.AddChild(bar);

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
            donate.CustomMinimumSize = new Vector2(96, 30);
            donate.Disabled = grounds.Busy;
            table.AddChild(donate);
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
