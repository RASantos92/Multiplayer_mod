using Godot;

namespace Melvor2.Chat;

/// <summary>Icons drawn by the mod itself (the game has no chat icon to borrow).</summary>
internal static class Icons
{
    // Same warm paper colour the game uses for header button labels.
    private const string Paper = "#E2DBCD";

    private const string ChatSvg = """
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
          <path fill="#E2DBCD" d="M12 8h40a8 8 0 0 1 8 8v24a8 8 0 0 1-8 8H30L16 60V48h-4a8 8 0 0 1-8-8V16a8 8 0 0 1 8-8z"/>
          <rect x="16" y="19" width="32" height="5" rx="2.5" fill="#2B2A27"/>
          <rect x="16" y="31" width="22" height="5" rx="2.5" fill="#2B2A27"/>
        </svg>
        """;

    private static Texture2D? s_chat;

    public static Texture2D Chat => s_chat ??= FromSvg(ChatSvg);

    /// <summary>A texture shipped with the game, or null if the game no longer has it.</summary>
    public static Texture2D? Game(string path) =>
        ResourceLoader.Exists(path) ? ResourceLoader.Load<Texture2D>(path) : null;

    private static Texture2D FromSvg(string svg)
    {
        var image = new Image();
        Error error = image.LoadSvgFromString(svg.Replace("#E2DBCD", Paper), 1.0f);
        if (error != Error.Ok) throw new InvalidOperationException("Could not render mod icon: " + error);
        return ImageTexture.CreateFromImage(image);
    }
}
