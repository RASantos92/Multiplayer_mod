using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Data.Items;
using Godot;
using Melvor2.Chat.GameState;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat;

/// <summary>
/// The Marketplace tab of the Guild window: a table of what guild mates are selling (item, price, seller,
/// buy), a panel to buy or make a lower offer, a form to list something from the bank, and the offers waiting
/// on either side. All state that must survive a rebuild of the page lives in fields here.
/// </summary>
internal sealed partial class GuildWindow
{
    private readonly List<(SpinBox Box, string What)> _numbers = new();
    private bool _market;
    private Button _marketButton = null!;
    private double _sinceMarket;

    private string? _buyListingId;
    private int _buyQty = 1;
    private long _offerPrice;

    private bool _selling;
    private string _sellSearch = "";
    /// <summary>The category tab chosen in the sell form: a bank tag id, Other, All, or null for the first tab.</summary>
    private string? _sellCategory;
    private const string OtherCategory = "#other";
    private const string AllCategories = "#all";
    private string? _sellItemId;
    private int _sellQty = 1;
    private long _sellPrice;

    /// <summary>Opens the window on the sell form for one bank item (from the button in the bank).</summary>
    public void OpenSell(string itemId)
    {
        if (!GodotObject.IsInstanceValid(_backdrop)) return;
        if (!IsOpen) Open();
        if (_guildId == null || _service.Find(_guildId) == null)
        {
            _status.Text = "Join or create a guild to use its marketplace.";
            return;
        }
        Game? game = ModEntry.CurrentGame();
        Item? item = game == null ? null : BankAccess.FindItem(game, itemId);
        _mode = Mode.Guild;
        _selling = true;
        _buyListingId = null;
        _sellItemId = itemId;
        _sellQty = 1;
        _sellPrice = item == null ? 0 : BankAccess.ValueOf(item);
        _marketButton.SetPressedNoSignal(true);
        _backdrop.GetViewport()?.GuiReleaseFocus();
        OpenMarketTab();
    }

    private void OpenMarketTab()
    {
        _manage = false;
        _grounds = false;
        _market = true;
        _sinceMarket = 0;
        if (_guildId != null) ModEntry.Market?.Load(_guildId, force: true);
        RebuildPage();
    }

    /// <summary>While the tab is showing, pick up changes other players make.</summary>
    private void TickMarket(double delta)
    {
        if (!_market || _guildId == null) return;
        _sinceMarket += delta;
        if (_sinceMarket < 2) return;
        _sinceMarket = 0;
        ModEntry.Market?.Load(_guildId);
    }

    /// <summary>Rebuild now, even if a number box in the tab still has the keyboard focus.</summary>
    private void RebuildMarket()
    {
        _backdrop.GetViewport()?.GuiReleaseFocus();
        RebuildPage();
    }

    private void BuildMarket(GuildInfo guild)
    {
        MarketService? market = ModEntry.Market;
        Game? game = ModEntry.CurrentGame();
        if (market == null || game == null)
        {
            _page.AddChild(Text("The marketplace is available while your save is loaded and the game is running."));
            return;
        }
        market.Load(guild.Id);
        _numbers.Clear();
        Texture2D? coin = BankAccess.Gold(game)?.Icon;

        Label purse = Text("Your gold: " + BankAccess.GoldBalance(game).ToString("N0"));
        Button sell = Action(_selling ? "Back to the market" : "Sell an item", _selling ? "TexturedButton8x" : "TexturedActionButtonGreen8x", () =>
        {
            _selling = !_selling;
            _sellItemId = null;
            _buyListingId = null;
            RebuildMarket();
        });
        sell.CustomMinimumSize = new Vector2(170, 36);
        _page.AddChild(Row(IconRect(coin, 20), Grow(purse), sell));

        if (_selling)
        {
            BuildSellForm(game, guild, market, coin);
            return;
        }

        List<MarketListing> all = market.Listings.TryGetValue(guild.Id, out List<MarketListing>? found) ? found : new List<MarketListing>();
        var shown = new List<(MarketListing Listing, Item Item)>();
        foreach (MarketListing listing in all)
        {
            if (MarketService.IsValid(game, listing, out Item? item) && item != null) shown.Add((listing, item));
        }

        (MarketListing Listing, Item Item) buying = shown.FirstOrDefault(s => s.Listing.Id == _buyListingId);
        if (buying.Listing != null) BuildBuyPanel(game, guild, market, buying.Listing, buying.Item, coin);
        else _buyListingId = null;

        BuildOffers(game, guild, market, all);

        _page.AddChild(Heading("For sale"));
        if (shown.Count == 0)
        {
            _page.AddChild(Text(market.NeedsLoad(guild.Id) ? "Loading..." : "Nothing is for sale yet. Be the first: click Sell an item."));
            return;
        }

        var table = new GridContainer { Columns = 4, SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
        table.AddThemeConstantOverride("h_separation", 14);
        table.AddThemeConstantOverride("v_separation", 6);
        foreach (string title in new[] { "Item", "Price each", "Seller", "" })
        {
            Label head = Short(title);
            head.Modulate = new Color(0.75f, 0.72f, 0.66f);
            table.AddChild(head);
        }

        foreach ((MarketListing listing, Item item) in shown)
        {
            bool mine = listing.SellerId == _service.SteamId;
            int qty = (int)Math.Min(listing.Qty, int.MaxValue);

            Label name = Text(BankAccess.Name(item, qty) + "  x" + listing.Qty.ToString("N0"));
            name.ClipText = true;
            name.AutowrapMode = TextServer.AutowrapMode.Off;
            Control itemCell = Row(IconRect(item.Icon, 28), Grow(name));
            itemCell.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
            table.AddChild(itemCell);

            long value = BankAccess.ValueOf(item);
            Control price = Row(IconRect(coin, 18), Short(listing.Price.ToString("N0")));
            price.TooltipText = "The game values this at " + value.ToString("N0") + " gold. Prices can be 80% to 120% of that.";
            price.MouseFilter = Control.MouseFilterEnum.Stop;
            table.AddChild(price);

            table.AddChild(Short(mine ? "You" : listing.SellerName));

            string id = listing.Id;
            Button action = mine
                ? Confirm("Cancel", "TexturedButtonCancel8x", () => market.Cancel(guild.Id, id))
                : Action("Buy", "TexturedActionButtonGreen8x", () =>
                {
                    _buyListingId = id;
                    _buyQty = 1;
                    _offerPrice = Math.Max(MarketService.PriceRange(value).Min, listing.Price - 1);
                    RebuildMarket();
                });
            action.CustomMinimumSize = new Vector2(mine ? 170 : 90, 32);
            action.Disabled = market.Busy;
            table.AddChild(action);
        }
        _page.AddChild(table);
    }

    private void BuildBuyPanel(Game game, GuildInfo guild, MarketService market, MarketListing listing, Item item, Texture2D? coin)
    {
        long gold = BankAccess.GoldBalance(game);
        int most = (int)Math.Min(listing.Qty, int.MaxValue);
        _buyQty = Math.Clamp(_buyQty, 1, most);
        (long min, _) = MarketService.PriceRange(BankAccess.ValueOf(item));
        bool canHaggle = min < listing.Price;
        _offerPrice = canHaggle ? Math.Clamp(_offerPrice, min, listing.Price - 1) : listing.Price;

        var box = new VBoxContainer();
        box.AddThemeConstantOverride("separation", 6);
        box.AddChild(Heading("Buy " + BankAccess.Name(item, 2) + " from " + listing.SellerName));

        Label total = Text("");
        Label offerTotal = Text("");
        Button buy = Action("Buy now", "TexturedActionButtonGreen8x", () =>
        {
            if (!CommitNumbers()) return;
            market.Buy(game, guild.Id, listing, _buyQty);
            _buyListingId = null;
            RebuildMarket();
        });
        buy.CustomMinimumSize = new Vector2(130, 36);
        Button offer = Action("Make offer", "TexturedButton8x", () =>
        {
            if (!CommitNumbers()) return;
            market.MakeOffer(game, guild.Id, listing, _buyQty, _offerPrice);
            _buyListingId = null;
            RebuildMarket();
        });
        offer.CustomMinimumSize = new Vector2(130, 36);

        void Refresh()
        {
            long cost = _buyQty * listing.Price;
            total.Text = "Total " + cost.ToString("N0") + " gold";
            buy.Disabled = market.Busy || cost > gold;
            buy.TooltipText = cost > gold ? "You do not have enough gold." : "Pay now and receive the items straight away.";
            long bid = _buyQty * _offerPrice;
            offerTotal.Text = "Total " + bid.ToString("N0") + " gold if accepted";
            offer.Disabled = market.Busy || bid > gold;
        }

        SpinBox quantity = Number("The quantity", 1, most, _buyQty, v =>
        {
            _buyQty = (int)v;
            Refresh();
        });
        box.AddChild(Row(Short("How many (of " + listing.Qty.ToString("N0") + ")"), quantity, IconRect(coin, 18),
            Short(listing.Price.ToString("N0") + " each"), Grow(total), buy));

        if (canHaggle)
        {
            SpinBox bidBox = Number("Your offer", min, listing.Price - 1, _offerPrice, v =>
            {
                _offerPrice = (long)v;
                Refresh();
            });
            box.AddChild(Row(Short("Or offer less, each"), bidBox, Short("(" + min.ToString("N0") + " to " + (listing.Price - 1).ToString("N0") + ")"),
                Grow(offerTotal), offer));
            box.AddChild(Text("The seller has 48 hours to accept or decline. If they accept, you pay and get the items automatically."));
        }
        else
        {
            box.AddChild(Text("This is already the lowest price allowed for this item, so there is nothing to haggle."));
        }

        Button close = Action("Close", "TexturedButton8x", () =>
        {
            _buyListingId = null;
            RebuildMarket();
        });
        close.CustomMinimumSize = new Vector2(110, 32);
        close.SizeFlagsHorizontal = Control.SizeFlags.ShrinkEnd;
        box.AddChild(close);
        box.AddChild(new HSeparator());
        Refresh();
        _page.AddChild(box);
    }

    private void BuildOffers(Game game, GuildInfo guild, MarketService market, List<MarketListing> listings)
    {
        if (!market.Offers.TryGetValue(guild.Id, out List<MarketOffer>? offers) || offers.Count == 0) return;
        string me = _service.SteamId;

        string Describe(MarketOffer offer)
        {
            Item? item = BankAccess.FindItem(game, offer.Item);
            int qty = (int)Math.Min(offer.Qty, int.MaxValue);
            string name = item == null ? LocalId(offer.Item) : BankAccess.Name(item, qty);
            MarketListing? listing = listings.FirstOrDefault(l => l.Id == offer.ListingId);
            return offer.Qty.ToString("N0") + " " + name + " at " + offer.Price.ToString("N0") + " each ("
                + (offer.Qty * offer.Price).ToString("N0") + " gold"
                + (listing == null ? ")" : ", you asked " + listing.Price.ToString("N0") + " each)");
        }

        List<MarketOffer> toMe = offers.Where(o => o.SellerId == me).ToList();
        if (toMe.Count > 0)
        {
            _page.AddChild(Heading("Offers on your listings"));
            foreach (MarketOffer offer in toMe)
            {
                string id = offer.Id;
                Button accept = Action("Accept", "TexturedActionButtonGreen8x", () => market.Answer(guild.Id, id, true));
                Button decline = Action("Decline", "TexturedButtonCancel8x", () => market.Answer(guild.Id, id, false));
                accept.CustomMinimumSize = decline.CustomMinimumSize = new Vector2(100, 32);
                accept.Disabled = decline.Disabled = market.Busy;
                _page.AddChild(Row(Grow(Text(offer.BuyerName + " offers to buy " + Describe(offer))), accept, decline));
            }
        }

        List<MarketOffer> fromMe = offers.Where(o => o.BuyerId == me).ToList();
        if (fromMe.Count > 0)
        {
            _page.AddChild(Heading("Your offers"));
            foreach (MarketOffer offer in fromMe)
            {
                string id = offer.Id;
                Button withdraw = Action("Withdraw", "TexturedButtonCancel8x", () => market.Withdraw(guild.Id, id));
                withdraw.CustomMinimumSize = new Vector2(110, 32);
                withdraw.Disabled = market.Busy;
                string text = Describe(offer);
                int cut = text.IndexOf(", you asked", StringComparison.Ordinal);
                _page.AddChild(Row(Grow(Text("Waiting for the seller: " + (cut < 0 ? text : text.Substring(0, cut) + ")"))), withdraw));
            }
        }
    }

    private void BuildSellForm(Game game, GuildInfo guild, MarketService market, Texture2D? coin)
    {
        List<BankItem> bank = BankAccess.Items(game);
        BankItem? chosen = _sellItemId == null ? null : bank.FirstOrDefault(b => b.Item.Id == _sellItemId);

        if (chosen == null)
        {
            _sellItemId = null;
            _page.AddChild(Heading("Sell an item"));
            _page.AddChild(Text("Pick a category, then an item from your bank. It leaves your bank when you list it and comes back if you cancel or it does not sell in 14 days. "
                + "You can also select an item in the bank and click Sell on guild market there."));
            _page.AddChild(Input(_sellSearch, "Search your bank", 40, value =>
            {
                _sellSearch = value;
                _rebuildPending = true; // Refreshes the list as soon as the box loses focus; see the button below.
            }));
            Button search = Action("Search", "TexturedButton8x", RebuildMarket);
            search.CustomMinimumSize = new Vector2(110, 32);
            search.SizeFlagsHorizontal = Control.SizeFlags.ShrinkBegin;
            _page.AddChild(search);

            string filter = _sellSearch.Trim();
            List<BankItem> sellable = bank.Where(b => MarketService.WhyNotSellable(b) == null).ToList();
            if (sellable.Count == 0)
            {
                _page.AddChild(Text("Nothing in your bank can be sold here. Locked items and items with no gold value are left out."));
                return;
            }

            // One tab per kind of item the game sorts the bank by (its bank tags), then the rest, then everything.
            static IEnumerable<string> TagsOf(BankItem b) => b.Item.BankTags.Select(t => t.BankTag.Id).Distinct();
            var tabs = sellable.SelectMany(b => b.Item.BankTags.Select(t => t.BankTag))
                .GroupBy(t => t.Id)
                .Select(g => (Id: g.Key, Name: g.First().DisplayName.Message, Icon: (Texture2D?)g.First().Icon, Count: sellable.Count(b => TagsOf(b).Contains(g.Key))))
                .OrderBy(t => t.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
            int untagged = sellable.Count(b => b.Item.BankTags.Count == 0);
            if (untagged > 0) tabs.Add((OtherCategory, "Other", null, untagged));
            tabs.Add((AllCategories, "All", null, sellable.Count));
            if (_sellCategory == null || tabs.All(t => t.Id != _sellCategory)) _sellCategory = tabs[0].Id;

            var strip = new HFlowContainer { SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
            strip.AddThemeConstantOverride("h_separation", 4);
            strip.AddThemeConstantOverride("v_separation", 4);
            var group = new ButtonGroup();
            foreach (var tab in tabs)
            {
                string id = tab.Id;
                Button button = TabButton(tab.Name + " (" + tab.Count + ")", group);
                button.CustomMinimumSize = new Vector2(0, 32);
                button.AutoTranslateMode = Node.AutoTranslateModeEnum.Disabled;
                if (tab.Icon != null)
                {
                    button.Icon = tab.Icon;
                    button.ExpandIcon = true;
                    button.AddThemeConstantOverride("icon_max_width", 20);
                }
                button.SetPressedNoSignal(filter.Length == 0 && id == _sellCategory);
                button.Pressed += () =>
                {
                    _sellCategory = id;
                    _sellSearch = "";
                    RebuildMarket();
                };
                strip.AddChild(button);
            }
            _page.AddChild(strip);

            // A search looks in every category.
            string category = _sellCategory;
            List<BankItem> matches = sellable
                .Where(b => filter.Length > 0 ? BankAccess.Name(b.Item).Contains(filter, StringComparison.OrdinalIgnoreCase)
                    : category == AllCategories || (category == OtherCategory ? b.Item.BankTags.Count == 0 : TagsOf(b).Contains(category)))
                .OrderBy(b => BankAccess.Name(b.Item))
                .ToList();
            if (filter.Length > 0) _page.AddChild(Text("Search results for \"" + filter + "\" from every category. Click a category to clear the search."));
            if (matches.Count == 0)
            {
                _page.AddChild(Text("Nothing in your bank matches \"" + filter + "\"."));
                return;
            }

            var grid = new GridContainer { Columns = 2, SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
            grid.AddThemeConstantOverride("h_separation", 8);
            grid.AddThemeConstantOverride("v_separation", 4);
            foreach (BankItem entry in matches.Take(120))
            {
                string id = entry.Item.Id;
                long value = entry.Value;
                Button pick = Action(BankAccess.Name(entry.Item, entry.Quantity) + "  x" + entry.Quantity.ToString("N0") + "   (" + value.ToString("N0") + " gold)",
                    "TexturedButton8x", () =>
                    {
                        _sellItemId = id;
                        _sellQty = 1;
                        _sellPrice = value;
                        RebuildMarket();
                    });
                pick.Icon = entry.Item.Icon;
                pick.ExpandIcon = true;
                pick.AddThemeConstantOverride("icon_max_width", 24);
                pick.Alignment = HorizontalAlignment.Left;
                pick.ClipText = true;
                pick.SizeFlagsHorizontal = Control.SizeFlags.ExpandFill;
                grid.AddChild(pick);
            }
            _page.AddChild(grid);
            if (matches.Count > 120) _page.AddChild(Text("Showing 120 of " + matches.Count + ". Pick a category or search to narrow it down."));
            return;
        }

        (long min, long max) = MarketService.PriceRange(chosen.Value);
        _sellQty = Math.Clamp(_sellQty, 1, chosen.Quantity);
        _sellPrice = Math.Clamp(_sellPrice, min, max);

        _page.AddChild(Heading("Sell " + BankAccess.Name(chosen.Item, 2)));
        _page.AddChild(Row(IconRect(chosen.Item.Icon, 32), Grow(Text("You have " + chosen.Quantity.ToString("N0")
            + ". The game values one at " + chosen.Value.ToString("N0") + " gold, so you can ask " + min.ToString("N0")
            + (min == max ? "" : " to " + max.ToString("N0")) + " gold each."))));

        Label total = Text("");
        void Refresh() => total.Text = "You will receive " + (_sellQty * _sellPrice).ToString("N0") + " gold if it all sells.";

        _page.AddChild(Row(Short("How many"), Number("The quantity", 1, chosen.Quantity, _sellQty, v =>
        {
            _sellQty = (int)v;
            Refresh();
        })));
        SpinBox priceBox = Number("The price", min, max, _sellPrice, v =>
        {
            _sellPrice = (long)v;
            Refresh();
        });
        priceBox.Editable = min != max;
        _page.AddChild(Row(Short("Price each"), priceBox, IconRect(coin, 18)));
        Refresh();
        _page.AddChild(total);

        Item item = chosen.Item;
        Button list = Action("List for sale", "TexturedActionButtonGreen8x", () =>
        {
            if (!CommitNumbers()) return;
            market.Sell(game, guild.Id, item, _sellQty, _sellPrice);
            _selling = false;
            _sellItemId = null;
            RebuildMarket();
        });
        Button back = Action("Pick something else", "TexturedButton8x", () =>
        {
            _sellItemId = null;
            RebuildMarket();
        });
        list.CustomMinimumSize = back.CustomMinimumSize = new Vector2(190, 36);
        _page.AddChild(Row(list, back));
    }

    /// <summary>
    /// A short label for rows and table cells. Unlike Text() it never wraps: a wrapping label with no width
    /// of its own collapses to one letter per line inside a row.
    /// </summary>
    private static Label Short(string text)
    {
        Label label = Text(text);
        label.AutowrapMode = TextServer.AutowrapMode.Off;
        return label;
    }

    /// <summary>A whole-number box. The value is kept by the caller so it survives a rebuild of the page.</summary>
    private SpinBox Number(string what, long min, long max, long value, Action<double> onChanged)
    {
        var box = new SpinBox
        {
            MinValue = min,
            MaxValue = Math.Max(min, max),
            Step = 1,
            Rounded = true,
            Value = Math.Clamp(value, min, Math.Max(min, max)),
            CustomMinimumSize = new Vector2(130, 32),
            SizeFlagsVertical = Control.SizeFlags.ShrinkCenter,
            SelectAllOnFocus = true,
        };
        box.ValueChanged += v => onChanged(v);

        // Typed numbers outside the allowed range turn red straight away, and CommitNumbers refuses them.
        LineEdit edit = box.GetLineEdit();
        edit.TextChanged += text => edit.Modulate = InRange(box, text) ? Colors.White : new Color(1f, 0.45f, 0.4f);
        _numbers.Add((box, what));
        return box;
    }

    private static bool InRange(SpinBox box, string text) =>
        long.TryParse(text.Replace(",", "").Trim(), out long typed) && typed >= box.MinValue && typed <= box.MaxValue;

    /// <summary>
    /// A number box only takes what was typed when Enter is pressed or it loses focus, and the buttons here
    /// do not take focus. So before acting on the numbers: check what is typed in each box, say so if it is
    /// outside the allowed range (the 80% to 120% price rule, or the quantity available), and otherwise
    /// accept it. Returns false when the action must not go ahead.
    /// </summary>
    private bool CommitNumbers()
    {
        foreach ((SpinBox box, string what) in _numbers)
        {
            if (!GodotObject.IsInstanceValid(box)) continue;
            LineEdit edit = box.GetLineEdit();
            if (!InRange(box, edit.Text))
            {
                OnNotice(what + " must be between " + box.MinValue.ToString("N0") + " and " + box.MaxValue.ToString("N0") + ".");
                edit.Text = box.Value.ToString("0");
                edit.Modulate = Colors.White;
                return false;
            }
            box.Apply();
        }
        return true;
    }
}
