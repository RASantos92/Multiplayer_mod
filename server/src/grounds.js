// Guild Grounds handlers. A guild works through tasks at locations; when every task at a location
// is done, the location's bonus applies to all members.
//
//   donate  the member's game removes the items from the bank, then POSTs the donation. The reply
//           says how many were accepted; the game puts the rest back.
//   counts  kills, Agility laps and Thieving successes ride on /sync as numbered batches.
//
// The server cannot see anyone's game: counts and donations are taken on trust, within sanity limits.
import { HttpError } from './app.js';
import { GROUPS, STEP, TIERS } from './groundsData.js';

export const GROUNDS_LIMITS = {
  maxQty: 1_000_000, // items in one donation
  maxCount: 100_000, // one kind of event in one batch
  maxEntries: 60, // different monsters, courses or targets in one batch
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
const COUNT_KINDS = { kill: ['kills', 'enemies'], lap: ['laps', 'courses'], steal: ['steals', 'targets'] };
const BONUS = new Map(LOCATIONS.map((loc) => [loc.id, loc.bonus]));

/** The bonuses a guild has earned, for /sync: [{id, value}] with `value` in percent. */
export function bonusesOf(guild) {
  // Two locations with the same kind of bonus add up.
  const sum = new Map();
  for (const id of guild.groundsDone ?? []) {
    const b = BONUS.get(id);
    if (b) sum.set(b.id, (sum.get(b.id) ?? 0) + b.value);
  }
  return [...sum].map(([id, value]) => ({ id, value }));
}

export function createGrounds({ store, now, guildCtx, requireRank, limits = {} }) {
  const G = { ...GROUNDS_LIMITS, ...limits };

  /**
   * Adds progress (`adds`: Map of task id to thousandths) for one guild on behalf of a player.
   * Returns { accepted: Map(task -> thousandths), guild } where `guild` is the updated guild
   * document when anything changed, else null.
   */
  async function apply(guildId, player, adds) {
    const list = [...adds].filter(([, add]) => add > 0).map(([task, add]) => ({ task, add, need: TASKS.get(task).need * UNIT }));
    const accepted = new Map();
    if (!list.length) return { accepted, guild: null };

    const before = await store.addGroundsProgress(guildId, list);
    const after = { ...before };
    for (const { task, add, need } of list) {
      const had = Math.min(need, before[task] ?? 0);
      const got = Math.min(need, had + add) - had;
      after[task] = had + got;
      if (got > 0) accepted.set(task, got);
    }
    if (!accepted.size) return { accepted, guild: null };

    await store.creditGrounds(guildId, player.id, player.name, Object.fromEntries(accepted));
    const done = LOCATIONS.filter((loc) => loc.tasks.every((t) => (after[t.id] ?? 0) >= t.need * UNIT)).map((loc) => loc.id);
    return { accepted, guild: await store.bumpGrounds(guildId, done) };
  }

  /** {id: count} from a batch, dropping anything malformed. */
  function vCounts(v) {
    const out = [];
    if (v == null || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const [id, n] of Object.entries(v).slice(0, G.maxEntries)) {
      if (GAME_ID_RE.test(id) && isInt(n, 1, G.maxCount)) out.push([id, n]);
    }
    return out;
  }

  const h = {
    async view({ me, params }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner', 'officer', 'member');
      const [doc, totals] = await Promise.all([store.getGrounds(ctx.gid), store.groundsTotals(ctx.gid)]);
      const p = doc?.p ?? {};
      const taskOut = (task) => {
        const need = task.need * UNIT;
        const gave = totals
          .map((t) => ({ id: t.playerId, name: t.name, amount: t.t?.[task.id] ?? 0 }))
          .filter((t) => t.amount > 0)
          .sort((a, b) => b.amount - a.amount);
        return {
          id: task.id,
          kind: task.kind,
          text: task.text,
          need,
          have: Math.min(need, p[task.id] ?? 0),
          ...(task.kind === 'donate' ? { items: [...WORTHS.get(task.group)].map(([item, worth]) => ({ item, worth })) } : {}),
          ...(task.enemies ? { enemies: task.enemies } : {}),
          mine: gave.find((t) => t.id === me)?.amount ?? 0,
          top: gave.slice(0, G.topContributors),
        };
      };
      return {
        rev: ctx.guild.groundsRev ?? 0,
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
        // items, and the guild keeps any progress the first attempt did record.
        const old = await store.getGift(me, body.nonce);
        return { accepted: old?.accepted ?? 0, qty: old?.qty ?? body.qty };
      }

      const { accepted } = await apply(ctx.gid, { id: me, name: player.name }, new Map([[task.id, body.qty * worth]]));
      const points = accepted.get(task.id) ?? 0;
      // A trimmed donation takes just enough items to finish the task.
      const qty = points >= body.qty * worth ? body.qty : Math.ceil(points / worth);
      await store.setGiftAccepted(giftId, qty);
      return { accepted: qty, qty: body.qty };
    },
  };

  return {
    /**
     * Counts from /sync: `{seq, kills: {enemyId: n}, laps: {courseId: n}, steals: {targetId: n}}`.
     * Each batch number is applied once, to every guild the player is in. Returns the batch number
     * to acknowledge (null if the body was unusable) and the guild documents that changed.
     */
    async applyCounts(player, guildIds, body) {
      if (body == null || typeof body !== 'object' || !isInt(body.seq, 1, 1e15)) return { ack: null, changed: [] };
      const ack = body.seq;
      if (!(await store.takeGroundsSeq(player.id, body.seq))) return { ack, changed: [] };

      const adds = new Map();
      for (const task of TASKS.values()) {
        const kind = COUNT_KINDS[task.kind];
        if (!kind) continue;
        const only = task[kind[1]];
        let n = 0;
        for (const [id, count] of vCounts(body[kind[0]])) if (!only || only.includes(id)) n += count;
        if (n > 0) adds.set(task.id, Math.min(n, G.maxCount) * UNIT);
      }
      const changed = [];
      for (const gid of guildIds) {
        const { guild } = await apply(gid, player, adds);
        if (guild) changed.push(guild);
      }
      return { ack, changed };
    },
    routes: [
      ['GET', 'guilds/:id/grounds', h.view],
      ['POST', 'guilds/:id/grounds/donate', h.donate],
    ],
  };
}
