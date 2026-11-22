using System.Text;
using System.Text.Json;
using Steamworks;

namespace Melvor2.Chat.Guilds;

internal sealed record GuildInfo(string Id, string Name, string Description, string OwnerId, string Rank);

internal sealed record MemberInfo(string Id, string Name, string Rank, long LastSeen, string Skill, long Level);

internal sealed record InviteInfo(string GuildId, string GuildName, string ByName);

internal sealed record PendingInfo(string PlayerId, string Name);

internal sealed record ChatLine(string Id, string GuildId, string PlayerId, string Name, string Body, long At);

internal sealed record SearchHit(string Id, string Name, string Description, long MemberCount);

/// <summary>
/// The player's guild state and every guild action, backed by the guild server. Nothing is sent until the
/// player enables guilds. While enabled it polls /sync: every few seconds when a guild screen or the chat is
/// open, slowly otherwise.
/// </summary>
internal sealed class GuildService
{
    private const double FastSync = 3;
    private const double SlowSync = 20;
    private const int MaxLinesPerGuild = 200;
    public const long OnlineWindowMs = 60_000;

    private Identity? _identity;
    private string _steamId = "";
    private string? _cursor;
    private double _sinceSync = SlowSync;
    private bool _syncing;
    private string _signature = "";
    private readonly HashSet<string> _seenMessages = new();

    public bool SteamReady => _steamId.Length > 0;
    public bool Enabled => _identity != null;
    public bool Busy { get; private set; }
    public string SteamId => _steamId;

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

    /// <summary>Guild list, members, invites or requests changed.</summary>
    public event Action? Changed;

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
        if (saved != null) Register(saved, isNew: false);
    }

    public void Tick(double delta)
    {
        if (!Enabled) return;
        _sinceSync += delta;
        if (!_syncing && _sinceSync >= (Active ? FastSync : SlowSync)) Sync();
    }

    public GuildInfo? Find(string? guildId) => guildId == null ? null : Guilds.FirstOrDefault(g => g.Id == guildId);

    // ---- Enabling and account ----

    public void Enable()
    {
        if (Enabled || Busy || !SteamReady) return;
        Register(Identity.Create(_steamId), isNew: true);
    }

    private void Register(Identity identity, bool isNew)
    {
        Busy = true;
        Changed?.Invoke();
        string body = Json.Obj(w =>
        {
            w.WriteString("steamId", identity.SteamId);
            w.WriteString("name", SteamFriends.GetPersonaName());
            w.WriteString("key", identity.Key);
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
                    ? "This Steam account already enabled guilds on another PC or install. Its key file is needed to use it here."
                    : "The saved guild key no longer matches the server.");
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

    public void SendMessage(string guildId, string text)
    {
        GuildApi.Post($"/guilds/{guildId}/messages", Json.Obj(w => w.WriteString("body", text)), result =>
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

        (string skill, long level) = ReadActivity();
        string body = Json.Obj(w =>
        {
            if (_cursor != null) w.WriteString("since", _cursor);
            w.WriteString("name", SteamFriends.GetPersonaName());
            if (skill.Length > 0)
            {
                w.WriteStartObject("status");
                w.WriteString("skill", skill);
                w.WriteNumber("level", level);
                w.WriteEndObject();
            }
            else
            {
                w.WriteNull("status");
            }
        });

        GuildApi.Post("/sync", body, result =>
        {
            _syncing = false;
            if (!result.Ok) return;

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
                    return new MemberInfo(m.Str("id"), m.Str("name"), m.Str("rank"), m.Long("lastSeen"),
                        status?.Str("skill") ?? "", status?.Long("level") ?? 0);
                }).ToList();
            }
            if (seen.Count != Guilds.Count) membershipChanged = true;

            foreach (JsonElement message in result.Body.Items("messages")) AddLine(message);
            ReadInvites(result.Body);

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

    /// <summary>What the game itself reports to Steam for the local player, e.g. "Fishing" and 61.</summary>
    private static (string Skill, long Level) ReadActivity()
    {
        try
        {
            CSteamID me = SteamUser.GetSteamID();
            string skill = SteamFriends.GetFriendRichPresence(me, "active_entity") ?? "";
            string levelText = SteamFriends.GetFriendRichPresence(me, "entity_level") ?? "";
            if (skill.Length > 40) skill = skill.Substring(0, 40);
            long.TryParse(levelText, out long level);
            return (skill, Math.Clamp(level, 0, 1_000_000));
        }
        catch (Exception)
        {
            return ("", 0);
        }
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
                    sb.Append(m.Id).Append(m.Name).Append(m.Rank).Append(online).Append(m.Skill).Append(m.Level).Append(',');
                }
            }
            if (JoinRequests.TryGetValue(g.Id, out List<PendingInfo>? requests)) sb.Append('R').AppendJoin(',', requests.Select(r => r.PlayerId + r.Name));
            if (SentInvites.TryGetValue(g.Id, out List<PendingInfo>? invites)) sb.Append('I').AppendJoin(',', invites.Select(r => r.PlayerId + r.Name));
            sb.Append('\n');
        }
        sb.Append("inv:").AppendJoin(',', Invites.Select(i => i.GuildId));
        sb.Append("req:").AppendJoin(',', MyRequests.Select(r => r.GuildId));

        string signature = sb.ToString();
        if (signature == _signature) return;
        _signature = signature;
        Changed?.Invoke();
    }
}
