using System.Text;
using System.Text.Json;
using Melvor2.Chat.GameState;
using Steamworks;

namespace Melvor2.Chat.Guilds;

internal sealed record GuildInfo(string Id, string Name, string Description, string OwnerId, string Rank);

/// <summary>ActionEntity / ActionTarget are game ids; empty when the member is idle or on an older mod.</summary>
internal sealed record MemberInfo(string Id, string Name, string Rank, long LastSeen, string Skill, long Level,
    string ActionEntity, string ActionTarget, string ActionName,
    string ActionArea = "", long Hp = 0, long MaxHp = 0, long Dps = 0, long CombatLevel = 0, long IntervalMs = 0, long HitPercent = 0)
{
    public bool HasAction => ActionEntity.Length > 0 && ActionTarget.Length > 0;

    /// <summary>True when the member is in a fight and on a mod version that shares health and DPS.</summary>
    public bool HasCombat => MaxHp > 0;
    public string ActionKey => ActionEntity + "|" + ActionTarget;
}

internal sealed record ProfileSkill(string Id, long Level);

internal sealed record ProfileGear(string Slot, string Item, long Quantity);

/// <summary>A guild mate's shared profile. Shared is false when they have not uploaded one (older mod).</summary>
internal sealed record ProfileData(bool Shared, List<ProfileSkill> Skills, List<ProfileGear> Gear, long UpdatedAt);

internal sealed record InviteInfo(string GuildId, string GuildName, string ByName);

internal sealed record PendingInfo(string PlayerId, string Name);

internal sealed record ChatLine(string Id, string GuildId, string PlayerId, string Name, string Body, long At);

internal sealed record SearchHit(string Id, string Name, string Description, long MemberCount);

/// <summary>
/// The player's guild state and every guild action, backed by the guild server. Nothing is sent until the
/// player enables guilds. While enabled it polls /sync, as rarely as it can get away with, because every call
/// costs the person running the server:
///   - every 3 s while a guild screen or guild chat is open and the player is at the keyboard;
///   - every 8 s while sharing a fight, every 15 s while sharing a skill (the bonuses run on leases);
///   - every 15 s for two minutes after my action changes, so a new party forms quickly, and while a guild
///     screen is open but the player has been away for a few minutes;
///   - once a minute otherwise.
/// </summary>
internal sealed class GuildService
{
    private const double FastSync = 3;
    private const double PartySync = 15;
    private const double CombatSync = 8;

    /// <summary>With a guild screen open, how long without input before syncing drops to the party rate.</summary>
    private const double AwaySeconds = 180;

    /// <summary>With a guild screen open, how long without input before syncing drops to the slow rate.</summary>
    private const double GoneSeconds = 900;

    /// <summary>After my action changes, sync at the party rate for this long to find partners quickly.</summary>
    private const double SeekSeconds = 120;

    /// <summary>At most this many guild mates count towards a party.</summary>
    public const int MaxPartners = 4;
    private const double SlowSync = 60;
    private const double ProfileUploadGap = 60;
    private const int MaxLinesPerGuild = 200;

    /// <summary>
    /// A member seen this recently counts as online. It has to cover two slow syncs of theirs plus some slack,
    /// or idle members would flicker offline.
    /// </summary>
    public const long OnlineWindowMs = 150_000;

    private Identity? _identity;
    private string _steamId = "";
    private string? _cursor;
    private double _sinceSync = SlowSync;
    private double _seeking;
    private string _lastActionKey = "";
    private bool _syncSoon;
    private bool _syncing;
    private string _signature = "";
    private readonly HashSet<string> _seenMessages = new();
    private Identity? _awaitingConsent;
    private string _uploadedProfile = "";
    private double _sinceProfileUpload = ProfileUploadGap;

    public bool SteamReady => _steamId.Length > 0;
    public bool Enabled => _identity != null;
    public bool Busy { get; private set; }

    /// <summary>The id tester chat messages arrive under, in place of a guild id.</summary>
    public const string TestersChannel = "testers";

    /// <summary>True once the player has opted in to the tester chat (the server remembers it).</summary>
    public bool Testers { get; private set; }
    public string SteamId => _steamId;

    /// <summary>
    /// True when this PC enabled guilds under an older notice. Nothing is sent until the player accepts the
    /// current one (AcceptConsent).
    /// </summary>
    public bool NeedsConsent => _awaitingConsent != null && _identity == null;

    /// <summary>Supplied by the mod: what the local character is doing right now, or null.</summary>
    public Func<ActivityInfo?>? Activity { get; set; }

    /// <summary>Supplied by the mod: my health, DPS and combat level while fighting, otherwise null.</summary>
    public Func<CombatInfo?>? Combat { get; set; }

    /// <summary>Set by the mod while a guild mate might be sharing my action, so presence stays fresh.</summary>
    public bool Party { get; set; }

    /// <summary>Set by the mod while sharing a fight: health and DPS need to be fresher than skilling.</summary>
    public bool CombatParty { get; set; }

    /// <summary>When the last successful sync finished (local clock, UTC).</summary>
    public DateTime LastSyncUtc { get; private set; }

    /// <summary>Server clock from the last sync, for deciding who is online.</summary>
    public long ServerNow { get; private set; }

    public List<GuildInfo> Guilds { get; } = new();
    public List<InviteInfo> Invites { get; } = new();
    public List<(string GuildId, string GuildName)> MyRequests { get; } = new();
    public Dictionary<string, List<MemberInfo>> Members { get; } = new();
    public Dictionary<string, List<PendingInfo>> JoinRequests { get; } = new();
    public Dictionary<string, List<PendingInfo>> SentInvites { get; } = new();
    public Dictionary<string, List<ChatLine>> Lines { get; } = new();

    /// <summary>Set by the UI: true while the guild window or a guild chat channel is on screen.</summary>
    public bool Active { get; set; }

    /// <summary>Lets another service add its own part to each sync request (Guild Grounds counts).</summary>
    public Action<System.Text.Json.Utf8JsonWriter>? ExtraSync { get; set; }

    /// <summary>Set by the mod: seconds since the player last moved the mouse or pressed anything.</summary>
    public double SinceInput { get; set; }

    /// <summary>Guild list, members, invites or requests changed.</summary>
    public event Action? Changed;

    /// <summary>Raised with the whole reply after every successful sync, for parts of the mod that ride along on it.</summary>
    public event Action<System.Text.Json.JsonElement>? Synced;

    /// <summary>A result or error worth showing the player.</summary>
    public event Action<string>? Notice;

    public event Action<ChatLine>? MessageReceived;

    /// <summary>Call once Steam is initialised. Resumes a previously enabled identity.</summary>
    public void Start()
    {
        _steamId = SteamUser.GetSteamID().m_SteamID.ToString();
        try
        {
            string overrideFile = Path.Combine(Godot.OS.GetUserDataDir(), "mod-data", "server-url.txt");
            if (File.Exists(overrideFile)) GuildApi.BaseUrl = File.ReadAllText(overrideFile).Trim().TrimEnd('/');
        }
        catch (Exception)
        {
            // Optional developer override; ignore problems reading it.
        }

        Identity? saved = Identity.Load(_steamId);
        if (saved == null) return;
        if (saved.Consent >= Identity.CurrentConsent) Register(saved, isNew: false);
        else _awaitingConsent = saved;
    }

    /// <summary>The player accepted the current notice after enabling under an older one.</summary>
    public void AcceptConsent()
    {
        Identity? identity = _awaitingConsent;
        if (identity == null || Busy) return;
        identity.Consent = Identity.CurrentConsent;
        identity.Save();
        _awaitingConsent = null;
        Register(identity, isNew: false);
    }

    public void Tick(double delta)
    {
        if (!Enabled) return;
        _sinceSync += delta;
        _sinceProfileUpload += delta;
        if (_seeking > 0) _seeking -= delta;

        // Starting, stopping or switching an action: tell the guild now and look for partners for a while.
        string actionKey = "";
        try
        {
            actionKey = Activity?.Invoke()?.Key ?? "";
        }
        catch (Exception)
        {
            // The sync itself reports problems reading the activity.
        }
        if (actionKey != _lastActionKey)
        {
            _lastActionKey = actionKey;
            _seeking = SeekSeconds;
            _syncSoon = true;
        }

        double interval = SyncInterval();
        // "Soon" still waits out the fast interval, so flicking between actions cannot flood the server.
        if (_syncSoon) interval = Math.Min(interval, FastSync);
        if (!_syncing && _sinceSync >= interval) Sync();
    }

    private double SyncInterval()
    {
        if (Active && SinceInput < AwaySeconds) return FastSync;
        if (CombatParty) return CombatSync;
        if (Party || _seeking > 0 || (Active && SinceInput < GoneSeconds)) return PartySync;
        return SlowSync;
    }

    /// <summary>The online guild mates doing exactly this action (each once, at most MaxPartners).</summary>
    public List<MemberInfo> FindParty(string actionKey)
    {
        var party = new List<MemberInfo>();
        foreach (List<MemberInfo> members in Members.Values)
        {
            foreach (MemberInfo member in members)
            {
                if (party.Count >= MaxPartners) return party;
                if (member.Id != _steamId && member.HasAction && member.ActionKey == actionKey
                    && ServerNow - member.LastSeen < OnlineWindowMs && party.All(p => p.Id != member.Id))
                {
                    party.Add(member);
                }
            }
        }
        return party;
    }

    /// <summary>Sends my profile JSON if it changed, at most once a minute.</summary>
    public void OfferProfile(string json)
    {
        if (!Enabled || json == _uploadedProfile || _sinceProfileUpload < ProfileUploadGap) return;
        _sinceProfileUpload = 0;
        GuildApi.Send("PUT", "/me/profile", json, result =>
        {
            if (result.Ok) _uploadedProfile = json;
            else if (result.Status != 0) ModEntry.Log("Profile upload refused: " + result.ErrorCode);
        });
    }

    public void LoadProfile(string playerId, Action<ProfileData?> done)
    {
        if (!Enabled)
        {
            done(null);
            return;
        }
        GuildApi.Get("/players/" + playerId + "/profile", result =>
        {
            if (!result.Ok)
            {
                // Servers before v0.3 have no profile route.
                if (result.Status != 404) Notice?.Invoke(result.ErrorMessage);
                done(null);
                return;
            }
            JsonElement? profile = result.Body.Child("profile");
            if (profile == null)
            {
                done(new ProfileData(false, new List<ProfileSkill>(), new List<ProfileGear>(), 0));
                return;
            }
            done(new ProfileData(true,
                profile.Value.Items("skills").Select(x => new ProfileSkill(x.Str("id"), x.Long("level"))).ToList(),
                profile.Value.Items("gear").Select(x => new ProfileGear(x.Str("slot"), x.Str("item"), x.Long("qty"))).ToList(),
                profile.Value.Long("updatedAt")));
        });
    }

    public GuildInfo? Find(string? guildId) => guildId == null ? null : Guilds.FirstOrDefault(g => g.Id == guildId);

    // ---- Enabling and account ----

    /// <summary>
    /// <paramref name="testerCode"/> is what the person running the server hands out while it is in closed
    /// testing; it is only needed the first time and is not saved.
    /// </summary>
    public void Enable(string testerCode = "")
    {
        if (Enabled || Busy || !SteamReady) return;
        // Reuse a key that is already on this PC (for example after the server owner reset the account).
        Identity? saved = Identity.Load(_steamId);
        Register(saved ?? Identity.Create(_steamId), isNew: saved == null, testerCode.Trim());
    }

    private void Register(Identity identity, bool isNew, string testerCode = "")
    {
        Busy = true;
        Changed?.Invoke();
        string body = Json.Obj(w =>
        {
            w.WriteString("steamId", identity.SteamId);
            w.WriteString("name", SteamFriends.GetPersonaName());
            w.WriteString("key", identity.Key);
            if (testerCode.Length > 0) w.WriteString("code", testerCode);
        });
        GuildApi.Post("/register", body, result =>
        {
            Busy = false;
            if (result.Ok)
            {
                if (isNew) identity.Save();
                _identity = identity;
                GuildApi.Auth = identity.Auth;
                if (isNew) Notice?.Invoke("Guilds enabled.");
                RefreshAll();
            }
            else if (result.ErrorCode == "steam_id_claimed")
            {
                Notice?.Invoke(isNew
                    ? "This Steam account already enabled guilds on another PC or install. Copy its key file here, or ask the person running the server to reset your guild account."
                    : "The saved guild key no longer matches the server. Ask the person running the server to reset your guild account.");
            }
            else
            {
                Notice?.Invoke(result.ErrorMessage);
            }
            Changed?.Invoke();
        });
    }

    public void DeleteMyData()
    {
        Run("DELETE", "/me", null, "Your guild data was deleted.", () =>
        {
            Identity.Delete();
            _identity = null;
            _uploadedProfile = "";
            GuildApi.Auth = null;
            Guilds.Clear();
            Invites.Clear();
            MyRequests.Clear();
            Members.Clear();
            Lines.Clear();
            _cursor = null;
            _signature = "";
        });
    }

    // ---- Guild actions ----

    public void CreateGuild(string name, string description, Action<bool> done)
    {
        string body = Json.Obj(w =>
        {
            w.WriteString("name", name);
            w.WriteString("description", description);
        });
        Run("POST", "/guilds", body, "Guild created.", null, done);
    }

    public void Search(string query, Action<List<SearchHit>> done)
    {
        GuildApi.Get("/guilds/search?q=" + Uri.EscapeDataString(query), result =>
        {
            var hits = new List<SearchHit>();
            if (result.Ok)
            {
                foreach (JsonElement g in result.Body.Items("guilds"))
                {
                    hits.Add(new SearchHit(g.Str("id"), g.Str("name"), g.Str("description"), g.Long("memberCount")));
                }
            }
            else
            {
                Notice?.Invoke(result.ErrorMessage);
            }
            done(hits);
        });
    }

    public void RequestJoin(string guildId) => Run("POST", $"/guilds/{guildId}/join", "{}", "Request sent.");

    public void CancelJoin(string guildId) => Run("DELETE", $"/guilds/{guildId}/join", null, "Request cancelled.");

    public void AnswerInvite(string guildId, bool accept) =>
        Run("POST", $"/invites/{guildId}", Accept(accept), accept ? "You joined the guild." : "Invite declined.");

    public void Leave(string guildId) => Run("POST", $"/guilds/{guildId}/leave", "{}", "You left the guild.");

    public void Disband(string guildId) => Run("DELETE", $"/guilds/{guildId}", null, "Guild disbanded.");

    public void Update(string guildId, string name, string description)
    {
        string body = Json.Obj(w =>
        {
            w.WriteString("name", name);
            w.WriteString("description", description);
        });
        Run("PATCH", $"/guilds/{guildId}", body, "Guild settings saved.");
    }

    public void Invite(string guildId, string steamId) =>
        Run("POST", $"/guilds/{guildId}/invite", Json.Obj(w => w.WriteString("steamId", steamId)), "Invite sent.");

    public void AnswerRequest(string guildId, string playerId, bool accept) =>
        Run("POST", $"/guilds/{guildId}/requests/{playerId}", Accept(accept), accept ? "Request accepted." : "Removed.");

    public void Kick(string guildId, string playerId) =>
        Run("DELETE", $"/guilds/{guildId}/members/{playerId}", null, "Member removed.");

    public void SetRank(string guildId, string playerId, string rank) =>
        Run("POST", $"/guilds/{guildId}/members/{playerId}/rank", Json.Obj(w => w.WriteString("rank", rank)), "Rank changed.");

    public void Transfer(string guildId, string playerId) =>
        Run("POST", $"/guilds/{guildId}/transfer", Json.Obj(w => w.WriteString("playerId", playerId)), "Ownership transferred.");

    /// <summary>
    /// Joins or leaves the tester chat: one channel shared by everyone who opted in, for talking about the mod
    /// and reporting bugs. Nothing is sent to or read from it until the player joins.
    /// </summary>
    public void SetTesters(bool on)
    {
        if (!Enabled) return;
        GuildApi.Post("/testers", Json.Obj(w => w.WriteBoolean("on", on)), result =>
        {
            if (!result.Ok)
            {
                Notice?.Invoke(result.Status == 404 ? "The guild server does not have a tester chat yet." : result.ErrorMessage);
                return;
            }
            Testers = on;
            if (!on) Lines.Remove(TestersChannel);
            Notice?.Invoke(on
                ? "You joined the tester chat. Open chat (F8) and pick \"Testers and bug reports\"."
                : "You left the tester chat.");
            // Ask again from the start so the recent tester messages arrive.
            _cursor = null;
            _signature = "";
            RaiseIfChanged();
            Sync();
        });
    }

    public void SendMessage(string guildId, string text)
    {
        string path = guildId == TestersChannel ? "/testers/messages" : $"/guilds/{guildId}/messages";
        GuildApi.Post(path, Json.Obj(w => w.WriteString("body", text)), result =>
        {
            if (!result.Ok)
            {
                Notice?.Invoke(result.ErrorMessage);
                return;
            }
            JsonElement? message = result.Body.Child("message");
            if (message != null) AddLine(message.Value);
        });
    }

    /// <summary>Join requests and outstanding invites for a guild. Only officers and the owner receive them.</summary>
    public void LoadDetail(string guildId)
    {
        if (!Enabled) return;
        GuildApi.Get($"/guilds/{guildId}", result =>
        {
            if (!result.Ok) return;
            JoinRequests[guildId] = result.Body.Items("requests").Select(r => new PendingInfo(r.Str("playerId"), r.Str("name"))).ToList();
            SentInvites[guildId] = result.Body.Items("invites").Select(r => new PendingInfo(r.Str("playerId"), r.Str("name"))).ToList();
            RaiseIfChanged();
        });
    }

    // ---- Internals ----

    private static string Accept(bool accept) => Json.Obj(w => w.WriteBoolean("accept", accept));

    private void Run(string method, string path, string? body, string success, Action? onOk = null, Action<bool>? done = null)
    {
        if (!Enabled) return;
        GuildApi.Send(method, path, body, result =>
        {
            if (result.Ok) onOk?.Invoke();
            Notice?.Invoke(result.Ok ? success : result.ErrorMessage);
            done?.Invoke(result.Ok);
            if (Enabled) RefreshAll();
            else Changed?.Invoke();
        });
    }

    /// <summary>Reloads my guild list and restarts the message cursor (duplicates are dropped by id).</summary>
    private void RefreshAll()
    {
        GuildApi.Get("/me", result =>
        {
            if (!result.Ok)
            {
                if (result.Status == 401) Notice?.Invoke("The guild server does not recognise this PC's key.");
                return;
            }
            Testers = IsTrue(result.Body, "testers");
            Guilds.Clear();
            foreach (JsonElement g in result.Body.Items("guilds"))
            {
                Guilds.Add(new GuildInfo(g.Str("id"), g.Str("name"), g.Str("description"), g.Str("ownerId"), g.Str("rank")));
            }
            MyRequests.Clear();
            foreach (JsonElement r in result.Body.Items("requests")) MyRequests.Add((r.Str("guildId"), r.Str("guildName")));
            ReadInvites(result.Body);

            foreach (string gone in Members.Keys.Where(id => Find(id) == null).ToList())
            {
                Members.Remove(gone);
                JoinRequests.Remove(gone);
                SentInvites.Remove(gone);
            }
            foreach (GuildInfo g in Guilds.Where(g => g.Rank != "member")) LoadDetail(g.Id);

            _cursor = null;
            RaiseIfChanged();
            Sync();
        });
    }

    private void Sync()
    {
        if (_syncing || !Enabled) return;
        _syncing = true;
        _sinceSync = 0;
        _syncSoon = false;

        ActivityInfo? activity = null;
        CombatInfo? combat = null;
        try
        {
            activity = Activity?.Invoke();
            if (activity != null) combat = Combat?.Invoke();
        }
        catch (Exception e)
        {
            ModEntry.Log("Could not read current activity: " + e.Message);
        }
        string body = Json.Obj(w =>
        {
            if (_cursor != null) w.WriteString("since", _cursor);
            w.WriteString("name", SteamFriends.GetPersonaName());
            if (activity != null)
            {
                w.WriteStartObject("status");
                w.WriteString("skill", activity.SkillName);
                w.WriteNumber("level", activity.Level);
                w.WriteStartObject("action");
                w.WriteString("entity", activity.EntityId);
                w.WriteString("target", activity.TargetId);
                if (activity.AreaId.Length > 0) w.WriteString("area", activity.AreaId);
                w.WriteString("name", activity.Name);
                w.WriteEndObject();
                if (combat != null)
                {
                    w.WriteStartObject("combat");
                    w.WriteNumber("hp", Math.Min(combat.Hp, combat.MaxHp));
                    w.WriteNumber("maxHp", combat.MaxHp);
                    w.WriteNumber("dps", combat.Dps);
                    w.WriteNumber("level", Math.Min(combat.Level, 100000));
                    w.WriteNumber("interval", combat.IntervalMs);
                    w.WriteNumber("hit", combat.HitPercent);
                    w.WriteEndObject();
                }
                w.WriteEndObject();
            }
            else
            {
                w.WriteNull("status");
            }
            ExtraSync?.Invoke(w);
        });

        GuildApi.Post("/sync", body, result =>
        {
            _syncing = false;
            if (!result.Ok) return;

            LastSyncUtc = DateTime.UtcNow;
            ServerNow = result.Body.Long("now");
            string cursor = result.Body.Str("cursor");
            if (cursor.Length > 0) _cursor = cursor;

            bool membershipChanged = false;
            var seen = new HashSet<string>();
            foreach (JsonElement g in result.Body.Items("guilds"))
            {
                string id = g.Str("id");
                seen.Add(id);
                GuildInfo? known = Find(id);
                if (known == null || known.Rank != g.Str("rank") || known.Name != g.Str("name")) membershipChanged = true;

                Members[id] = g.Items("members").Select(m =>
                {
                    JsonElement? status = m.Child("status");
                    JsonElement? action = status?.Child("action");
                    JsonElement? fight = status?.Child("combat");
                    return new MemberInfo(m.Str("id"), m.Str("name"), m.Str("rank"), m.Long("lastSeen"),
                        status?.Str("skill") ?? "", status?.Long("level") ?? 0,
                        action?.Str("entity") ?? "", action?.Str("target") ?? "", action?.Str("name") ?? "",
                        action?.Str("area") ?? "", fight?.Long("hp") ?? 0, fight?.Long("maxHp") ?? 0,
                        fight?.Long("dps") ?? 0, fight?.Long("level") ?? 0, fight?.Long("interval") ?? 0, fight?.Long("hit") ?? 0);
                }).ToList();
            }
            if (seen.Count != Guilds.Count) membershipChanged = true;

            if (result.Body.TryGetProperty("testers", out _) && IsTrue(result.Body, "testers") != Testers)
            {
                Testers = !Testers;
                membershipChanged = true;
            }
            foreach (JsonElement message in result.Body.Items("messages")) AddLine(message);
            ReadInvites(result.Body);

            Synced?.Invoke(result.Body);

            if (membershipChanged) RefreshAll();
            else RaiseIfChanged();
        });
    }

    private void ReadInvites(JsonElement body)
    {
        Invites.Clear();
        foreach (JsonElement i in body.Items("invites"))
        {
            Invites.Add(new InviteInfo(i.Str("guildId"), i.Str("guildName"), i.Str("byName")));
        }
    }

    private static bool IsTrue(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.True;

    private void AddLine(JsonElement message)
    {
        string id = message.Str("id");
        if (id.Length == 0 || !_seenMessages.Add(id)) return;

        var line = new ChatLine(id, message.Str("guildId"), message.Str("playerId"), message.Str("name"), message.Str("body"), message.Long("at"));
        if (!Lines.TryGetValue(line.GuildId, out List<ChatLine>? list)) Lines[line.GuildId] = list = new List<ChatLine>();
        list.Add(line);
        if (list.Count > MaxLinesPerGuild) list.RemoveAt(0);
        MessageReceived?.Invoke(line);
    }

    /// <summary>Raises Changed only when something the UI shows is different, so lists are not rebuilt every poll.</summary>
    private void RaiseIfChanged()
    {
        var sb = new StringBuilder();
        foreach (GuildInfo g in Guilds)
        {
            sb.Append(g.Id).Append('|').Append(g.Name).Append('|').Append(g.Description).Append('|').Append(g.Rank).Append('|').Append(g.OwnerId).Append(';');
            if (Members.TryGetValue(g.Id, out List<MemberInfo>? members))
            {
                foreach (MemberInfo m in members)
                {
                    bool online = ServerNow - m.LastSeen < OnlineWindowMs;
                    sb.Append(m.Id).Append(m.Name).Append(m.Rank).Append(online).Append(m.Skill).Append(m.Level).Append(m.ActionTarget).Append(',');
                }
            }
            if (JoinRequests.TryGetValue(g.Id, out List<PendingInfo>? requests)) sb.Append('R').AppendJoin(',', requests.Select(r => r.PlayerId + r.Name));
            if (SentInvites.TryGetValue(g.Id, out List<PendingInfo>? invites)) sb.Append('I').AppendJoin(',', invites.Select(r => r.PlayerId + r.Name));
            sb.Append('\n');
        }
        sb.Append("testers:").Append(Testers);
        sb.Append("inv:").AppendJoin(',', Invites.Select(i => i.GuildId));
        sb.Append("req:").AppendJoin(',', MyRequests.Select(r => r.GuildId));

        string signature = sb.ToString();
        if (signature == _signature) return;
        _signature = signature;
        Changed?.Invoke();
    }
}
