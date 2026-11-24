// Guild Grounds handlers. A guild works through tasks at locations together. When every task at a
// location is done, every member gets its bonus for 30 days; then the guild has to do the tasks again.
//
//   amounts  a task needs its listed amount once for every member the guild has right now.
//   states   a location is OPEN (tasks showing, no bonus), ACTIVE (bonus on, tasks hidden, nothing is
//            counted for it) or, in the last week of its bonus, RENEWING (bonus on, tasks back at
//            nothing; finishing them adds another 30 days to the end date).
//   donate   the member's game removes the items from the bank, then POSTs the donation. The reply
//            says how many were accepted; the game puts the rest back.
//   counts   what members do by playing (kills, laps, items made...) rides on /sync as numbered batches
//            of how much the game's own counters grew. A batch counts for every guild the player is in.
//
// From 0.6.2 to 0.6.5 progress belonged to each player. A guild from that time starts with its
// members' own progress added together (see `pool`).
//
// The server cannot see anyone's game: counts and donations are taken on trust, within sanity limits.
import { HttpError } from './app.js';
import { GROUPS, STEP, TIERS } from './groundsData.js';

export const GROUNDS_LIMITS = {
  maxQty: 1_000_000, // items in one donation
  maxCount: 100_000, // one counter entry in one batch, and one task's gain from one batch
  maxEntries: 60, // counter entries in one batch
  topContributors: 8,
  bonusMs: 30 * 24 * 60 * 60 * 1000, // how long a finished location's bonus lasts
  renewMs: 7 * 24 * 60 * 60 * 1000, // how long before the end the tasks come back
};

const UNIT = 1000; // progress is stored in thousandths so item worths stay whole numbers
// Guild revisions start above any a player had, so every game reloads its view once.
const FIRST_REV = 2_000_000;
const GAME_ID_RE = /^[A-Z][A-Za-z0-9]*:[A-Z][A-Za-z0-9_]*$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const bad = (code, message) => new HttpError(400, code, message);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const ms = (d) => (d ? new Date(d).getTime() : 0);

/** What one of each item in a group is worth, in thousandths of the base item. */
export function worths(group) {
  const g = GROUPS[group];
  const baseAt = g.items.indexOf(g.base);
  return new Map(g.items.map((item, i) => [item, Math.round(UNIT * STEP ** (i - baseAt))]));
}

const LOCATIONS = TIERS.flatMap((tier) => tier.locations);
const TASKS = new Map(LOCATIONS.flatMap((loc) => loc.tasks.map((task) => [task.id, task])));
const PLACE = new Map(LOCATIONS.flatMap((loc) => loc.tasks.map((task) => [task.id, loc])));
const WORTHS = new Map(Object.keys(GROUPS).map((g) => [g, worths(g)]));

export function createGrounds({ store, now, guildCtx, requireRank, limits = {} }) {
  const G = { ...GROUNDS_LIMITS, ...limits };

  const untilOf = (guild, loc) => ms(guild.groundsDone?.[loc.id]);
  /** 'open', 'active' or 'renew' (see the top of this file). */
  function phase(guild, loc, t) {
    const until = untilOf(guild, loc);
    if (!until || t >= until) return 'open';
    return t >= until - G.renewMs ? 'renew' : 'active';
  }
  const needOf = (task, members) => task.need * UNIT * Math.max(1, members);

  /** The bonuses a guild has right now, for /sync: [{id, value}] with `value` in percent. */
  function bonusesOf(guild, t = now()) {
    // Two locations with the same kind of bonus add up.
    const sum = new Map();
    for (const loc of LOCATIONS) {
      if (untilOf(guild, loc) > t) sum.set(loc.bonus.id, (sum.get(loc.bonus.id) ?? 0) + loc.bonus.value);
    }
    return [...sum].map(([id, value]) => ({ id, value }));
  }

  /**
   * The number games compare to know their view is out of date. Besides real changes it moves when a
   * location's tasks come back and when its bonus ends, which happen with the clock alone.
   */
  function revOf(guild, t = now()) {
    let rev = guild.groundsRev ?? 0;
    for (const loc of LOCATIONS) {
      const until = untilOf(guild, loc);
      if (until) rev += t >= until ? 2 : t >= until - G.renewMs ? 1 : 0;
    }
    return rev;
  }

  /**
   * Finishes every location whose tasks have all reached the guild's current amounts.
   * `p` is the guild's progress. Returns the guild document as it is afterwards.
   */
  async function settle(guild, members, p, t) {
    for (const loc of LOCATIONS) {
      if (phase(guild, loc, t) === 'active') continue;
      if (!loc.tasks.every((task) => (p[task.id] ?? 0) >= needOf(task, members))) continue;
      const was = guild.groundsDone?.[loc.id] ?? null;
      // Renewed in time, the new 30 days start where the old ones end.
      const until = new Date(Math.max(t, ms(was)) + G.bonusMs);
      const after = await store.completeLocation(guild._id, loc.id, was, until, loc.tasks.map((task) => task.id));
      if (after) guild = after;
    }
    return guild;
  }

  /**
   * Starts a guild off, once: its members' own progress from 0.6.2 to 0.6.5 added together.
   * `roster` is the guild's member rows. Returns the guild document as it is afterwards.
   */
  async function pool(guild, roster) {
    if (guild.groundsPooled) return guild;
    const ids = roster.map((m) => m.playerId);
    const p = {};
    const given = [];
    for (const doc of ids.length ? await store.myGroundsOf(ids) : []) {
      const t = {};
      for (const [id, n] of Object.entries(doc.p ?? {})) {
        const task = TASKS.get(id);
        if (!task || !(n > 0)) continue;
        const room = needOf(task, ids.length) - (p[id] ?? 0);
        const got = Math.min(room, n);
        if (got <= 0) continue;
        p[id] = (p[id] ?? 0) + got;
        t[id] = got;
      }
      if (Object.keys(t).length) given.push({ playerId: doc._id, t });
    }
    await store.insertGuildGrounds(guild._id, p, given);
    const marked = await store.markGroundsPooled(guild._id, FIRST_REV);
    if (!marked) return (await store.getGuild(guild._id)) ?? guild; // someone else got there first
    return settle(marked, ids.length, await store.guildGrounds(guild._id), now());
  }

  /**
   * Adds a player's progress (`adds`: Map of task id to thousandths) to a guild's grounds.
   * Returns { accepted: Map(task -> thousandths), guild } with the guild document afterwards.
   */
  async function apply(guild, members, playerId, adds, t) {
    const list = [...adds]
      .filter(([task, add]) => add > 0 && phase(guild, PLACE.get(task), t) !== 'active')
      .map(([task, add]) => ({ task, add, need: needOf(TASKS.get(task), members) }));
    const accepted = new Map();
    if (!list.length) return { accepted, guild };

    const before = await store.addGuildProgress(guild._id, list);
    const after = { ...before };
    for (const { task, add, need } of list) {
      const had = before[task] ?? 0;
      const got = Math.max(0, Math.min(need, had + add) - had);
      after[task] = had + got;
      if (got > 0) accepted.set(task, got);
    }
    if (!accepted.size) return { accepted, guild };
    await store.addGiven(guild._id, playerId, Object.fromEntries(accepted));
    const settled = await settle(guild, members, after, t);
    // Finishing a location already marks the grounds as changed.
    return { accepted, guild: settled !== guild ? settled : (await store.bumpGrounds(guild._id)) ?? guild };
  }

  /** `{counterId: {objectId: n}}` from a batch as a Map of Maps, dropping anything malformed. */
  function vCounts(v) {
    const out = new Map();
    if (v == null || typeof v !== 'object' || Array.isArray(v)) return out;
    let room = G.maxEntries;
    for (const [stat, entries] of Object.entries(v)) {
      if (!GAME_ID_RE.test(stat) || entries == null || typeof entries !== 'object' || Array.isArray(entries)) continue;
      const good = new Map();
      for (const [id, n] of Object.entries(entries)) {
        if (room <= 0) break;
        room--;
        if (GAME_ID_RE.test(id) && isInt(n, 1, G.maxCount)) good.set(id, n);
      }
      if (good.size) out.set(stat, good);
    }
    return out;
  }

  const h = {
    async view({ me, params }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner', 'officer', 'member');
      const t = now();
      const roster = await store.rosters([ctx.gid]);
      const members = roster.length;
      let guild = await pool(ctx.guild, roster);
      // Catches a location that a member's leaving has finished.
      guild = await settle(guild, members, await store.guildGrounds(ctx.gid), t);
      const [p, givers] = await Promise.all([store.guildGrounds(ctx.gid), store.giversOf(ctx.gid)]);
      const names = new Map(roster.map((m) => [m.playerId, m.name]));

      const taskOut = (task, hidden) => {
        const need = needOf(task, members);
        const have = hidden ? need : Math.min(need, p[task.id] ?? 0);
        const gave = hidden ? [] : givers
          .map((g) => ({ id: g.playerId, name: names.get(g.playerId) ?? 'Former member', amount: g.t?.[task.id] ?? 0 }))
          .filter((g) => g.amount > 0)
          .sort((a, b) => b.amount - a.amount);
        return {
          id: task.id,
          kind: task.kind,
          text: task.text,
          need,
          have,
          ...(task.kind === 'donate' ? { items: [...WORTHS.get(task.group)].map(([item, worth]) => ({ item, worth })) } : {}),
          ...(task.stat ? { stat: task.stat } : {}),
          ...(task.ids ? { ids: task.ids } : {}),
          ...(task.area ? { area: task.area } : {}),
          mine: gave.find((g) => g.id === me)?.amount ?? 0,
          top: gave.slice(0, G.topContributors),
        };
      };
      return {
        rev: revOf(guild, t),
        unit: UNIT,
        members,
        tiers: TIERS.map((tier) => ({
          id: tier.id,
          name: tier.name,
          locations: tier.locations.map((loc) => {
            const state = phase(guild, loc, t);
            const until = state === 'open' ? 0 : untilOf(guild, loc);
            return {
              id: loc.id,
              name: loc.name,
              bonus: loc.bonus,
              // True while the bonus is on. An active location's tasks are sent as complete, which is
              // what games before 0.7 show for a finished location.
              done: state !== 'open',
              state,
              until,
              renewFrom: until ? until - G.renewMs : 0,
              tasks: loc.tasks.map((task) => taskOut(task, state === 'active')),
            };
          }),
        })),
      };
    },

    // The donor's game has already removed `qty` of `item`. Replies with how many were accepted;
    // the game puts the others back. The same nonce always gets the same answer.
    async donate({ me, params, body }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner', 'officer', 'member');
      const task = TASKS.get(body.task);
      if (!task || task.kind !== 'donate') throw bad('bad_task', 'That is not a task items can be donated to');
      const worth = WORTHS.get(task.group).get(body.item);
      if (!worth) throw bad('bad_item', 'That item is not accepted for this task');
      if (!isInt(body.qty, 1, G.maxQty)) throw bad('bad_qty', `Quantity must be 1 to ${G.maxQty}`);
      if (typeof body.nonce !== 'string' || !NONCE_RE.test(body.nonce)) throw bad('bad_nonce', 'Missing donation id');

      const t = now();
      const giftId = await store.insertGift({
        playerId: me, nonce: body.nonce, guildId: ctx.gid, task: task.id, item: body.item, qty: body.qty, accepted: null, at: new Date(t),
      });
      if (!giftId) {
        // Sent before. If that attempt never finished, nothing is accepted now: the game refunds the
        // items, and the guild keeps any progress the first attempt did record.
        const old = await store.getGift(me, body.nonce);
        return { accepted: old?.accepted ?? 0, qty: old?.qty ?? body.qty };
      }

      const roster = await store.rosters([ctx.gid]);
      const guild = await pool(ctx.guild, roster);
      const { accepted } = await apply(guild, roster.length, me, new Map([[task.id, body.qty * worth]]), t);
      const points = accepted.get(task.id) ?? 0;
      // A trimmed donation takes just enough items to finish the task.
      const qty = points >= body.qty * worth ? body.qty : Math.ceil(points / worth);
      await store.setGiftAccepted(giftId, qty);
      return { accepted: qty, qty: body.qty };
    },
  };

  return {
    bonusesOf,
    revOf,
    pool,
    /**
     * Counts from /sync: `{seq, counts: {counterId: {objectId: n}}}`, how much the game's counters grew.
     * Each batch number is applied once, to every guild in `guilds` ([{guild, members}], already
     * started off). Returns the batch number to acknowledge (null if the body was unusable) and the
     * guild documents afterwards, in the same order.
     */
    async applyCounts(player, body, guilds) {
      const same = guilds.map((g) => g.guild);
      if (body == null || typeof body !== 'object' || !isInt(body.seq, 1, 1e15)) return { ack: null, guilds: same };
      const ack = body.seq;
      if (!(await store.takeGroundsSeq(player._id, body.seq))) return { ack, guilds: same };

      const counts = vCounts(body.counts);
      const adds = new Map();
      for (const task of TASKS.values()) {
        const entries = task.stat && counts.get(task.stat);
        if (!entries) continue;
        let n = 0;
        for (const [id, count] of entries) if (!task.ids || task.ids.includes(id)) n += count;
        if (n > 0) adds.set(task.id, Math.min(n, G.maxCount) * UNIT);
      }
      if (!adds.size) return { ack, guilds: same };
      const t = now();
      const after = await Promise.all(guilds.map(async ({ guild, members }) => (await apply(guild, members, player._id, adds, t)).guild));
      return { ack, guilds: after };
    },
    /** A member has left: the amounts dropped, which can finish a location. */
    async memberLeft(guildId) {
      const guild = await store.getGuild(guildId);
      if (!guild?.groundsPooled) return;
      const [members, p] = await Promise.all([store.countMembers(guildId), store.guildGrounds(guildId)]);
      if (members > 0) await settle(guild, members, p, now());
    },
    routes: [
      ['GET', 'guilds/:id/grounds', h.view],
      ['POST', 'guilds/:id/grounds/donate', h.donate],
    ],
  };
}
