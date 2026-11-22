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

    public string SteamId { get; }
    public string Key { get; }

    private Identity(string steamId, string key)
    {
        SteamId = steamId;
        Key = key;
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
            return savedId == steamId && key.Length >= 32 ? new Identity(savedId, key) : null;
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
        return new Identity(steamId, key);
    }

    public void Save()
    {
        Directory.CreateDirectory(s_dir);
        File.WriteAllText(s_file, Json.Obj(w =>
        {
            w.WriteString("steamId", SteamId);
            w.WriteString("key", Key);
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
