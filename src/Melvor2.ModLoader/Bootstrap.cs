using System.Reflection;
using System.Runtime.Loader;
using Godot;

namespace Melvor2.ModLoader;

/// <summary>
/// Entry point called by the patched game assembly (from the game's Main constructor, on the main thread).
/// Loads every DLL in "&lt;game folder&gt;\mods" and calls the static Init() of each public type named "ModEntry".
/// </summary>
public static class Bootstrap
{
    public const string Version = "0.1.0";
    private static bool s_started;

    public static void Start()
    {
        if (s_started) return;
        s_started = true;

        try
        {
            string modsDir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "mods"));
            GD.Print($"[ModLoader] v{Version} starting. Mods folder: {modsDir}");

            if (!Directory.Exists(modsDir))
            {
                GD.Print("[ModLoader] No mods folder, nothing to load.");
                return;
            }

            int loaded = 0;
            foreach (string dll in Directory.GetFiles(modsDir, "*.dll").OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
            {
                if (LoadMod(dll)) loaded++;
            }
            GD.Print($"[ModLoader] Loaded {loaded} mod(s).");
        }
        catch (Exception e)
        {
            GD.PrintErr("[ModLoader] Failed to start: " + e);
        }
    }

    private static bool LoadMod(string dll)
    {
        string name = Path.GetFileName(dll);
        try
        {
            // Same load context as the game, so mods share its GodotSharp and Steamworks.NET instances.
            AssemblyLoadContext context = AssemblyLoadContext.GetLoadContext(typeof(Bootstrap).Assembly)
                ?? AssemblyLoadContext.Default;
            Assembly asm = context.LoadFromAssemblyPath(dll);
            bool any = false;
            foreach (Type type in asm.GetExportedTypes())
            {
                if (type.Name != "ModEntry") continue;
                MethodInfo? init = type.GetMethod("Init", BindingFlags.Public | BindingFlags.Static, Type.EmptyTypes);
                if (init == null) continue;
                init.Invoke(null, null);
                any = true;
                GD.Print($"[ModLoader] Initialised {name} ({asm.GetName().Version})");
            }
            if (!any) GD.Print($"[ModLoader] {name} has no public ModEntry.Init(), skipped.");
            return any;
        }
        catch (Exception e)
        {
            GD.PrintErr($"[ModLoader] Error loading {name}: {e}");
            return false;
        }
    }
}
