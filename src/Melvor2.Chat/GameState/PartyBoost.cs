using System.Text.Json;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Actions;
using GamesByMalcs.Melvor2.Data;
using GamesByMalcs.Melvor2.Entities.Combat;
using GamesByMalcs.Melvor2.Localization;
using GamesByMalcs.Melvor2.Modifiers;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat.GameState;

/// <summary>
/// +5% skill XP for every guild mate who is online doing the exact same action (up to four of them).
/// In combat the bonus goes on each combat skill, because combat has no single experience pool.
///
/// The bonus is a normal game modifier added through the game's ModifierSystem under the source name
/// "Guild Party Bonus". The game never writes modifiers to the save, so it cannot stick to a character.
///
/// It runs on a lease. Each guild sync that still shows a partner renews it for LeaseSeconds; when the lease
/// lapses, my action changes, or the partner stops, it is removed. Removal can happen from the action's own
/// Ticked event, which runs on whichever thread is ticking the game. That matters after the PC sleeps: the
/// game replays the missed time on a background thread, and the first replayed tick sees the expired lease and
/// drops the bonus on that same thread, so offline progress is not boosted and there is no cross-thread race.
/// </summary>
internal sealed class PartyBoost
{
    public const double Percent = 0.05;
    private const double LeaseSeconds = 45;

    private sealed class Source : INamedObject
    {
        public ILocalizedString DisplayName { get; } = new LocalizedString("Guild Party Bonus");
    }

    private readonly Source _source = new();
    private Game? _game;
    private ModifierSystem? _modifiers;
    private ActionComponent? _hooked;
    private string? _boostedKey;
    private DateTime _leaseUntilUtc;
    private readonly HashSet<string> _unsupported = new();

    /// <summary>True while the bonus modifier is in place.</summary>
    public bool Active => _boostedKey != null;

    /// <summary>The other players, as "Ann, Bob".</summary>
    public string PartnerName { get; private set; } = "";

    /// <summary>How many other players the bonus counts.</summary>
    public int Partners { get; private set; }

    /// <summary>The whole bonus as a fraction: 0.10 with two other players.</summary>
    public double TotalPercent => Percent * Partners;

    /// <summary>"+10%"</summary>
    public string PercentText => "+" + Math.Round(TotalPercent * 100) + "%";

    public string SkillName { get; private set; } = "";

    /// <summary>Raised on the main thread when the bonus starts or ends.</summary>
    public event Action? Changed;

    private bool _changedPending;

    /// <summary>
    /// Main thread, game accessible. <paramref name="party"/> is the online guild mates on the same action
    /// according to a sync that finished at <paramref name="syncedAtUtc"/>; empty if there are none.
    /// </summary>
    public void Update(Game game, ActivityInfo? mine, ActionComponent? component, IReadOnlyList<MemberInfo> party, DateTime syncedAtUtc)
    {
        if (!ReferenceEquals(game, _game))
        {
            // A different save was loaded: the old game's modifier system is gone with it.
            Unhook();
            _game = game;
            _modifiers = null;
            if (_boostedKey != null) _changedPending = true;
            _boostedKey = null;
        }

        DateTime now = DateTime.UtcNow;
        int count = Math.Min(party.Count, GuildService.MaxPartners);
        bool wanted = mine != null && component != null && count > 0
            && (now - syncedAtUtc).TotalSeconds < LeaseSeconds;
        string names = string.Join(", ", party.Take(count).Select(p => p.Name));

        // The key includes the head count, so the bonus is rebuilt when someone joins or leaves.
        if (wanted && mine!.Key + "#" + count == _boostedKey)
        {
            _leaseUntilUtc = syncedAtUtc.AddSeconds(LeaseSeconds);
            PartnerName = names;
        }
        else
        {
            if (_boostedKey != null) Remove();
            if (wanted) Add(game, mine!, component!, count, names, syncedAtUtc);
        }

        if (_changedPending)
        {
            _changedPending = false;
            Changed?.Invoke();
        }
    }

    /// <summary>Main thread: drop the bonus now (guilds disabled, mod shutting down).</summary>
    public void Clear()
    {
        if (_boostedKey != null) Remove();
        if (_changedPending)
        {
            _changedPending = false;
            Changed?.Invoke();
        }
    }

    private void Add(Game game, ActivityInfo mine, ActionComponent component, int count, string partner, DateTime syncedAtUtc)
    {
        if (_unsupported.Contains(mine.EntityId)) return;
        try
        {
            _modifiers ??= GameAccess.Modifiers(game);
            if (_modifiers == null) throw new InvalidOperationException("modifier system not found");

            // The same data shape the game's own bonuses use, scoped to the experience of the skill being
            // trained. Combat trains several skills, so it gets one entry per combat skill.
            var targets = new List<(string Entity, string Component)>();
            if (component.Entity is CombatEntity combat)
            {
                foreach (var level in combat.Player.CombatLevels.ActiveLevels.Keys)
                {
                    targets.Add((level.Component.Entity.Id, level.Component.Id));
                }
            }
            else
            {
                targets.Add((mine.EntityId, "Experience"));
            }
            if (targets.Count == 0) throw new InvalidOperationException("no experience component to boost");

            string value = (Percent * count).ToString(System.Globalization.CultureInfo.InvariantCulture);
            string json = "{\"Global\":[],\"Component\":[" + string.Join(",", targets.Select(t =>
                "{\"Stat\":{\"StatsType\":\"MelvorBase:Experience\",\"Name\":\"PercentXPGained\"},"
                + "\"LocalContext\":{\"Component\":{\"Entity\":" + JsonSerializer.Serialize(t.Entity)
                + ",\"Component\":" + JsonSerializer.Serialize(t.Component) + "}},\"Value\":" + value + "}")) + "]}";
            using JsonDocument doc = JsonDocument.Parse(json);
            var values = new ModifierValues(game.Data, doc.RootElement);

            _modifiers.Remove(_source); // Never stack: at most one party bonus exists.
            _modifiers.Add(_source, values);

            _boostedKey = mine.Key + "#" + count;
            Partners = count;
            _leaseUntilUtc = syncedAtUtc.AddSeconds(LeaseSeconds);
            PartnerName = partner;
            SkillName = mine.SkillName;
            _hooked = component;
            component.Ticked += OnTicked;
            _changedPending = true;
            ModEntry.Log("Party bonus on: " + mine.Key + " x" + count + " with " + partner);
        }
        catch (Exception e)
        {
            // The game refused the modifier for this activity. Do not retry every frame.
            _unsupported.Add(mine.EntityId);
            ModEntry.Log("Party bonus not available for " + mine.EntityId + ": " + e.Message);
        }
    }

    private void Remove()
    {
        Unhook();
        try
        {
            _modifiers?.Remove(_source);
        }
        catch (Exception e)
        {
            ModEntry.Log("Party bonus removal failed: " + e.Message);
        }
        if (_boostedKey != null)
        {
            ModEntry.Log("Party bonus off: " + _boostedKey);
            _boostedKey = null;
            _changedPending = true;
        }
    }

    private void Unhook()
    {
        if (_hooked != null) _hooked.Ticked -= OnTicked;
        _hooked = null;
    }

    /// <summary>
    /// Runs inside the game's tick, on the main thread in normal play and on the background thread during
    /// catch-up or offline progress. Only ever removes.
    /// </summary>
    private void OnTicked(object? sender, ActionTickedEventArgs e)
    {
        if (_boostedKey == null) return;
        bool offline = _game?.Flags.IsOffline ?? true;
        if (offline || DateTime.UtcNow > _leaseUntilUtc) Remove();
    }
}
