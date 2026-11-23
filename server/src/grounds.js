// Guild Grounds handlers. Each player works through tasks at locations; when a player has done every
// task at a location, they get its bonus while they are in a guild. Progress belongs to the player:
// it is the same in every guild they are in, so a bonus can never count twice.
//
// Up to 0.6.1 progress was shared by a guild. The first time a player is seen after that, their own
// progress starts from what they personally contributed back then (see `seed`).
//
//   donate  the member's game removes the items from the bank, then POSTs the donation. The reply
//           says how many were accepted; the game puts the rest back.
//   counts  what members do by playing (kills, laps, items made...) rides on /sync as numbered batches
//           of how much the game's own counters grew.
//
// The server cannot see anyone's game: counts and donations are taken on trust, within sanity limits.
import { HttpError } from './app.js';
import { GROUPS, STEP, TIERS } from './groundsData.js';

export const GROUNDS_LIMITS = {
  maxQty: 1_000_000, // items in one donation
  maxCount: 100_000, // one counter entry in one batch, and one task's gain from one batch
  maxEntries: 60, // counter entries in one batch
  topContributors: 5,
};

const UNIT = 1000; // progress is stored in thousandths so item worths stay whole numbers
const GAME_ID_RE = /^[A-Z][A-Za-z0-9]*:[A-Z][A-Za-z0-9_]*$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const bad = (code, message) => new HttpError(400, code, message);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/** What one of each item in a group is worth, in thousandths of the base item. */
export function worths(group) {
  const g = GROUPS[group];
  const baseAt = g.items.indexOf(g.base);
  return new Map(g.items.map((item, i) => [item, Math.round(UNIT * STEP ** (i - baseAt))]));
}

const LOCATIONS = TIERS.flatMap((tier) => tier.locations);
const TASKS = new Map(LOCATIONS.flatMap((loc) => loc.tasks.map((task) => [task.id, task])));
const WORTHS = new Map(Object.keys(GROUPS).map((g) => [g, worths(g)]));
const BONUS = new Map(LOCATIONS.map((loc) => [loc.id, loc.bonus]));

/** The bonuses a player has earned, for /sync: [{id, value}] with `value` in percent. */
export function bonusesOf(player) {
  // Two locations with the same kind of bonus add up.
  const sum = new Map();
  for (const id of player.groundsDone ?? []) {
    const b = BONUS.get(id);
    if (b) sum.set(b.id, (sum.get(b.id) ?? 0) + b.value);
  }
  return [...sum].map(([id, value]) => ({ id, value }));
}

export function createGrounds({ store, now, guildCtx, requireRank, limits = {} }) {
  const G = { ...GROUNDS_LIMITS, ...limits };

  const doneIn = (p) => LOCATIONS.filter((loc) => loc.tasks.every((t) => (p[t.id] ?? 0) >= t.need * UNIT)).map((loc) => loc.id);

  /**
   * Makes sure the player has their own progress, and returns the player document as it is afterwards.
   * A player from the time of shared guild progress starts from what they contributed themselves:
   * donations added up over their guilds, and counts taken from the guild where they had the most
   * (a count went to every guild they were in, so adding those up would count it twice).
   */
  async function seed(player) {
    if (player.groundsSeeded) return player;
    const p = {};
    for (const doc of await store.groundsTotalsOf(player._id)) {
      for (const [id, n] of Object.entries(doc.t ?? {})) {
        const task = TASKS.get(id);
        if (!task || !(n > 0)) continue;
        const had = p[id] ?? 0;
        p[id] = Math.min(task.need * UNIT, task.kind === 'donate' ? had + n : Math.max(had, n));
      }
    }
    await store.insertMyGrounds(player._id, p);
    return (await store.markGroundsSeeded(player._id, doneIn(p))) ?? player;
  }

  /**
   * Adds progress (`adds`: Map of task id to thousandths) to a player's own grounds.
   * Returns { accepted: Map(task -> thousandths), player } with the player document afterwards.
   */
  async function apply(player, adds) {
    player = await seed(player);
    const list = [...adds].filter(([, add]) => add > 0).map(([task, add]) => ({ task, add, need: TASKS.get(task).need * UNIT }));
    const accepted = new Map();
    if (!list.length) return { accepted, player };

    const before = await store.addMyGroundsProgress(player._id, list);
    const after = { ...before };
    for (const { task, add, need } of list) {
      const had = Math.min(need, before[task] ?? 0);
      const got = Math.min(need, had + add) - had;
      after[task] = had + got;
      if (got > 0) accepted.set(task, got);
    }
    if (!accepted.size) return { accepted, player };
    return { accepted, player: (await store.bumpMyGrounds(player._id, doneIn(after))) ?? player };
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
    // The same answer whichever of the player's guilds is asked: progress is the player's own.
    async view({ me, player, params }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner', 'officer', 'member');
      player = await seed(player);
      const p = (await store.getMyGrounds(me))?.p ?? {};
      const taskOut = (task) => {
        const need = task.need * UNIT;
        const have = Math.min(need, p[task.id] ?? 0);
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
          // Kept for 0.6.0 and 0.6.1, which showed a guild's contributors.
          mine: have,
          top: [],
        };
      };
      return {
        rev: player.groundsRev ?? 0,
        unit: UNIT,
        tiers: TIERS.map((tier) => ({
          id: tier.id,
          name: tier.name,
          locations: tier.locations.map((loc) => {
            const tasks = loc.tasks.map(taskOut);
            return { id: loc.id, name: loc.name, bonus: loc.bonus, done: tasks.every((t) => t.have >= t.need), tasks };
          }),
        })),
      };
    },

    // The donor's game has already removed `qty` of `item`. Replies with how many were accepted;
    // the game puts the others back. The same nonce always gets the same answer.
    async donate({ me, player, params, body }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner', 'officer', 'member');
      const task = TASKS.get(body.task);
      if (!task || task.kind !== 'donate') throw bad('bad_task', 'That is not a task items can be donated to');
      const worth = WORTHS.get(task.group).get(body.item);
      if (!worth) throw bad('bad_item', 'That item is not accepted for this task');
      if (!isInt(body.qty, 1, G.maxQty)) throw bad('bad_qty', `Quantity must be 1 to ${G.maxQty}`);
      if (typeof body.nonce !== 'string' || !NONCE_RE.test(body.nonce)) throw bad('bad_nonce', 'Missing donation id');

      const giftId = await store.insertGift({
        playerId: me, nonce: body.nonce, guildId: ctx.gid, task: task.id, item: body.item, qty: body.qty, accepted: null, at: new Date(now()),
      });
      if (!giftId) {
        // Sent before. If that attempt never finished, nothing is accepted now: the game refunds the
        // items, and the player keeps any progress the first attempt did record.
        const old = await store.getGift(me, body.nonce);
        return { accepted: old?.accepted ?? 0, qty: old?.qty ?? body.qty };
      }

      const { accepted } = await apply(player, new Map([[task.id, body.qty * worth]]));
      const points = accepted.get(task.id) ?? 0;
      // A trimmed donation takes just enough items to finish the task.
      const qty = points >= body.qty * worth ? body.qty : Math.ceil(points / worth);
      await store.setGiftAccepted(giftId, qty);
      return { accepted: qty, qty: body.qty };
    },
  };

  return {
    /**
     * Counts from /sync: `{seq, counts: {counterId: {objectId: n}}}`, how much the game's counters grew.
     * Each batch number is applied once. Returns the batch number to acknowledge (null if the body
     * was unusable) and the player document afterwards.
     */
    async applyCounts(player, body) {
      if (body == null || typeof body !== 'object' || !isInt(body.seq, 1, 1e15)) return { ack: null, player };
      const ack = body.seq;
      if (!(await store.takeGroundsSeq(player._id, body.seq))) return { ack, player };

      const counts = vCounts(body.counts);
      const adds = new Map();
      for (const task of TASKS.values()) {
        const entries = task.stat && counts.get(task.stat);
        if (!entries) continue;
        let n = 0;
        for (const [id, count] of entries) if (!task.ids || task.ids.includes(id)) n += count;
        if (n > 0) adds.set(task.id, Math.min(n, G.maxCount) * UNIT);
      }
      return { ack, player: (await apply(player, adds)).player };
    },
    /** The player document with their own grounds in place (see `seed`). */
    ready: seed,
    routes: [
      ['GET', 'guilds/:id/grounds', h.view],
      ['POST', 'guilds/:id/grounds/donate', h.donate],
    ],
  };
}
