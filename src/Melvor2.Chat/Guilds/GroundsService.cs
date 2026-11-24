using System.Text.Json;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Data.Items;
using Godot;
using Melvor2.Chat.GameState;

namespace Melvor2.Chat.Guilds;

internal sealed record GroundsItem(string Item, long Worth);

internal sealed record GroundsGiver(string Id, string Name, long Amount);

/// <summary>One task. Amounts are in units of 1/<see cref="GroundsService.Unit"/>.</summary>
internal sealed record GroundsTask(string Id, string Kind, string Text, long Need, long Have, long Mine,
    List<GroundsItem> Items, List<GroundsGiver> Top, string Stat, List<string> Ids)
{
    public bool Done => Have >= Need;
}

/// <summary>
/// One location. <see cref="Done"/> is true while its bonus is on. <see cref="State"/> is "open" (tasks to do,
/// no bonus), "active" (bonus on, tasks hidden) or "renew" (bonus on, and the tasks are back so the guild can
/// extend it). <see cref="Until"/> is when the bonus ends and <see cref="RenewFrom"/> when the tasks come
/// back, both in server milliseconds, 0 without a bonus.
/// </summary>
internal sealed record GroundsLocation(string Id, string Name, string BonusId, string BonusText, bool Done, List<GroundsTask> Tasks,
    string State, long Until, long RenewFrom);

internal sealed record GroundsTier(string Name, List<GroundsLocation> Locations);

/// <summary>
/// Guild Grounds: the tasks a guild works through together at locations, and the bonus each finished location
/// gives every member for a month.
///
///   - Counting: each task that is done by playing names one of the game's lifetime counters (monsters killed,
///     courses completed, items made by a skill...) and, usually, which monsters, courses or items count. Every
///     few seconds those counters are compared with the last reading kept in a local journal. The difference, which includes anything done
///     while the game was closed, is sent with the next guild sync as a numbered batch. A batch is repeated
///     until the server acknowledges its number, and the server applies each number once.
///   - Donating: the items leave the bank and the save is written, the donation is noted in the journal, and
///     only then is the server told. The server answers how many it accepted; the rest go back into the bank.
///     A donation whose answer never arrived is sent again with the same id.
///   - Bonuses: each sync lists the bonuses of the player's guilds; <see cref="Bonuses"/> holds the best of
///     each for <see cref="GroundsBonus"/> to apply.
///
/// The bank and the counters are only touched from <see cref="Tick"/>, on the main thread, with a game that
/// is safe to touch.
/// </summary>
internal sealed class GroundsService
{
    public const long Unit = 1000;
    private const int MaxBatchEntries = 40;
    private const int CountEveryTicks = 10; // Tick runs twice a second.

    private static readonly string s_dir = Path.Combine(OS.GetUserDataDir(), "mod-data");
    private static readonly string s_file = Path.Combine(s_dir, "grounds-journal-2.json");

    /// <summary>Items already taken out of the bank for a donation the server has not answered yet.</summary>
    private sealed class Gift
    {
        public string Nonce = "";
        public string GuildId = "";
        public string Task = "";
        public string Item = "";
        public int Qty;
        public int Refund;       // Items to put back into the bank.
        public bool Answered;    // The server has answered; only the refund is left.
        public bool InFlight;
        public DateTime RetryAt;
    }

    private sealed class Reading
    {
        public long Xp;
        public Dictionary<string, Dictionary<string, long>> Totals = new();
    }

    private readonly GuildService _guilds;
    private readonly Dictionary<string, Reading> _readings = new();
    private Dictionary<string, Dictionary<string, long>> _unsent = new();

    /// <summary>The counters tasks use: counter id to the object ids that count (null: all of them).</summary>
    private Dictionary<string, HashSet<string>?> _wanted = new();
    private bool _askedForTasks;
    private Dictionary<string, Dictionary<string, long>>? _batch;
    private long _batchSeq;
    private long _lastSeq;
    private readonly List<Gift> _gifts = new();
    private readonly Dictionary<string, long> _loadedRev = new();
    private readonly Dictionary<string, long> _serverRev = new();
    private readonly HashSet<string> _loading = new();
    private int _ticks;
    private string _bonusKey = "";

    public Dictionary<string, List<GroundsTier>> Tiers { get; } = new();

    /// <summary>Bonus id to percent: the best of each bonus across my guilds, as of the last sync.</summary>
    public Dictionary<string, long> Bonuses { get; private set; } = new();

    /// <summary>True while a donation is on its way, so buttons can be disabled.</summary>
    public bool Busy => _gifts.Any(g => g.InFlight);

    /// <summary>Raised on the main thread when progress or bonuses change.</summary>
    public event Action? Changed;

    /// <summary>A line for the player: a donation, or why something did not work.</summary>
    public event Action<string>? Notice;

    public GroundsService(GuildService guilds)
    {
        _guilds = guilds;
        guilds.Synced += OnSynced;
        guilds.ExtraSync = WriteSync;
        LoadJournal();
    }

    private static bool Any(Dictionary<string, Dictionary<string, long>> counts) => counts.Values.Any(c => c.Count > 0);

    /// <summary>"12.5" for 12500 units.</summary>
    public static string Amount(long units) => (units / (double)Unit).ToString(units % Unit == 0 ? "N0" : "N1");

    // ---- reading the grounds ----

    public bool NeedsLoad(string guildId) =>
        !_loadedRev.TryGetValue(guildId, out long loaded) || (_serverRev.TryGetValue(guildId, out long server) && server != loaded);

    public void Load(string guildId, bool force = false)
    {
        if (!_guilds.Enabled || _loading.Contains(guildId) || (!force && !NeedsLoad(guildId))) return;
        _loading.Add(guildId);
        GuildApi.Get($"/guilds/{guildId}/grounds", result =>
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
            Tiers[guildId] = result.Body.Items("tiers").Select(tier => new GroundsTier(tier.Str("name"),
                tier.Items("locations").Select(loc =>
                {
                    JsonElement? bonus = loc.Child("bonus");
                    bool done = loc.TryGetProperty("done", out JsonElement d) && d.ValueKind == JsonValueKind.True;
                    return new GroundsLocation(loc.Str("id"), loc.Str("name"), bonus?.Str("id") ?? "", bonus?.Str("text") ?? "", done,
                        loc.Items("tasks").Select(t => new GroundsTask(t.Str("id"), t.Str("kind"), t.Str("text"), t.Long("need"),
                            t.Long("have"), t.Long("mine"),
                            t.Items("items").Select(i => new GroundsItem(i.Str("item"), i.Long("worth"))).ToList(),
                            t.Items("top").Select(g => new GroundsGiver(g.Str("id"), g.Str("name"), g.Long("amount"))).ToList(),
                            t.Str("stat"),
                            t.TryGetProperty("ids", out JsonElement ids) && ids.ValueKind == JsonValueKind.Array
                                ? ids.EnumerateArray().Where(i => i.ValueKind == JsonValueKind.String).Select(i => i.GetString()!).ToList()
                                : new List<string>())).ToList(),
                        // A server from before 0.7 has no states: finished is finished.
                        loc.Str("state") is { Length: > 0 } state ? state : done ? "active" : "open",
                        loc.Long("until"), loc.Long("renewFrom"));
                }).ToList())).ToList();
            NoteWanted(Tiers[guildId]);
            Changed?.Invoke();
        });
    }

    /// <summary>Remembers which counters the tasks need, so counting also works before the tab is opened.</summary>
    private void NoteWanted(List<GroundsTier> tiers)
    {
        var wanted = new Dictionary<string, HashSet<string>?>();
        foreach (GroundsTask task in tiers.SelectMany(t => t.Locations).SelectMany(l => l.Tasks))
        {
            if (task.Stat.Length == 0) continue;
            if (task.Ids.Count == 0) wanted[task.Stat] = null;
            else if (!wanted.TryGetValue(task.Stat, out HashSet<string>? set)) wanted[task.Stat] = new HashSet<string>(task.Ids);
            else set?.UnionWith(task.Ids);
        }
        string Key(Dictionary<string, HashSet<string>?> w) => string.Join(";", w.OrderBy(x => x.Key, StringComparer.Ordinal)
            .Select(x => x.Key + "=" + (x.Value == null ? "*" : string.Join(",", x.Value.OrderBy(i => i, StringComparer.Ordinal)))));
        if (Key(wanted) == Key(_wanted)) return;
        _wanted = wanted;
        SaveJournal();
    }

    private void OnSynced(JsonElement body)
    {
        // The task list is the same for every guild; fetch it once a session so counting knows what to watch.
        if (!_askedForTasks && _guilds.Guilds.Count > 0)
        {
            _askedForTasks = true;
            Load(_guilds.Guilds[0].Id, force: true);
        }

        var best = new Dictionary<string, long>();
        foreach (JsonElement guild in body.Items("guilds"))
        {
            _serverRev[guild.Str("id")] = guild.Long("groundsRev");
            foreach (JsonElement bonus in guild.Items("bonuses"))
            {
                string id = bonus.Str("id");
                long value = bonus.Long("value");
                if (id.Length > 0 && value > 0 && (!best.TryGetValue(id, out long had) || value > had)) best[id] = value;
            }
        }
        string key = string.Join(";", best.OrderBy(b => b.Key, StringComparer.Ordinal).Select(b => b.Key + "=" + b.Value));
        Bonuses = best;
        if (key != _bonusKey)
        {
            _bonusKey = key;
            Changed?.Invoke();
        }

        if (_batch != null && body.Long("groundsAck") >= _batchSeq)
        {
            _batch = null;
            SaveJournal();
        }
    }

    // ---- counting ----

    /// <summary>Adds the waiting batch of counts to a sync request.</summary>
    private void WriteSync(Utf8JsonWriter w)
    {
        if (_batch == null && Any(_unsent) && _guilds.Guilds.Count > 0)
        {
            // Move what fits into a new numbered batch; the rest waits for the next one.
            _batch = new Dictionary<string, Dictionary<string, long>>();
            int room = MaxBatchEntries;
            foreach ((string stat, Dictionary<string, long> waiting) in _unsent.ToList())
            {
                foreach ((string id, long n) in waiting.ToList())
                {
                    if (room-- <= 0) break;
                    if (!_batch.TryGetValue(stat, out Dictionary<string, long>? into)) _batch[stat] = into = new Dictionary<string, long>();
                    into[id] = n;
                    waiting.Remove(id);
                }
                if (waiting.Count == 0) _unsent.Remove(stat);
            }
            // Numbers only ever go up, also after a reinstall, so the server can tell a repeat from a new batch.
            _batchSeq = Math.Max(_lastSeq + 1, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            _lastSeq = _batchSeq;
            SaveJournal();
        }
        if (_batch == null) return;

        w.WriteStartObject("grounds");
        w.WriteNumber("seq", _batchSeq);
        WriteCounts(w, "counts", _batch);
        w.WriteEndObject();
    }

    private void Count(Game game)
    {
        if (_wanted.Count == 0) return;
        string who = game.CharacterName;
        long xp = GroundsCounter.TotalXp(game);
        if (!_readings.TryGetValue(who, out Reading? last)) _readings[who] = last = new Reading { Xp = xp };

        // Total XP never goes down on one character. If it did, this is another save under the same name, or an
        // older save restored: forget the old readings and start counting from here, crediting nothing.
        if (xp < last.Xp) last.Totals.Clear();
        last.Xp = xp;

        bool changed = false;
        bool inGuild = _guilds.Enabled && _guilds.Guilds.Count > 0;
        foreach ((string stat, HashSet<string>? only) in _wanted)
        {
            Dictionary<string, long>? now = GroundsCounter.Read(game, stat);
            if (now == null) continue;

            // A counter seen for the first time, or one that went backwards, only sets the starting point.
            bool known = last.Totals.TryGetValue(stat, out Dictionary<string, long>? before);
            if (!known || before!.Any(old => (now.TryGetValue(old.Key, out long n) ? n : 0) < old.Value))
            {
                last.Totals[stat] = now;
                changed = true;
                continue;
            }

            foreach ((string id, long total) in now)
            {
                long had = before!.TryGetValue(id, out long old) ? old : 0;
                if (total <= had) continue;
                changed = true;
                // Outside a guild there is nobody to count for, and things no task asks for are not reported.
                if (!inGuild || (only != null && !only.Contains(id))) continue;
                if (!_unsent.TryGetValue(stat, out Dictionary<string, long>? waiting)) _unsent[stat] = waiting = new Dictionary<string, long>();
                waiting[id] = (waiting.TryGetValue(id, out long sofar) ? sofar : 0) + (total - had);
            }
            last.Totals[stat] = now;
        }
        if (changed) SaveJournal();
    }

    // ---- donating ----

    /// <summary>The unlocked bank stacks a task accepts, with what one of each is worth.</summary>
    public static List<(BankItem Bank, long Worth)> Donatable(Game game, GroundsTask task)
    {
        var worth = task.Items.ToDictionary(i => i.Item, i => i.Worth);
        return BankAccess.Items(game)
            .Where(b => !b.Locked && b.Quantity > 0 && worth.ContainsKey(b.Item.Id))
            .Select(b => (b, worth[b.Item.Id]))
            .OrderByDescending(x => x.Item2)
            .ToList();
    }

    /// <summary>How many of an item worth <paramref name="worth"/> it takes to finish the task.</summary>
    public static long Needed(GroundsTask task, long worth) => worth <= 0 ? 0 : (Math.Max(0, task.Need - task.Have) + worth - 1) / worth;

    /// <summary>Takes the items out of the bank now and gives them to the guild. Main thread, with the game.</summary>
    public void Donate(Game game, string guildId, GroundsTask task, Item item, int qty)
    {
        BankItem? owned = BankAccess.Items(game).FirstOrDefault(i => i.Item == item);
        if (qty < 1 || owned == null || owned.Quantity < qty)
        {
            Notice?.Invoke("You do not have that many in your bank.");
            return;
        }
        if (owned.Locked)
        {
            Notice?.Invoke("This item is locked in your bank.");
            return;
        }
        if (task.Items.All(i => i.Item != item.Id))
        {
            Notice?.Invoke("That item is not accepted for this task.");
            return;
        }

        string? error = BankAccess.Exchange(game, null, 0, item, qty, 0, 0);
        if (error != null)
        {
            Notice?.Invoke(error);
            return;
        }
        // Saved and journalled before the server hears about it: from here on the items are either donated
        // or put back, even if the game closes right now.
        BankAccess.SaveNow(game);
        var gift = new Gift { Nonce = Guid.NewGuid().ToString("N"), GuildId = guildId, Task = task.Id, Item = item.Id, Qty = qty };
        _gifts.Add(gift);
        SaveJournal();
        Notice?.Invoke("Donating " + qty.ToString("N0") + " " + BankAccess.Name(item, qty) + "...");
        Submit(gift);
        Changed?.Invoke();
    }

    private void Submit(Gift gift)
    {
        gift.InFlight = true;
        string body = Json.Obj(w =>
        {
            w.WriteString("task", gift.Task);
            w.WriteString("item", gift.Item);
            w.WriteNumber("qty", gift.Qty);
            w.WriteString("nonce", gift.Nonce);
        });
        GuildApi.Post($"/guilds/{gift.GuildId}/grounds/donate", body, result =>
        {
            gift.InFlight = false;
            if (result.Ok)
            {
                int accepted = (int)Math.Clamp(result.Body.Long("accepted"), 0, gift.Qty);
                gift.Answered = true;
                gift.Refund = gift.Qty - accepted;
                if (gift.Refund == 0) _gifts.Remove(gift);
                SaveJournal();
                Notice?.Invoke(accepted == gift.Qty ? "Donated. Thank you!"
                    : accepted == 0 ? "That task was already finished. Your items are being returned."
                    : "Donated " + accepted.ToString("N0") + ": that finished the task. The other " + gift.Refund.ToString("N0") + " are being returned.");
                Load(gift.GuildId, force: true);
            }
            else if (result.Status is >= 400 and < 500 && result.Status != 429 && result.Status != 408)
            {
                // A clear "no" (not a member any more, item not accepted...): everything goes back.
                gift.Answered = true;
                gift.Refund = gift.Qty;
                SaveJournal();
                Notice?.Invoke(result.ErrorMessage + " Your items are being returned.");
            }
            else
            {
                // No answer, or the server is busy: unknown whether it was counted. The same request is sent
                // again later; its id makes the server give the same answer.
                gift.RetryAt = DateTime.UtcNow.AddSeconds(30);
                Notice?.Invoke("Could not reach the guild server. The donation will be retried.");
            }
            Changed?.Invoke();
        });
    }

    // ---- the part that touches the game ----

    /// <summary>Main thread, twice a second. <paramref name="game"/> is null when the game must not be touched.</summary>
    public void Tick(Game? game)
    {
        if (game == null) return;

        // Readings are kept up to date even with guilds off, so turning them on later credits nothing old.
        if (++_ticks >= CountEveryTicks)
        {
            _ticks = 0;
            Count(game);
        }
        if (!_guilds.Enabled) return;

        DateTime now = DateTime.UtcNow;
        foreach (Gift gift in _gifts.ToList())
        {
            if (gift.InFlight) continue;
            if (gift.Answered)
            {
                Item? item = BankAccess.FindItem(game, gift.Item);
                string? error = item == null || gift.Refund <= 0 ? null : BankAccess.Exchange(game, item, gift.Refund, null, 0, 0, 0);
                if (error != null) continue; // Bank full: try again on a later tick.
                BankAccess.SaveNow(game);
                _gifts.Remove(gift);
                SaveJournal();
                Changed?.Invoke();
            }
            else if (now >= gift.RetryAt)
            {
                Submit(gift);
            }
        }
    }

    // ---- journal ----

    private static void ReadCounts(JsonElement? from, Dictionary<string, Dictionary<string, long>> into)
    {
        if (from is not JsonElement counts) return;
        foreach (JsonProperty stat in counts.EnumerateObject())
        {
            if (stat.Value.ValueKind != JsonValueKind.Object) continue;
            var entries = new Dictionary<string, long>();
            foreach (JsonProperty entry in stat.Value.EnumerateObject())
            {
                if (entry.Value.ValueKind == JsonValueKind.Number && entry.Value.TryGetInt64(out long n)) entries[entry.Name] = n;
            }
            into[stat.Name] = entries;
        }
    }

    private static void WriteCounts(Utf8JsonWriter w, string name, Dictionary<string, Dictionary<string, long>> counts)
    {
        w.WriteStartObject(name);
        foreach ((string stat, Dictionary<string, long> entries) in counts)
        {
            w.WriteStartObject(stat);
            foreach ((string id, long n) in entries) w.WriteNumber(id, n);
            w.WriteEndObject();
        }
        w.WriteEndObject();
    }

    private void LoadJournal()
    {
        try
        {
            if (!File.Exists(s_file)) return;
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(s_file));
            JsonElement root = doc.RootElement;
            _lastSeq = root.Long("lastSeq");
            _batchSeq = root.Long("batchSeq");
            ReadCounts(root.Child("unsent"), _unsent);
            if (root.Child("batch") is JsonElement batch && _batchSeq > 0)
            {
                _batch = new Dictionary<string, Dictionary<string, long>>();
                ReadCounts(batch, _batch);
            }
            if (root.Child("readings") is JsonElement readings)
            {
                foreach (JsonProperty reading in readings.EnumerateObject())
                {
                    var r = new Reading { Xp = reading.Value.Long("xp") };
                    ReadCounts(reading.Value.Child("totals"), r.Totals);
                    _readings[reading.Name] = r;
                }
            }
            if (root.Child("wanted") is JsonElement wanted)
            {
                foreach (JsonProperty stat in wanted.EnumerateObject())
                {
                    _wanted[stat.Name] = stat.Value.ValueKind == JsonValueKind.Array
                        ? new HashSet<string>(stat.Value.EnumerateArray().Where(i => i.ValueKind == JsonValueKind.String).Select(i => i.GetString()!))
                        : null;
                }
            }
            foreach (JsonElement g in root.Items("gifts"))
            {
                _gifts.Add(new Gift
                {
                    Nonce = g.Str("nonce"), GuildId = g.Str("guild"), Task = g.Str("task"), Item = g.Str("item"),
                    Qty = (int)g.Long("qty"), Refund = (int)g.Long("refund"), Answered = g.Long("answered") == 1,
                });
            }
        }
        catch (Exception e)
        {
            ModEntry.Log("Could not read the grounds journal: " + e.Message);
        }
    }

    private void SaveJournal()
    {
        try
        {
            Directory.CreateDirectory(s_dir);
            string json = Json.Obj(w =>
            {
                w.WriteNumber("lastSeq", _lastSeq);
                w.WriteNumber("batchSeq", _batch == null ? 0 : _batchSeq);
                if (_batch != null) WriteCounts(w, "batch", _batch);
                WriteCounts(w, "unsent", _unsent);
                w.WriteStartObject("readings");
                foreach ((string who, Reading reading) in _readings)
                {
                    w.WriteStartObject(who);
                    w.WriteNumber("xp", reading.Xp);
                    WriteCounts(w, "totals", reading.Totals);
                    w.WriteEndObject();
                }
                w.WriteEndObject();
                w.WriteStartObject("wanted");
                foreach ((string stat, HashSet<string>? only) in _wanted)
                {
                    if (only == null)
                    {
                        w.WriteNull(stat);
                        continue;
                    }
                    w.WriteStartArray(stat);
                    foreach (string id in only) w.WriteStringValue(id);
                    w.WriteEndArray();
                }
                w.WriteEndObject();
                w.WriteStartArray("gifts");
                foreach (Gift g in _gifts)
                {
                    w.WriteStartObject();
                    w.WriteString("nonce", g.Nonce);
                    w.WriteString("guild", g.GuildId);
                    w.WriteString("task", g.Task);
                    w.WriteString("item", g.Item);
                    w.WriteNumber("qty", g.Qty);
                    w.WriteNumber("refund", g.Refund);
                    w.WriteNumber("answered", g.Answered ? 1 : 0);
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
            ModEntry.Log("Could not write the grounds journal: " + e.Message);
        }
    }
}
