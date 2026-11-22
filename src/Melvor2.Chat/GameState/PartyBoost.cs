using System.Text.Json;
using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Components.Actions;
using GamesByMalcs.Melvor2.Data;
using GamesByMalcs.Melvor2.Localization;
using GamesByMalcs.Melvor2.Modifiers;

namespace Melvor2.Chat.GameState;

/// <summary>
/// +5% skill XP while a guild mate is online doing the exact same action.
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
    private const double LeaseSeconds = 30;

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

    public string PartnerName { get; private set; } = "";

    public string SkillName { get; private set; } = "";

    /// <summary>Raised on the main thread when the bonus starts or ends.</summary>
    public event Action? Changed;

    private bool _changedPending;

    /// <summary>
    /// Main thread, game accessible. <paramref name="partner"/> is the name of an online guild mate on the same
    /// action according to a sync that finished at <paramref name="syncedAtUtc"/>, or null if there is none.
    /// </summary>
    public void Update(Game game, ActivityInfo? mine, ActionComponent? component, string? partner, DateTime syncedAtUtc)
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
        bool wanted = mine != null && component != null && partner != null
            && (now - syncedAtUtc).TotalSeconds < LeaseSeconds;

        if (wanted && mine!.Key == _boostedKey)
        {
            _leaseUntilUtc = syncedAtUtc.AddSeconds(LeaseSeconds);
            PartnerName = partner!;
        }
        else
        {
            if (_boostedKey != null) Remove();
            if (wanted) Add(game, mine!, component!, partner!, syncedAtUtc);
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

    private void Add(Game game, ActivityInfo mine, ActionComponent component, string partner, DateTime syncedAtUtc)
    {
        if (_unsupported.Contains(mine.EntityId)) return;
        try
        {
            _modifiers ??= GameAccess.Modifiers(game);
            if (_modifiers == null) throw new InvalidOperationException("modifier system not found");

            // The same data shape the game's own bonuses use, scoped to this one skill's experience.
            string json = "{\"Global\":[],\"Component\":[{\"Stat\":{\"StatsType\":\"MelvorBase:Experience\",\"Name\":\"PercentXPGained\"},"
                + "\"LocalContext\":{\"Component\":{\"Entity\":" + JsonSerializer.Serialize(mine.EntityId) + ",\"Component\":\"Experience\"}},"
                + "\"Value\":" + Percent.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}]}";
            using JsonDocument doc = JsonDocument.Parse(json);
            var values = new ModifierValues(game.Data, doc.RootElement);

            _modifiers.Remove(_source); // Never stack: at most one party bonus exists.
            _modifiers.Add(_source, values);

            _boostedKey = mine.Key;
            _leaseUntilUtc = syncedAtUtc.AddSeconds(LeaseSeconds);
            PartnerName = partner;
            SkillName = mine.SkillName;
            _hooked = component;
            component.Ticked += OnTicked;
            _changedPending = true;
            ModEntry.Log("Party bonus on: " + mine.Key + " with " + partner);
        }
        catch (Exception e)
        {
            // For example Combat has no single "Experience" component. Do not retry every frame.
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
