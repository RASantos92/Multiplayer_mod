using System.Text;
using GamesByMalcs.Melvor2.GameMenus;
using Godot;

namespace Melvor2.Chat;

/// <summary>
/// Developer tool. The game's scene files are packed, so the exact layout and styling of its UI can only be
/// read from the live scene tree. When the file mod-probe\ui-probe.request exists in the game's user-data
/// folder (%APPDATA%\Games By Malcs\Melvor Idle 2), the probe
/// waits for a save to be loaded, writes ui-probe.txt next to it, and deletes the request file.
/// Useful again after a game update changes the UI.
/// </summary>
internal static class UiProbe
{
    private const int MaxNodes = 900;
    // The game's own user-data folder (%APPDATA%\Games By Malcs\Melvor Idle 2): known to be writable.
    private static readonly string s_dir = Path.Combine(OS.GetUserDataDir(), "mod-probe");
    private static readonly string s_request = Path.Combine(s_dir, "ui-probe.request");
    private static readonly string s_output = Path.Combine(s_dir, "ui-probe.txt");

    /// <summary>Logged once at startup so a silent probe can be diagnosed from the game log.</summary>
    public static string Describe() => "probe dir=" + s_dir + " requested=" + File.Exists(s_request);

    private static bool s_done;
    private static int s_framesWithGameView;
    private static int s_nodeCount;
    private static int s_frames;

    public static bool Requested => !s_done && File.Exists(s_request);

    /// <summary>Call every frame. Dumps once, a few seconds after the in-game UI appears.</summary>
    public static void Tick(SceneTree tree)
    {
        if (s_done) return;

        // Every ~5 seconds, record what the top of the scene tree looks like. Written to a file straight
        // away because the game only flushes its own log on exit.
        if (++s_frames % 300 == 60)
        {
            try
            {
                var dbg = new StringBuilder();
                dbg.AppendLine("frame " + s_frames + "  main found: " + (GameUi.FindMain(tree) != null)
                    + "  game view found: " + (GameUi.FindGameView(tree) != null));
                s_nodeCount = 0;
                Tree(dbg, tree.Root, 0, 4, withProperties: false);
                Directory.CreateDirectory(s_dir);
                File.WriteAllText(Path.Combine(s_dir, "ui-probe-debug.txt"), dbg.ToString());
            }
            catch (Exception e)
            {
                GD.PrintErr("[Chat] UI probe debug failed: " + e);
            }
        }

        GameView? view = GameUi.FindGameView(tree);
        if (view == null)
        {
            s_framesWithGameView = 0;
            return;
        }
        if (++s_framesWithGameView < 180) return;

        s_done = true;
        try
        {
            string text = Dump(tree, view);
            Directory.CreateDirectory(s_dir);
            File.WriteAllText(s_output, text);
            File.Delete(s_request);
            ModEntry.Log("UI probe written to " + s_output);
        }
        catch (Exception e)
        {
            GD.PrintErr("[Chat] UI probe failed: " + e);
        }
    }

    private static string Dump(SceneTree tree, GameView view)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# Melvor Idle 2 UI probe " + DateTime.Now.ToString("u"));
        sb.AppendLine("viewport: " + tree.Root.GetVisibleRect().Size + "  content scale: " + tree.Root.ContentScaleFactor);
        sb.AppendLine("root children: " + string.Join(", ", tree.Root.GetChildren().Select(Describe)));
        sb.AppendLine("game view path: " + view.GetPath());

        Section(sb, "PATH: Guide button up to GameView", () =>
        {
            Node? n = view.Header.Get("TutorialButton").As<Node>();
            while (n != null && n != view.GetParent())
            {
                sb.AppendLine("  " + Describe(n) + "  children: " + string.Join(", ", n.GetChildren().Select(Describe)));
                n = n.GetParent();
            }
        });
        Section(sb, "HEADER: Guide button subtree", () => Tree(sb, view.Header.Get("TutorialButton").As<Node>(), 0, 8));
        Section(sb, "HEADER: Statistics button subtree", () => Tree(sb, view.Header.Get("StatisticsButton").As<Node>(), 0, 8));
        Section(sb, "HEADER: parent of Guide button (shallow)", () => Tree(sb, view.Header.Get("TutorialButton").As<Node>()?.GetParent(), 0, 1));
        Section(sb, "FOOTER: full subtree", () => Tree(sb, view.Footer, 0, 7));
        Section(sb, "POPUPS: parent of Mastery Guild (shallow)", () => Tree(sb, view.MasteryGuild.GetParent(), 0, 1));
        Section(sb, "POPUPS: Mastery Guild subtree", () => Tree(sb, view.MasteryGuild, 0, 9));

        Section(sb, "THEME", () =>
        {
            sb.AppendLine("  gui/theme/custom: " + ProjectSettings.GetSetting("gui/theme/custom"));
            Theme theme = ThemeDB.GetProjectTheme();
            if (theme == null)
            {
                sb.AppendLine("  no project theme");
                return;
            }
            sb.AppendLine("  theme resource: " + theme.ResourcePath);
            sb.AppendLine("  types: " + string.Join(", ", theme.GetTypeList().OrderBy(t => t)));
            foreach (string baseType in new[] { "Button", "Label", "PanelContainer", "Panel", "LineEdit", "RichTextLabel", "TextureButton" })
            {
                sb.AppendLine("  variations of " + baseType + ": " + string.Join(", ", theme.GetTypeVariationList(baseType).OrderBy(t => t)));
            }
        });

        Section(sb, "ICONS in res://Assets/Icons", () =>
        {
            foreach (string dir in new[] { "res://Assets/Icons", "res://Assets/UI", "res://Assets" })
            {
                string[] files = DirAccess.GetFilesAt(dir);
                string[] dirs = DirAccess.GetDirectoriesAt(dir);
                sb.AppendLine("  " + dir + ": " + files.Length + " files; folders: " + string.Join(", ", dirs));
                string[] hits = files.Where(f => System.Text.RegularExpressions.Regex.IsMatch(f,
                    "guild|chat|friend|social|banner|flag|shield|group|people|speech|message|mail|music|note|log|party|crown",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase)).ToArray();
                sb.AppendLine("    matches: " + string.Join(", ", hits));
            }
        });

        return sb.ToString();
    }

    private static void Section(StringBuilder sb, string title, Action body)
    {
        sb.AppendLine();
        sb.AppendLine("## " + title);
        s_nodeCount = 0;
        try
        {
            body();
        }
        catch (Exception e)
        {
            sb.AppendLine("  !! " + e.GetType().Name + ": " + e.Message);
        }
    }

    private static string Describe(Node n)
    {
        string type = n.GetType().FullName ?? n.GetClass();
        string native = n.GetClass();
        return n.Name + " <" + (type.EndsWith("." + native) ? native : type + " : " + native) + ">";
    }

    private static void Tree(StringBuilder sb, Node? node, int depth, int maxDepth, bool withProperties = true)
    {
        if (node == null)
        {
            sb.AppendLine("  (null)");
            return;
        }
        if (++s_nodeCount > MaxNodes)
        {
            if (s_nodeCount == MaxNodes + 1) sb.AppendLine("  ... node limit reached");
            return;
        }

        string indent = new string(' ', 2 + depth * 2);
        sb.Append(indent).Append(Describe(node));
        if (node is Control c)
        {
            sb.Append("  pos=").Append(c.Position).Append(" size=").Append(c.Size);
            if (!c.Visible) sb.Append(" HIDDEN");
        }
        sb.AppendLine();
        if (withProperties)
        {
            foreach (string line in ChangedProperties(node))
            {
                sb.Append(indent).Append("    . ").AppendLine(line);
            }
        }

        if (depth >= maxDepth)
        {
            int count = node.GetChildCount();
            if (count > 0) sb.Append(indent).AppendLine("  (" + count + " children not shown)");
            return;
        }
        foreach (Node child in node.GetChildren())
        {
            Tree(sb, child, depth + 1, maxDepth, withProperties);
        }
    }

    /// <summary>Stored properties whose value differs from the engine default: roughly what the scene file sets.</summary>
    private static IEnumerable<string> ChangedProperties(Node node)
    {
        string nativeClass = node.GetClass();
        foreach (Godot.Collections.Dictionary prop in node.GetPropertyList())
        {
            var usage = (PropertyUsageFlags)prop["usage"].AsInt64();
            if ((usage & PropertyUsageFlags.Storage) == 0) continue;
            string name = prop["name"].AsString();
            if (name is "script" or "name" or "owner" or "scene_file_path" or "unique_name_in_owner") continue;
            if (name.StartsWith("offset_") || name.StartsWith("anchor_") || name is "position" or "size" or "global_position") continue;

            Variant value;
            try
            {
                value = node.Get(name);
            }
            catch
            {
                continue;
            }
            if (value.VariantType == Variant.Type.Nil) continue;

            string text = Format(value);
            Variant def = ClassDB.ClassGetPropertyDefaultValue(nativeClass, name);
            if (def.VariantType != Variant.Type.Nil && Format(def) == text) continue;
            if (text.Length > 220) text = text.Substring(0, 220) + "...";
            yield return name + " = " + text;
        }
    }

    private static string Format(Variant value)
    {
        if (value.VariantType != Variant.Type.Object) return GD.VarToStr(value).Replace("\n", " ");
        GodotObject? obj = value.AsGodotObject();
        switch (obj)
        {
            case null:
                return "null";
            case StyleBoxTexture sbt:
                return "StyleBoxTexture(" + sbt.ResourcePath + " tex=" + sbt.Texture?.ResourcePath
                    + " texMargin L" + sbt.TextureMarginLeft + " T" + sbt.TextureMarginTop + " R" + sbt.TextureMarginRight + " B" + sbt.TextureMarginBottom
                    + " content L" + sbt.ContentMarginLeft + " T" + sbt.ContentMarginTop + " R" + sbt.ContentMarginRight + " B" + sbt.ContentMarginBottom
                    + " modulate=" + sbt.ModulateColor + ")";
            case StyleBoxFlat sbf:
                return "StyleBoxFlat(" + sbf.ResourcePath + " bg=" + sbf.BgColor + " border=" + sbf.BorderColor
                    + " bw=" + sbf.BorderWidthLeft + " radius=" + sbf.CornerRadiusTopLeft
                    + " content L" + sbf.ContentMarginLeft + " T" + sbf.ContentMarginTop + ")";
            case LabelSettings ls:
                return "LabelSettings(" + ls.ResourcePath + " font=" + ls.Font?.ResourcePath + " size=" + ls.FontSize + " color=" + ls.FontColor + ")";
            case Resource r:
                return r.GetClass() + "(" + r.ResourcePath + ")";
            case Node n:
                return "Node(" + n.GetPath() + ")";
            default:
                return obj.GetClass();
        }
    }
}
