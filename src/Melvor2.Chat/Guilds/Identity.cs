using System.Text.Json;
using Godot;

namespace Melvor2.Chat.Guilds;

/// <summary>
/// The player's guild identity on this PC: their Steam ID plus a random secret key created when they first
/// enable guilds. The server only ever stores a hash of the key. Kept in the game's user-data folder
/// (%APPDATA%\Games By Malcs\Melvor Idle 2\mod-data\guild-identity.json). Losing the file means losing access
/// to that guild account, so it is never deleted by the installer.
/// </summary>
internal sealed class Identity
{
    private static readonly string s_dir = Path.Combine(OS.GetUserDataDir(), "mod-data");
    private static readonly string s_file = Path.Combine(s_dir, "guild-identity.json");

    /// <summary>
    /// Version of the "what guilds send" notice. Raise it whenever the mod starts sending or doing something
    /// new, so players who agreed to an older notice are asked again before it takes effect.
    /// 2 = adds skill levels, equipped gear, current action ids and the party XP bonus.
    /// 5 = adds Guild Grounds: counts of kills, Agility laps and Thieving, item donations, passive bonuses.
    /// </summary>
    public const int CurrentConsent = 5;

    public string SteamId { get; }
    public string Key { get; }

    /// <summary>The notice version this player accepted.</summary>
    public int Consent { get; set; }

    private Identity(string steamId, string key, int consent)
    {
        SteamId = steamId;
        Key = key;
        Consent = consent;
    }

    public string Auth => SteamId + ":" + Key;

    /// <summary>The saved identity for this Steam account, or null if guilds were never enabled here.</summary>
    public static Identity? Load(string steamId)
    {
        try
        {
            if (!File.Exists(s_file)) return null;
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(s_file));
            string savedId = doc.RootElement.Str("steamId");
            string key = doc.RootElement.Str("key");
            int consent = (int)doc.RootElement.Long("consent", 1); // Files from v0.2 have no field: notice 1.
            return savedId == steamId && key.Length >= 32 ? new Identity(savedId, key, consent) : null;
        }
        catch (Exception e)
        {
            ModEntry.Log("Could not read guild identity: " + e.Message);
            return null;
        }
    }

    public static Identity Create(string steamId)
    {
        // 36 random bytes become 48 characters from the set the server accepts.
        string key = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(36));
        return new Identity(steamId, key, CurrentConsent);
    }

    public void Save()
    {
        Directory.CreateDirectory(s_dir);
        File.WriteAllText(s_file, Json.Obj(w =>
        {
            w.WriteString("steamId", SteamId);
            w.WriteString("key", Key);
            w.WriteNumber("consent", Consent);
        }));
    }

    public static void Delete()
    {
        try
        {
            if (File.Exists(s_file)) File.Delete(s_file);
        }
        catch (Exception e)
        {
            ModEntry.Log("Could not remove guild identity: " + e.Message);
        }
    }
}
