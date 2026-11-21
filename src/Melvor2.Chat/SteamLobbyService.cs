using System.Text;
using System.Text.Json;
using Steamworks;

namespace Melvor2.Chat;

/// <summary>
/// Friends-only Steam lobby used as the chat room. Uses the Steam session the game already started;
/// callbacks are delivered by the game's own SteamAPI.RunCallbacks() on the main thread.
/// </summary>
internal sealed class SteamLobbyService
{
    private const int ProtocolVersion = 1;
    private const int MaxMembers = 8;
    private const int MaxBodyChars = 300;
    private const string LobbyModKey = "melvor2chat";

    private CSteamID _lobby = CSteamID.Nil;
    private readonly byte[] _buffer = new byte[4096];
    private readonly Queue<DateTime> _recentSends = new();

    // Keep references so the callbacks are not garbage collected.
    private readonly Callback<LobbyChatMsg_t> _onChatMsg;
    private readonly Callback<LobbyChatUpdate_t> _onChatUpdate;
    private readonly Callback<GameLobbyJoinRequested_t> _onJoinRequested;
    private readonly Callback<LobbyEnter_t> _onEnterCallback;
    private readonly CallResult<LobbyCreated_t> _onCreated;
    private readonly CallResult<LobbyEnter_t> _onEnterResult;

    public event Action<string>? SystemMessage;
    public event Action<string, string>? ChatMessage;
    public event Action? StateChanged;

    public bool InLobby => _lobby != CSteamID.Nil;
    public ulong LobbyId => _lobby.m_SteamID;

    public SteamLobbyService()
    {
        _onChatMsg = Callback<LobbyChatMsg_t>.Create(OnChatMsg);
        _onChatUpdate = Callback<LobbyChatUpdate_t>.Create(OnChatUpdate);
        _onJoinRequested = Callback<GameLobbyJoinRequested_t>.Create(OnJoinRequested);
        _onEnterCallback = Callback<LobbyEnter_t>.Create(e => OnEnter(e));
        _onCreated = CallResult<LobbyCreated_t>.Create(OnCreated);
        _onEnterResult = CallResult<LobbyEnter_t>.Create((e, ioFailure) =>
        {
            if (ioFailure) SystemMessage?.Invoke("Could not join: Steam connection problem.");
            else OnEnter(e);
        });
    }

    public void Host()
    {
        if (InLobby)
        {
            SystemMessage?.Invoke("You are already in a chat. Leave it first.");
            return;
        }
        SystemMessage?.Invoke("Creating a friends-only chat...");
        SteamAPICall_t call = SteamMatchmaking.CreateLobby(ELobbyType.k_ELobbyTypeFriendsOnly, MaxMembers);
        _onCreated.Set(call);
    }

    public void Join(ulong lobbyId)
    {
        if (InLobby) Leave();
        SystemMessage?.Invoke("Joining chat " + lobbyId + "...");
        SteamAPICall_t call = SteamMatchmaking.JoinLobby(new CSteamID(lobbyId));
        _onEnterResult.Set(call);
    }

    /// <summary>Steam starts the game with "+connect_lobby &lt;id&gt;" when an invite is accepted while it is closed.</summary>
    public void JoinFromCommandLine(string[] args)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "+connect_lobby" && ulong.TryParse(args[i + 1], out ulong id))
            {
                Join(id);
                return;
            }
        }
    }

    public void Leave()
    {
        if (!InLobby) return;
        SteamMatchmaking.LeaveLobby(_lobby);
        _lobby = CSteamID.Nil;
        SystemMessage?.Invoke("You left the chat.");
        StateChanged?.Invoke();
    }

    public void Invite()
    {
        if (!InLobby)
        {
            SystemMessage?.Invoke("Host a chat first, then invite.");
            return;
        }
        if (!SteamUtils.IsOverlayEnabled())
        {
            SystemMessage?.Invoke("Steam overlay is off. Use Copy ID and have your friend type /join <id>.");
            return;
        }
        SteamFriends.ActivateGameOverlayInviteDialog(_lobby);
    }

    public IReadOnlyList<string> GetMemberNames()
    {
        var names = new List<string>();
        if (!InLobby) return names;
        int count = SteamMatchmaking.GetNumLobbyMembers(_lobby);
        for (int i = 0; i < count; i++)
        {
            names.Add(NameOf(SteamMatchmaking.GetLobbyMemberByIndex(_lobby, i)));
        }
        return names;
    }

    public void SendChat(string text)
    {
        text = Sanitize(text);
        if (text.Length == 0) return;
        if (!InLobby)
        {
            SystemMessage?.Invoke("Not in a chat. Press Host, or type /join <id>.");
            return;
        }

        // Simple flood guard: at most 5 messages per 3 seconds.
        DateTime now = DateTime.UtcNow;
        while (_recentSends.Count > 0 && (now - _recentSends.Peek()).TotalSeconds > 3) _recentSends.Dequeue();
        if (_recentSends.Count >= 5)
        {
            SystemMessage?.Invoke("Slow down a little.");
            return;
        }
        _recentSends.Enqueue(now);

        byte[] payload = Encode("chat", text);
        if (!SteamMatchmaking.SendLobbyChatMsg(_lobby, payload, payload.Length))
        {
            SystemMessage?.Invoke("Message failed to send.");
        }
    }

    private void OnCreated(LobbyCreated_t result, bool ioFailure)
    {
        if (ioFailure || result.m_eResult != EResult.k_EResultOK)
        {
            SystemMessage?.Invoke("Could not create chat (" + result.m_eResult + ").");
            return;
        }
        var id = new CSteamID(result.m_ulSteamIDLobby);
        SteamMatchmaking.SetLobbyData(id, LobbyModKey, ModEntry.Version);
        ModEntry.Log("Lobby created " + id.m_SteamID);
        SetCurrent(id, "Chat created. Press Invite to bring friends in.");
    }

    private void OnEnter(LobbyEnter_t e)
    {
        if (e.m_EChatRoomEnterResponse != (uint)EChatRoomEnterResponse.k_EChatRoomEnterResponseSuccess)
        {
            SystemMessage?.Invoke("Could not join chat (" + (EChatRoomEnterResponse)e.m_EChatRoomEnterResponse + ").");
            return;
        }
        var id = new CSteamID(e.m_ulSteamIDLobby);
        ModEntry.Log("Entered lobby " + id.m_SteamID);
        SetCurrent(id, "Joined chat with " + string.Join(", ", GetMemberNamesFor(id)) + ".");
    }

    private void SetCurrent(CSteamID id, string message)
    {
        bool isNew = _lobby != id;
        _lobby = id;
        if (isNew) SystemMessage?.Invoke(message);
        StateChanged?.Invoke();
    }

    private IEnumerable<string> GetMemberNamesFor(CSteamID id)
    {
        int count = SteamMatchmaking.GetNumLobbyMembers(id);
        for (int i = 0; i < count; i++) yield return NameOf(SteamMatchmaking.GetLobbyMemberByIndex(id, i));
    }

    private void OnJoinRequested(GameLobbyJoinRequested_t request)
    {
        ModEntry.Log("Invite accepted for lobby " + request.m_steamIDLobby.m_SteamID);
        Join(request.m_steamIDLobby.m_SteamID);
    }

    private void OnChatUpdate(LobbyChatUpdate_t update)
    {
        if (update.m_ulSteamIDLobby != _lobby.m_SteamID) return;
        string name = NameOf(new CSteamID(update.m_ulSteamIDUserChanged));
        var change = (EChatMemberStateChange)update.m_rgfChatMemberStateChange;
        if ((change & EChatMemberStateChange.k_EChatMemberStateChangeEntered) != 0)
        {
            SystemMessage?.Invoke(name + " joined.");
        }
        else
        {
            SystemMessage?.Invoke(name + " left.");
        }
        StateChanged?.Invoke();
    }

    private void OnChatMsg(LobbyChatMsg_t msg)
    {
        if (msg.m_ulSteamIDLobby != _lobby.m_SteamID) return;
        int length = SteamMatchmaking.GetLobbyChatEntry(_lobby, (int)msg.m_iChatID, out CSteamID sender,
            _buffer, _buffer.Length, out EChatEntryType entryType);
        if (entryType != EChatEntryType.k_EChatEntryTypeChatMsg || length <= 0) return;

        if (!TryDecode(_buffer.AsSpan(0, length), out string type, out string body)) return;
        if (type != "chat") return; // Unknown types come from newer mod versions; ignore them.

        body = Sanitize(body);
        if (body.Length == 0) return;
        ChatMessage?.Invoke(NameOf(sender), body);
    }

    private static string NameOf(CSteamID user)
    {
        string name = user == SteamUser.GetSteamID()
            ? SteamFriends.GetPersonaName()
            : SteamFriends.GetFriendPersonaName(user);
        name = Sanitize(name);
        return name.Length == 0 ? "Unknown" : name;
    }

    /// <summary>Strips control characters and caps the length. Applied to both outgoing and incoming text.</summary>
    private static string Sanitize(string text)
    {
        var sb = new StringBuilder(Math.Min(text.Length, MaxBodyChars));
        foreach (char c in text)
        {
            if (sb.Length >= MaxBodyChars) break;
            if (!char.IsControl(c)) sb.Append(c);
        }
        return sb.ToString().Trim();
    }

    private static byte[] Encode(string type, string body)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", ProtocolVersion);
            writer.WriteString("type", type);
            writer.WriteString("body", body);
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }

    private static bool TryDecode(ReadOnlySpan<byte> data, out string type, out string body)
    {
        type = body = "";
        try
        {
            using JsonDocument doc = JsonDocument.Parse(data.ToArray());
            JsonElement root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            if (!root.TryGetProperty("type", out JsonElement t) || t.ValueKind != JsonValueKind.String) return false;
            if (!root.TryGetProperty("body", out JsonElement b) || b.ValueKind != JsonValueKind.String) return false;
            type = t.GetString() ?? "";
            body = b.GetString() ?? "";
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
