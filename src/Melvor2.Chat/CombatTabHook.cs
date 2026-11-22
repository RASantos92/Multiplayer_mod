using System.Reflection;
using GamesByMalcs.Melvor2.Entities.Combat;
using GamesByMalcs.Melvor2.GameMenus;
using Godot;
using Melvor2.Chat.GameState;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat;

/// <summary>
/// Adds a "Players" tab to the combat screen, after the game's own tabs on the player panel (stats, levels,
/// attacks, spells, imbuements, prayer). It lists the guild mates in the same fight with their health, damage
/// per second, the share of it that reaches my enemy, and their gear. The tab is hidden while fighting alone.
///
/// Each party member gets their own colour. It is used for their name and attack bar on the tab, and as the
/// colour of the damage numbers their hits make on the enemy, so it is clear whose hit it was.
///
/// The game builds a new combat screen every time the Combat page is opened, so the tab is added again each
/// time. The game's own tab code switches on tab numbers 0 to 5 only, so a seventh tab does not disturb it.
/// </summary>
internal sealed class CombatTabHook
{
    private const double ProfileMaxAgeSeconds = 60;

    /// <summary>One colour per party member (at most four). None is close to the game's red, green or gold bars.</summary>
    private static readonly Color[] s_colors =
    {
        new(0.35f, 0.78f, 1.0f),  // sky blue
        new(1.0f, 0.45f, 0.82f),  // pink
        new(1.0f, 0.6f, 0.2f),    // orange
        new(0.72f, 0.55f, 1.0f),  // violet
    };

    public static Color ColorOf(int slot) => s_colors[Math.Abs(slot) % s_colors.Length];

    private sealed class Card
    {
        public required Label Title;
        public required ProgressBar Health;
        public required Label HealthText;
        public required ProgressBar Attack;
        public required Label Damage;
    }

    private static MethodInfo? s_addSplat;

    private readonly GuildService _guilds;
    private readonly Dictionary<string, (ProfileData? Data, DateTime At)> _profiles = new();
    private readonly Dictionary<string, Card> _cards = new();

    private ulong _screenId;
    private Node? _screen;
    private TabContainer? _tabs;
    private Control? _page;
    private Label? _summary;
    private VBoxContainer? _list;
    private string _built = "";
    private int _lastCount;
    private bool _rebuild;

    public CombatTabHook(GuildService guilds)
    {
        _guilds = guilds;
        ModEntry.Fight.HitLanded = OnHitLanded; // The newest hook replaces any earlier one.
    }

    /// <summary>
    /// A party member's hit just landed. The game has already added its damage number to the enemy picture
    /// (it does that inside the damage call), so the newest number is theirs: give it their colour.
    /// </summary>
    private void OnHitLanded(int slot, int damage)
    {
        if (_screen == null || !GodotObject.IsInstanceValid(_screen)) return;
        var sprite = _screen.Get("EnemySprite").As<Node>();
        var numbers = sprite?.Get("DamageDealtContainer").As<Control>();
        if (sprite == null || numbers == null) return;

        // A miss does no damage, so the game shows nothing for it. Ask the enemy picture for its own miss
        // splat (silently: no cause means it plays no sound), then colour it like a hit.
        bool miss = damage <= 0;
        if (miss)
        {
            s_addSplat ??= typeof(EnemySprite).GetMethod("AddDamageDealtLabel", BindingFlags.Instance | BindingFlags.NonPublic);
            if (s_addSplat == null || sprite is not EnemySprite) return;
            s_addSplat.Invoke(sprite, new object?[] { 0, true, false, null });
        }
        if (numbers.GetChildCount() == 0) return;

        Node splat = numbers.GetChild(numbers.GetChildCount() - 1);
        if (splat is not CombatDamageDealtView || splat.HasMeta("party_hit")) return;
        splat.SetMeta("party_hit", true);

        Color color = ColorOf(slot);
        if (miss)
        {
            // The miss splat is a picture with no number: tint the picture.
            var picture = splat.Get("SplatIcon").As<CanvasItem>();
            if (picture != null) picture.SelfModulate = color;
        }

        var label = splat.Get("DamageDealtLabel").As<Label>();
        if (label == null) return;
        if (label.LabelSettings != null)
        {
            // The settings resource is shared by every number, so change a private copy.
            var settings = (LabelSettings)label.LabelSettings.Duplicate();
            // The digits themselves take the colour; the game's own dark outline stays for contrast.
            settings.FontColor = color;
            label.LabelSettings = settings;
        }
        else
        {
            label.AddThemeColorOverride("font_color", color);
        }
    }

    /// <summary>Main thread, every frame: the attack bars fill smoothly like the player's own.</summary>
    public void Frame()
    {
        if (_cards.Count == 0 || _page == null || !GodotObject.IsInstanceValid(_page) || !_page.IsVisibleInTree()) return;
        PartyCombat fight = ModEntry.Fight;
        foreach (PartyFighter fighter in fight.Fighters)
        {
            if (_cards.TryGetValue(fighter.Id, out Card? card) && GodotObject.IsInstanceValid(card.Attack))
            {
                card.Attack.Value = fight.AttackProgress(fighter);
            }
        }
    }

    /// <summary>Main thread, about twice a second while a save is loaded.</summary>
    public void Tick(GameView view)
    {
        Node? screen = view.EntityViewContainer.GetChildren()
            .FirstOrDefault(c => c is CombatActiveView && GodotObject.IsInstanceValid(c) && !c.IsQueuedForDeletion());
        if (screen == null)
        {
            Forget();
            return;
        }
        if (screen.GetInstanceId() != _screenId)
        {
            Forget();
            _screenId = screen.GetInstanceId();
            _screen = screen;
            Inject(screen);
        }
        if (_tabs == null || _page == null || !GodotObject.IsInstanceValid(_page)) return;

        PartyCombat fight = ModEntry.Fight;
        IReadOnlyList<PartyFighter> fighters = fight.Fighters;
        int index = _tabs.GetTabIdxFromControl(_page);
        if (index < 0) return;

        bool show = fighters.Count > 0;
        if (_tabs.IsTabHidden(index) == show)
        {
            if (!show && _tabs.CurrentTab == index) _tabs.CurrentTab = 0;
            _tabs.SetTabHidden(index, !show);
        }

        // Someone joined the fight: bring the Players tab to the front so it is seen. Only on a join, so the
        // player can switch back to their stats afterwards without it jumping forward again.
        if (fighters.Count > _lastCount) _tabs.CurrentTab = index;
        _lastCount = fighters.Count;
        if (!show) return;

        foreach (PartyFighter fighter in fighters) RequestProfile(fighter.Id);

        string shape = string.Join(",", fighters.Select(f => f.Id));
        if (shape != _built || _rebuild)
        {
            _built = shape;
            _rebuild = false;
            Build(fighters);
        }
        Update(fight, fighters);
    }

    private void Forget()
    {
        _screenId = 0;
        _screen = null;
        _tabs = null;
        _page = null;
        _summary = null;
        _list = null;
        _built = "";
        _cards.Clear();
    }

    private void Inject(Node screen)
    {
        var tabs = screen.Get("PlayerInfoTabContainer").As<TabContainer>();
        if (tabs == null)
        {
            ModEntry.Log("Players tab: the combat screen has no player tab strip in this game version.");
            return;
        }

        // Same shape as the game's own tab pages: an unstyled panel, 300 wide.
        var page = new PanelContainer { Name = "Players", CustomMinimumSize = new Vector2(300, 0) };
        page.AddThemeStyleboxOverride("panel", new StyleBoxEmpty());

        var column = new VBoxContainer();
        column.AddThemeConstantOverride("separation", 8);
        page.AddChild(column);

        _summary = new Label { AutowrapMode = TextServer.AutowrapMode.WordSmart };
        column.AddChild(_summary);
        _list = new VBoxContainer();
        _list.AddThemeConstantOverride("separation", 10);
        column.AddChild(_list);

        tabs.AddChild(page);
        int index = tabs.GetTabIdxFromControl(page);
        tabs.SetTabTitle(index, "");
        tabs.SetTabIcon(index, Icons.Game("res://Assets/Icons/friends.png"));
        tabs.SetTabTooltip(index, "Players in your fight");
        tabs.SetTabHidden(index, true);

        _tabs = tabs;
        _page = page;
        ModEntry.Log("Players tab added to the combat screen.");
    }

    private void Build(IReadOnlyList<PartyFighter> fighters)
    {
        if (_list == null) return;
        foreach (Node child in _list.GetChildren())
        {
            _list.RemoveChild(child);
            child.QueueFree();
        }
        _cards.Clear();

        for (int slot = 0; slot < fighters.Count; slot++)
        {
            PartyFighter fighter = fighters[slot];
            Color color = ColorOf(slot);
            var box = new VBoxContainer();
            box.AddThemeConstantOverride("separation", 4);

            // Name in the player's colour, with a swatch, so the colour of their hit numbers can be matched.
            var swatch = new ColorRect { Color = color, CustomMinimumSize = new Vector2(12, 12), SizeFlagsVertical = Control.SizeFlags.ShrinkCenter };
            var title = new Label { ClipText = true, SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
            title.AddThemeColorOverride("font_color", color);
            var titleRow = new HBoxContainer();
            titleRow.AddThemeConstantOverride("separation", 6);
            titleRow.AddChild(swatch);
            titleRow.AddChild(title);
            box.AddChild(titleRow);

            var health = new ProgressBar { ShowPercentage = false, CustomMinimumSize = new Vector2(0, 14), SizeFlagsHorizontal = Control.SizeFlags.ExpandFill };
            health.AddThemeStyleboxOverride("background", new StyleBoxFlat { BgColor = new Color(0.12f, 0.1f, 0.09f) });
            health.AddThemeStyleboxOverride("fill", new StyleBoxFlat { BgColor = new Color(0.36f, 0.72f, 0.33f) });
            var healthText = new Label { CustomMinimumSize = new Vector2(84, 0), HorizontalAlignment = HorizontalAlignment.Right };
            var healthRow = new HBoxContainer();
            healthRow.AddThemeConstantOverride("separation", 6);
            healthRow.AddChild(health);
            healthRow.AddChild(healthText);
            box.AddChild(healthRow);

            // Their attack bar: fills over their attack interval, and a hit lands on my enemy when it is full.
            var attack = new ProgressBar { ShowPercentage = false, MinValue = 0, MaxValue = 1, Step = 0, CustomMinimumSize = new Vector2(0, 8) };
            attack.AddThemeStyleboxOverride("background", new StyleBoxFlat { BgColor = new Color(0.12f, 0.1f, 0.09f) });
            attack.AddThemeStyleboxOverride("fill", new StyleBoxFlat { BgColor = color });
            attack.TooltipText = "Attack bar. When it fills, their hit lands on your enemy. Their hit numbers are this colour.";
            box.AddChild(attack);

            var damage = new Label { AutowrapMode = TextServer.AutowrapMode.WordSmart };
            box.AddChild(damage);

            box.AddChild(Gear(fighter.Id));
            box.AddChild(new HSeparator());
            _list.AddChild(box);
            _cards[fighter.Id] = new Card { Title = title, Health = health, HealthText = healthText, Attack = attack, Damage = damage };
        }
    }

    private void Update(PartyCombat fight, IReadOnlyList<PartyFighter> fighters)
    {
        if (_summary != null)
        {
            int mine = fight.Mine?.Dps ?? 0;
            _summary.Text = "Party damage per second: " + Math.Round(mine + fight.BonusDps)
                + "\nYours " + mine + "  +  from the party " + Math.Round(fight.BonusDps)
                + "\nParty XP bonus: " + (ModEntry.Boost.Active ? ModEntry.Boost.PercentText : "starting...");
        }

        foreach (PartyFighter fighter in fighters)
        {
            if (!_cards.TryGetValue(fighter.Id, out Card? card)) continue;
            bool shares = fighter.MaxHp > 0;
            card.Title.Text = fighter.Name + (shares ? "   combat level " + fighter.Level : "");
            card.Health.MaxValue = Math.Max(1, fighter.MaxHp);
            card.Health.Value = fighter.Hp;
            card.HealthText.Text = shares ? fighter.Hp + " / " + fighter.MaxHp : "";
            card.Damage.Text = shares
                ? "Deals " + fighter.Dps + " per second, attacking every " + (fighter.IntervalMs / 1000.0).ToString("0.#") + "s and hitting "
                    + Math.Round(fighter.HitChance * 100) + "% of the time. You get " + Math.Round(fighter.Share * 100)
                    + "% of it: about " + fighter.Hit.ToString(fighter.Hit < 10 ? "0.#" : "0") + " per hit."
                : "On an older version of the mod: no health or damage shared.";
        }
    }

    private Control Gear(string playerId)
    {
        var grid = new GridContainer { Columns = 6 };
        grid.AddThemeConstantOverride("h_separation", 4);
        grid.AddThemeConstantOverride("v_separation", 4);

        if (!_profiles.TryGetValue(playerId, out var cached) || cached.Data == null)
        {
            return new Label { Text = "Loading gear..." };
        }
        if (!cached.Data.Shared || cached.Data.Gear.Count == 0)
        {
            return new Label { Text = "No gear to show." };
        }
        foreach (ProfileGear piece in cached.Data.Gear)
        {
            Control icon = GuildWindow.GearIcon(ModEntry.CurrentGame(), piece, out string name);
            if (icon.TooltipText.Length == 0) icon.TooltipText = name;
            grid.AddChild(icon);
        }
        return grid;
    }

    private void RequestProfile(string playerId)
    {
        if (_profiles.TryGetValue(playerId, out var cached) && (DateTime.UtcNow - cached.At).TotalSeconds < ProfileMaxAgeSeconds) return;
        // Mark as requested now so a slow reply is not asked for again every tick.
        _profiles[playerId] = (cached.Data, DateTime.UtcNow);
        _guilds.LoadProfile(playerId, profile =>
        {
            if (profile == null) return;
            _profiles[playerId] = (profile, DateTime.UtcNow);
            _rebuild = true;
        });
    }
}
