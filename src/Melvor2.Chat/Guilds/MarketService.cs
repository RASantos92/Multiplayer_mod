using System.Text.Json;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Data.Items;
using Godot;
using Melvor2.Chat.GameState;

namespace Melvor2.Chat.Guilds;

internal sealed record MarketListing(string Id, string Item, long Qty, long Price, long Value, string SellerId, string SellerName);

internal sealed record MarketOffer(string Id, string ListingId, string Item, long Qty, long Price, string BuyerId, string BuyerName, string SellerId);

/// <summary>Something the server is holding for me until my game has applied it: see <see cref="MarketService"/>.</summary>
internal sealed record MarketClaim(string Id, string Kind, string Item, long Qty, long Gold, string Other, string Reason);

/// <summary>
/// The guild marketplace: listings, offers, and the movement of items and gold in and out of the bank.
///
/// The server is the ledger and cannot see anyone's bank, so each game applies its own half:
///   - Selling: take the items out of the bank and save, then register the listing. A rejected listing puts
///     the items back.
///   - Everything that comes back to me is a "claim": a purchase (pay gold, get items), a payout (get gold) or
///     a return (get unsold items back). A claim is applied to the bank in one all-or-nothing step, the save is
///     written, the claim id is noted in a local journal, and only then is the server told. A claim the server
///     sends again (because the reply was lost, or the game closed) is recognised from the journal and not
///     applied twice.
///
/// Bank changes only happen from <see cref="Tick"/>, which the mod calls on the main thread with the game when
/// it is safe to touch (not on menus, not during offline progress).
/// </summary>
internal sealed class MarketService
{
    public const int MinPercent = 80;
    public const int MaxPercent = 120;

    private static readonly string s_dir = Path.Combine(OS.GetUserDataDir(), "mod-data");
    private static readonly string s_file = Path.Combine(s_dir, "market-journal.json");

    /// <summary>Items already taken out of the bank for a listing the server has not confirmed yet.</summary>
    private sealed class PendingListing
    {
        public string Nonce = "";
        public string GuildId = "";
        public string Item = "";
        public int Qty;
        public long Price;
        public long Value;
        public bool Refund;      // The server said no: put the items back.
        public bool InFlight;
        public DateTime RetryAt;
    }

    private readonly GuildService _guilds;
    private readonly Dictionary<string, MarketClaim> _claims = new();
    private readonly HashSet<string> _confirming = new();
    private readonly Dictionary<string, DateTime> _retryAfter = new();
    private readonly List<PendingListing> _pending = new();
    private readonly List<string> _applied = new();
    private readonly Dictionary<string, long> _loadedRev = new();
    private readonly Dictionary<string, long> _serverRev = new();
    private readonly HashSet<string> _loading = new();

    public Dictionary<string, List<MarketListing>> Listings { get; } = new();
    public Dictionary<string, List<MarketOffer>> Offers { get; } = new();

    /// <summary>True while a request the player started is on its way, so buttons can be disabled.</summary>
    public bool Busy { get; private set; }

    /// <summary>Raised on the main thread when listings or offers change.</summary>
    public event Action? Changed;

    /// <summary>A line for the player: a sale, a purchase, or why something did not work.</summary>
    public event Action<string>? Notice;

    public MarketService(GuildService guilds)
    {
        _guilds = guilds;
        guilds.Synced += OnSynced;
        LoadJournal();
    }

    /// <summary>The lowest and highest price allowed for an item worth this much: 80% to 120%, whole gold.</summary>
    public static (long Min, long Max) PriceRange(long value)
    {
        long min = Math.Max(1, (value * MinPercent + 99) / 100);
        return (min, Math.Max(min, value * MaxPercent / 100));
    }

    /// <summary>Why this bank item cannot be listed, or null if it can.</summary>
    public static string? WhyNotSellable(BankItem item) =>
        item.Locked ? "This item is locked in your bank."
        : item.Value <= 0 ? "This item has no gold value, so it cannot be priced."
        : null;

    /// <summary>
    /// A listing is only shown and buyable if this game knows the item and the price obeys the rule against
    /// this game's own value for it, whatever the seller's game claimed.
    /// </summary>
    public static bool IsValid(Game game, MarketListing listing, out Item? item)
    {
        item = BankAccess.FindItem(game, listing.Item);
        if (item == null) return false;
        long value = BankAccess.ValueOf(item);
        if (value <= 0) return false;
        (long min, long max) = PriceRange(value);
        return listing.Price >= min && listing.Price <= max && listing.Qty > 0;
    }

    // ---- reading the market ----

    public bool NeedsLoad(string guildId) =>
        !_loadedRev.TryGetValue(guildId, out long loaded) || (_serverRev.TryGetValue(guildId, out long server) && server != loaded);

    public void Load(string guildId, bool force = false)
    {
        if (!_guilds.Enabled || _loading.Contains(guildId) || (!force && !NeedsLoad(guildId))) return;
        _loading.Add(guildId);
        GuildApi.Get($"/guilds/{guildId}/market", result =>
        {
            _loading.Remove(guildId);
            if (!result.Ok)
            {
                if (result.Status != 403 && result.Status != 404) Notice?.Invoke(result.ErrorMessage);
                return;
            }
            long rev = result.Body.Long("rev");
            _loadedRev[guildId] = rev;
            if (!_serverRev.TryGetValue(guildId, out long known) || known < rev) _serverRev[guildId] = rev;
            Listings[guildId] = result.Body.Items("listings").Select(l => new MarketListing(l.Str("id"), l.Str("item"), l.Long("qty"),
                l.Long("price"), l.Long("value"), l.Str("sellerId"), l.Str("sellerName"))).ToList();
            Offers[guildId] = result.Body.Items("offers").Select(o => new MarketOffer(o.Str("id"), o.Str("listingId"), o.Str("item"),
                o.Long("qty"), o.Long("price"), o.Str("buyerId"), o.Str("buyerName"), o.Str("sellerId"))).ToList();
            Changed?.Invoke();
        });
    }

    private void OnSynced(JsonElement body)
    {
        foreach (JsonElement guild in body.Items("guilds")) _serverRev[guild.Str("id")] = guild.Long("marketRev");
        foreach (JsonElement c in body.Items("claims")) AddClaim(c);
    }

    private void AddClaim(JsonElement c)
    {
        string id = c.Str("id");
        if (id.Length == 0) return;
        _claims[id] = new MarketClaim(id, c.Str("kind"), c.Str("item"), c.Long("qty"), c.Long("gold"), c.Str("other"), c.Str("reason"));
    }

    // ---- actions the player takes ----

    /// <summary>Takes the items out of the bank now and lists them. Main thread, with the game.</summary>
    public void Sell(Game game, string guildId, Item item, int qty, long price)
    {
        long value = BankAccess.ValueOf(item);
        (long min, long max) = PriceRange(value);
        if (value <= 0 || price < min || price > max || qty < 1)
        {
            Notice?.Invoke("The price must be between " + min + " and " + max + " gold each.");
            return;
        }
        BankItem? owned = BankAccess.Items(game).FirstOrDefault(i => i.Item == item);
        if (owned == null || owned.Quantity < qty)
        {
            Notice?.Invoke("You do not have that many in your bank.");
            return;
        }
        string? blocked = WhyNotSellable(owned);
        if (blocked != null)
        {
            Notice?.Invoke(blocked);
            return;
        }

        string? error = BankAccess.Exchange(game, null, 0, item, qty, 0, 0);
        if (error != null)
        {
            Notice?.Invoke(error);
            return;
        }
        // Saved and journalled before the server hears about it: from here on the items are either listed
        // or put back, even if the game closes right now.
        BankAccess.SaveNow(game);
        var pending = new PendingListing { Nonce = Guid.NewGuid().ToString("N"), GuildId = guildId, Item = item.Id, Qty = qty, Price = price, Value = value };
        _pending.Add(pending);
        SaveJournal();
        Notice?.Invoke("Listing " + qty + " " + BankAccess.Name(item, qty) + "...");
        Submit(pending);
    }

    private void Submit(PendingListing pending)
    {
        pending.InFlight = true;
        string body = Json.Obj(w =>
        {
            w.WriteString("item", pending.Item);
            w.WriteNumber("qty", pending.Qty);
            w.WriteNumber("price", pending.Price);
            w.WriteNumber("value", pending.Value);
            w.WriteString("nonce", pending.Nonce);
        });
        GuildApi.Post($"/guilds/{pending.GuildId}/market", body, result =>
        {
            pending.InFlight = false;
            if (result.Ok)
            {
                _pending.Remove(pending);
                SaveJournal();
                Notice?.Invoke("Listed on the marketplace.");
                Load(pending.GuildId, force: true);
            }
            else if (result.Status is >= 400 and < 500 && result.Status != 429 && result.Status != 408)
            {
                // A clear "no" (not a member any more, too many listings...): the items go back.
                pending.Refund = true;
                SaveJournal();
                Notice?.Invoke(result.ErrorMessage + " Your items are being returned.");
            }
            else
            {
                // No answer, or the server is busy: unknown whether it was listed. The same request is sent
                // again later; its id makes the server treat a repeat as the same listing.
                pending.RetryAt = DateTime.UtcNow.AddSeconds(30);
                Notice?.Invoke("Could not reach the guild server. The listing will be retried.");
            }
        });
    }

    public void Cancel(string guildId, string listingId) =>
        Run("DELETE", $"/guilds/{guildId}/market/{listingId}", null, guildId, "Listing cancelled. Your items are on their way back.");

    /// <summary>Buys at the asking price. The items arrive, and the gold leaves, when the claim is applied.</summary>
    public void Buy(Game game, string guildId, MarketListing listing, int qty)
    {
        if (!CanAfford(game, listing, qty, listing.Price, out string reason))
        {
            Notice?.Invoke(reason);
            return;
        }
        string body = Json.Obj(w =>
        {
            w.WriteNumber("qty", qty);
            w.WriteNumber("price", listing.Price);
        });
        Busy = true;
        GuildApi.Post($"/guilds/{guildId}/market/{listing.Id}/buy", body, result =>
        {
            Busy = false;
            if (result.Ok && result.Body.Child("claim") is JsonElement claim) AddClaim(claim);
            else Notice?.Invoke(result.ErrorMessage);
            Load(guildId, force: true);
            Changed?.Invoke();
        });
    }

    public void MakeOffer(Game game, string guildId, MarketListing listing, int qty, long price)
    {
        if (!CanAfford(game, listing, qty, price, out string reason))
        {
            Notice?.Invoke(reason);
            return;
        }
        string body = Json.Obj(w =>
        {
            w.WriteNumber("qty", qty);
            w.WriteNumber("price", price);
        });
        Run("POST", $"/guilds/{guildId}/market/{listing.Id}/offers", body, guildId, "Offer sent. The seller has 48 hours to answer.");
    }

    public void Withdraw(string guildId, string offerId) =>
        Run("DELETE", $"/guilds/{guildId}/offers/{offerId}", null, guildId, "Offer withdrawn.");

    public void Answer(string guildId, string offerId, bool accept) =>
        Run("POST", $"/guilds/{guildId}/offers/{offerId}", accept ? "{\"accept\":true}" : "{\"accept\":false}", guildId,
            accept ? "Offer accepted. You are paid once the buyer's game has paid." : "Offer declined.");

    private static bool CanAfford(Game game, MarketListing listing, int qty, long price, out string reason)
    {
        reason = "";
        if (!IsValid(game, listing, out _))
        {
            reason = "This listing is not valid in your game.";
            return false;
        }
        if (qty < 1 || qty > listing.Qty)
        {
            reason = "Only " + listing.Qty + " are available.";
            return false;
        }
        if (BankAccess.GoldBalance(game) < qty * price)
        {
            reason = "You do not have enough gold (" + (qty * price).ToString("N0") + " needed).";
            return false;
        }
        return true;
    }

    private void Run(string method, string path, string? json, string guildId, string success)
    {
        Busy = true;
        GuildApi.Send(method, path, json, result =>
        {
            Busy = false;
            Notice?.Invoke(result.Ok ? success : result.ErrorMessage);
            Load(guildId, force: true);
            Changed?.Invoke();
        });
    }

    // ---- applying things to the bank ----

    /// <summary>Main thread, a couple of times a second. <paramref name="game"/> is null when the bank must not be touched.</summary>
    public void Tick(Game? game)
    {
        if (game == null || !_guilds.Enabled) return;
        DateTime now = DateTime.UtcNow;

        foreach (PendingListing pending in _pending.ToList())
        {
            if (pending.InFlight) continue;
            if (pending.Refund)
            {
                Item? item = BankAccess.FindItem(game, pending.Item);
                string? error = item == null ? null : BankAccess.Exchange(game, item, pending.Qty, null, 0, 0, 0);
                if (error != null) continue; // Bank full: try again on a later tick.
                BankAccess.SaveNow(game);
                _pending.Remove(pending);
                SaveJournal();
            }
            else if (now >= pending.RetryAt)
            {
                Submit(pending);
            }
        }

        foreach (MarketClaim claim in _claims.Values.ToList())
        {
            if (_confirming.Contains(claim.Id)) continue;
            if (_retryAfter.TryGetValue(claim.Id, out DateTime after) && now < after) continue;
            Apply(game, claim);
        }
    }

    private void Apply(Game game, MarketClaim claim)
    {
        // Already applied in an earlier session, or the confirmation never arrived: only tell the server.
        if (_applied.Contains(claim.Id))
        {
            Confirm(claim);
            return;
        }

        Item? item = claim.Item.Length == 0 ? null : BankAccess.FindItem(game, claim.Item);
        int qty = (int)Math.Clamp(claim.Qty, 0, int.MaxValue);
        string name = item == null ? claim.Item : BankAccess.Name(item, qty);
        string? error;
        string done;
        switch (claim.Kind)
        {
            case "purchase":
                error = item == null ? "Your game does not have this item." : BankAccess.Exchange(game, item, qty, null, 0, 0, claim.Gold);
                done = "Bought " + qty.ToString("N0") + " " + name + " from " + claim.Other + " for " + claim.Gold.ToString("N0") + " gold.";
                if (error != null)
                {
                    Fail(claim, "Purchase cancelled: " + error);
                    return;
                }
                break;
            case "payout":
                error = BankAccess.Exchange(game, null, 0, null, 0, claim.Gold, 0);
                done = "Sold " + qty.ToString("N0") + " " + name + " to " + claim.Other + " for " + claim.Gold.ToString("N0") + " gold.";
                break;
            case "return":
                error = item == null ? "Your game does not have this item." : BankAccess.Exchange(game, item, qty, null, 0, 0, 0);
                done = qty.ToString("N0") + " " + name + " returned from the marketplace" + claim.Reason switch
                {
                    "expired" => " (the listing ran out after 14 days).",
                    "left_guild" => " (you are no longer in that guild).",
                    "guild_disbanded" => " (the guild was disbanded).",
                    "unsold" => " (a buyer could not complete the purchase).",
                    _ => ".",
                };
                break;
            default:
                return; // A kind from a newer version: leave it for a newer mod.
        }

        if (error != null)
        {
            // Usually a full bank. The claim stays on the server; try again in a minute.
            if (!_retryAfter.ContainsKey(claim.Id)) Notice?.Invoke("Could not collect " + name + " from the marketplace: " + error);
            _retryAfter[claim.Id] = DateTime.UtcNow.AddSeconds(60);
            return;
        }

        BankAccess.SaveNow(game);
        _applied.Add(claim.Id);
        if (_applied.Count > 500) _applied.RemoveRange(0, _applied.Count - 500);
        SaveJournal();
        Notice?.Invoke(done);
        Confirm(claim);
    }

    private void Confirm(MarketClaim claim)
    {
        _confirming.Add(claim.Id);
        GuildApi.Post($"/claims/{claim.Id}/confirm", "{}", result =>
        {
            _confirming.Remove(claim.Id);
            // 404/409: the server no longer has it as pending, so there is nothing left to do either way.
            if (result.Ok || result.Status is 404 or 409) _claims.Remove(claim.Id);
            else _retryAfter[claim.Id] = DateTime.UtcNow.AddSeconds(15);
        });
    }

    private void Fail(MarketClaim claim, string message)
    {
        _confirming.Add(claim.Id);
        Notice?.Invoke(message);
        GuildApi.Post($"/claims/{claim.Id}/fail", "{}", result =>
        {
            _confirming.Remove(claim.Id);
            if (result.Ok || result.Status is 404 or 409) _claims.Remove(claim.Id);
            else _retryAfter[claim.Id] = DateTime.UtcNow.AddSeconds(15);
        });
    }

    // ---- journal ----

    private void LoadJournal()
    {
        try
        {
            if (!File.Exists(s_file)) return;
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(s_file));
            foreach (JsonElement id in doc.RootElement.Items("applied"))
            {
                if (id.ValueKind == JsonValueKind.String) _applied.Add(id.GetString()!);
            }
            foreach (JsonElement p in doc.RootElement.Items("pending"))
            {
                _pending.Add(new PendingListing
                {
                    Nonce = p.Str("nonce"), GuildId = p.Str("guild"), Item = p.Str("item"), Qty = (int)p.Long("qty"),
                    Price = p.Long("price"), Value = p.Long("value"), Refund = p.Long("refund") == 1,
                });
            }
        }
        catch (Exception e)
        {
            ModEntry.Log("Could not read the market journal: " + e.Message);
        }
    }

    private void SaveJournal()
    {
        try
        {
            Directory.CreateDirectory(s_dir);
            string json = Json.Obj(w =>
            {
                w.WriteStartArray("applied");
                foreach (string id in _applied) w.WriteStringValue(id);
                w.WriteEndArray();
                w.WriteStartArray("pending");
                foreach (PendingListing p in _pending)
                {
                    w.WriteStartObject();
                    w.WriteString("nonce", p.Nonce);
                    w.WriteString("guild", p.GuildId);
                    w.WriteString("item", p.Item);
                    w.WriteNumber("qty", p.Qty);
                    w.WriteNumber("price", p.Price);
                    w.WriteNumber("value", p.Value);
                    w.WriteNumber("refund", p.Refund ? 1 : 0);
                    w.WriteEndObject();
                }
                w.WriteEndArray();
            });
            // Write beside, then swap, so a crash never leaves half a journal.
            string temp = s_file + ".tmp";
            File.WriteAllText(temp, json);
            File.Move(temp, s_file, overwrite: true);
        }
        catch (Exception e)
        {
            ModEntry.Log("Could not write the market journal: " + e.Message);
        }
    }
}
