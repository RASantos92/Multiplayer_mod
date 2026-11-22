using GamesByMalcs.Melvor2;
using GamesByMalcs.Melvor2.Entities.Combat;
using Melvor2.Chat.Guilds;

namespace Melvor2.Chat.GameState;

/// <summary>One guild mate in the same fight, and how much of their damage reaches my enemy.</summary>
internal sealed record PartyFighter(string Id, string Name, int Level, int Hp, int MaxHp, int Dps, double Share, int IntervalMs, double HitChance)
{
    /// <summary>Damage per second this player adds to my fight.</summary>
    public double Bonus => Dps * Share;

    /// <summary>
    /// What one of their hits does to my enemy when it lands: their share of DPS over one attack interval,
    /// scaled up by their chance to hit. Their DPS figure already includes their misses, so an attack that
    /// can miss has to land harder for the average to stay the same.
    /// </summary>
    public double Hit => Bonus * IntervalMs / 1000.0 / HitChance;
}

/// <summary>
/// Shared combat. Every player fights their own copy of the enemy; this adds a share of each party member's
/// reported damage per second to mine: 15% of it when our combat levels are within ten of each other, 8%
/// otherwise.
///
/// It lands the way an attack does: each party member has their own attack bar that fills over their real
/// attack interval, and when it is full they attack: it lands as often as their own attacks do (their
/// chance to hit) and otherwise misses, like the player's own.
///
/// The damage is applied with no attacker, so the game gives no XP for it and leaves it out of my own DPS
/// figure. That last part matters: the figure I report to the others never includes what they gave me, so two
/// players cannot feed each other's numbers.
///
/// Like the XP bonus it runs on a lease renewed by guild syncs. It is applied from the main thread while the
/// game is running normally, so it never touches offline or catch-up progress, and only while an enemy is
/// actually being fought (not while it spawns, not while paused).
/// </summary>
internal sealed class PartyCombat
{
    public const int LevelWindow = 10;
    public const double NearShare = 0.15;
    public const double FarShare = 0.08;
    private const double LeaseSeconds = 45;

    /// <summary>A member whose last report is older than this adds nothing.</summary>
    private const long StaleMs = 20_000;

    private static readonly IReadOnlyList<PartyFighter> None = Array.Empty<PartyFighter>();

    /// <summary>Used for members on a mod version that does not send their attack interval.</summary>
    private const int DefaultIntervalMs = 3000;

    /// <summary>Per party member: seconds into their current attack, and the fraction of damage not yet dealt.</summary>
    private sealed class Swing
    {
        public double Elapsed;
        public double Carry;
    }

    private readonly Dictionary<string, Swing> _swings = new();
    private DateTime _leaseUntilUtc;
    private Game? _game;
    private CombatEntity? _combat;

    /// <summary>The other players in my fight, as of the latest sync.</summary>
    public IReadOnlyList<PartyFighter> Fighters { get; private set; } = None;

    /// <summary>Damage per second the party adds to my fight right now.</summary>
    public double BonusDps { get; private set; }

    /// <summary>My own figures as last read, for the Players tab.</summary>
    public CombatInfo? Mine { get; private set; }

    /// <summary>Raised on the main thread when the list of fighters or their numbers change.</summary>
    public event Action? Changed;

    /// <summary>
    /// Called on the main thread right after a party member attacks my enemy, with their place in
    /// <see cref="Fighters"/> and the damage done (0 for a miss). The combat screen uses it to colour the
    /// hit number, or to show a miss.
    /// </summary>
    public Action<int, int>? HitLanded { get; set; }

    public static double ShareFor(int myLevel, int theirLevel) =>
        Math.Abs(myLevel - theirLevel) <= LevelWindow ? NearShare : FarShare;

    /// <summary>
    /// Main thread, twice a second. <paramref name="mine"/> is null when I am not in combat;
    /// <paramref name="party"/> is the guild mates on my exact fight according to a sync that finished at
    /// <paramref name="syncedAtUtc"/>.
    /// </summary>
    public void Update(CombatInfo? mine, IReadOnlyList<MemberInfo> party, DateTime syncedAtUtc, long serverNow)
    {
        Mine = mine;
        if (mine == null || party.Count == 0 || (DateTime.UtcNow - syncedAtUtc).TotalSeconds >= LeaseSeconds)
        {
            Set(None, 0);
            return;
        }

        var fighters = new List<PartyFighter>(party.Count);
        double total = 0;
        foreach (MemberInfo member in party)
        {
            bool fresh = member.HasCombat && serverNow - member.LastSeen < StaleMs;
            int dps = fresh ? (int)Math.Min(member.Dps, int.MaxValue) : 0;
            double share = member.HasCombat ? ShareFor(mine.Level, (int)member.CombatLevel) : 0;
            int interval = member.IntervalMs >= 250 ? (int)Math.Min(member.IntervalMs, 60000) : DefaultIntervalMs;
            // Members on a version that does not send a hit chance never miss, as before.
            double hitChance = member.HitPercent >= 1 ? Math.Min(member.HitPercent, 100) / 100.0 : 1.0;
            var fighter = new PartyFighter(member.Id, member.Name, (int)member.CombatLevel, (int)member.Hp, (int)member.MaxHp, dps, share, interval, hitChance);
            fighters.Add(fighter);
            total += fighter.Bonus;
        }

        _leaseUntilUtc = syncedAtUtc.AddSeconds(LeaseSeconds);
        Set(fighters, total);
    }

    /// <summary>Main thread: stop adding damage now (guilds disabled, not in a game).</summary>
    public void Clear()
    {
        Mine = null;
        Set(None, 0);
    }

    /// <summary>
    /// Main thread, every frame. <paramref name="game"/> is null on menus, while paused and while the game is
    /// replaying offline time, and nothing is applied then.
    /// </summary>
    public void Frame(Game? game, double delta)
    {
        if (game == null || BonusDps <= 0 || DateTime.UtcNow > _leaseUntilUtc) return;
        if (!ReferenceEquals(game, _game))
        {
            _game = game;
            _combat = CombatAccess.Find(game);
        }
        // Attack bars only fill while an enemy is up, like the player's own.
        if (_combat == null || !CombatAccess.IsFighting(_combat)) return;

        // A long frame (window dragged, a hitch) must not turn into a burst of hits.
        double step = Math.Min(delta, 0.25);
        for (int slot = 0; slot < Fighters.Count; slot++)
        {
            PartyFighter fighter = Fighters[slot];
            if (fighter.Bonus <= 0) continue;
            if (!_swings.TryGetValue(fighter.Id, out Swing? swing)) _swings[fighter.Id] = swing = new Swing();

            swing.Elapsed += step;
            double interval = fighter.IntervalMs / 1000.0;
            if (swing.Elapsed < interval) continue;
            swing.Elapsed -= interval;

            int dealt = 0;
            bool missed = Random.Shared.NextDouble() >= fighter.HitChance;
            if (!missed)
            {
                swing.Carry += fighter.Hit;
                int whole = (int)swing.Carry;
                if (whole <= 0) continue; // Less than 1 damage so far: carried to their next hit.
                swing.Carry -= whole;
                dealt = CombatAccess.DealPartyDamage(_combat, whole);
            }
            if (dealt > 0 || missed)
            {
                try
                {
                    HitLanded?.Invoke(slot, dealt);
                }
                catch (Exception e)
                {
                    // Colouring a number is decoration; never let it interrupt the fight.
                    HitLanded = null;
                    ModEntry.Log("Hit colouring disabled after error: " + e.Message);
                }
            }
        }
    }

    /// <summary>How full a party member's attack bar is, 0 to 1.</summary>
    public double AttackProgress(PartyFighter fighter) =>
        _swings.TryGetValue(fighter.Id, out Swing? swing) ? Math.Clamp(swing.Elapsed * 1000.0 / fighter.IntervalMs, 0, 1) : 0;

    private void Set(IReadOnlyList<PartyFighter> fighters, double bonus)
    {
        bool changed = Math.Abs(bonus - BonusDps) > 0.001 || !fighters.SequenceEqual(Fighters);
        Fighters = fighters;
        BonusDps = bonus;
        foreach (string gone in _swings.Keys.Where(id => fighters.All(f => f.Id != id)).ToList()) _swings.Remove(gone);
        if (changed) Changed?.Invoke();
    }
}
