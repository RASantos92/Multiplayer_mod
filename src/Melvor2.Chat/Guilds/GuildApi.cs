using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace Melvor2.Chat.Guilds;

internal sealed class ApiResult
{
    public bool Ok;
    public int Status;
    public JsonElement Body;
    public string ErrorCode = "";
    public string ErrorMessage = "";
}

/// <summary>
/// HTTPS calls to the guild server (see server/README.md). Requests run on background threads; callbacks are
/// queued and run on the game's main thread by Pump(), because Godot nodes may only be touched there.
/// </summary>
internal static class GuildApi
{
    public const string DefaultUrl = "https://melvor2-guilds.vercel.app";
    private const string Protocol = "1";

    private static readonly HttpClient s_http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private static readonly ConcurrentQueue<Action> s_main = new();

    public static string BaseUrl { get; set; } = DefaultUrl;

    /// <summary>"steamId:key", set once the player has enabled guilds.</summary>
    public static string? Auth { get; set; }

    /// <summary>Runs finished callbacks. Call once per frame on the main thread.</summary>
    public static void Pump()
    {
        while (s_main.TryDequeue(out Action? action))
        {
            try
            {
                action();
            }
            catch (Exception e)
            {
                ModEntry.Log("Guild callback failed: " + e);
            }
        }
    }

    public static void Get(string path, Action<ApiResult> done) => Send("GET", path, null, done);

    public static void Post(string path, string? json, Action<ApiResult> done) => Send("POST", path, json ?? "{}", done);

    public static void Send(string method, string path, string? json, Action<ApiResult> done)
    {
        string url = BaseUrl + path;
        string? auth = Auth;
        _ = Task.Run(async () =>
        {
            ApiResult result;
            try
            {
                using var request = new HttpRequestMessage(new HttpMethod(method), url);
                request.Headers.TryAddWithoutValidation("X-Mod-Protocol", Protocol);
                if (auth != null) request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + auth);
                if (json != null) request.Content = new StringContent(json, Encoding.UTF8, "application/json");

                using HttpResponseMessage response = await s_http.SendAsync(request).ConfigureAwait(false);
                string text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                result = Parse((int)response.StatusCode, text);
            }
            catch (Exception)
            {
                result = new ApiResult { Status = 0, ErrorCode = "network", ErrorMessage = "Could not reach the guild server." };
            }
            s_main.Enqueue(() => done(result));
        });
    }

    private static ApiResult Parse(int status, string text)
    {
        var result = new ApiResult { Status = status, Ok = status is >= 200 and < 300 };
        try
        {
            using JsonDocument doc = JsonDocument.Parse(text.Length == 0 ? "{}" : text);
            result.Body = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            result.Ok = false;
            result.ErrorCode = "bad_response";
            result.ErrorMessage = "The guild server sent an unexpected reply (" + status + ").";
            return result;
        }

        if (!result.Ok)
        {
            result.ErrorCode = "http_" + status;
            result.ErrorMessage = "The guild server refused the request (" + status + ").";
            if (result.Body.ValueKind == JsonValueKind.Object
                && result.Body.TryGetProperty("error", out JsonElement error)
                && error.ValueKind == JsonValueKind.Object)
            {
                result.ErrorCode = error.Str("code", result.ErrorCode);
                result.ErrorMessage = error.Str("message", result.ErrorMessage);
            }
        }
        return result;
    }
}

internal static class Json
{
    /// <summary>Builds a JSON object without reflection.</summary>
    public static string Obj(Action<Utf8JsonWriter> write)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            write(writer);
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    public static string Str(this JsonElement element, string name, string fallback = "")
    {
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out JsonElement value)
            && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? fallback
            : fallback;
    }

    public static long Long(this JsonElement element, string name, long fallback = 0)
    {
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out JsonElement value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt64(out long number)
            ? number
            : fallback;
    }

    public static IEnumerable<JsonElement> Items(this JsonElement element, string name)
    {
        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out JsonElement value)
            && value.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in value.EnumerateArray()) yield return item;
        }
    }

    public static JsonElement? Child(this JsonElement element, string name)
    {
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out JsonElement value)
            && value.ValueKind == JsonValueKind.Object
            ? value
            : null;
    }
}
