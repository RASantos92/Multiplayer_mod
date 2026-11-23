// Data access for Guild Grounds. Mixed into the main store (see store.js).
//
// grounds:       one document per guild, `p.<taskId>` = progress in thousandths of a unit.
// groundsTotals: one document per guild and player, `t.<taskId>` = what that player contributed.
// groundsGifts:  one document per donation, keyed by the donor's nonce, so a donation sent twice
//                (after a crash or a lost reply) is only counted once.
// Also on the guild document: `groundsRev` (changes whenever progress does) and `groundsDone`
// (ids of completed locations), so /sync can report both without another query.

const DAY = 24 * 60 * 60;
const isDup = (e) => e?.code === 11000;

export function createGroundsStore(db) {
  const guilds = db.collection('guilds');
  const players = db.collection('players');
  const grounds = db.collection('grounds');
  const totals = db.collection('groundsTotals');
  const gifts = db.collection('groundsGifts');

  return {
    groundsIndexes: () => [
      totals.createIndex({ guildId: 1, playerId: 1 }, { unique: true }),
      totals.createIndex({ playerId: 1 }),
      gifts.createIndex({ playerId: 1, nonce: 1 }, { unique: true }),
      gifts.createIndex({ at: 1 }, { expireAfterSeconds: 30 * DAY }),
    ],

    getGrounds: (guildId) => grounds.findOne({ _id: guildId }),

    /**
     * Adds progress to several tasks in one atomic update, never past a task's `need`.
     * `adds` is [{task, add, need}] in thousandths. Returns the progress as it was BEFORE (`{task: n}`),
     * so the caller can work out how much of each add was accepted.
     */
    async addGroundsProgress(guildId, adds) {
      const set = {};
      for (const { task, add, need } of adds) {
        set[`p.${task}`] = { $min: [need, { $add: [{ $ifNull: [`$p.${task}`, 0] }, add] }] };
      }
      const op = () => grounds.findOneAndUpdate({ _id: guildId }, [{ $set: set }], { upsert: true, returnDocument: 'before' });
      let before;
      try {
        before = await op();
      } catch (e) {
        if (!isDup(e)) throw e; // two first contributions raced to create the document
        before = await op();
      }
      return before?.p ?? {};
    },

    /** Records what a player contributed. `incs` is {task: thousandths}. */
    creditGrounds: (guildId, playerId, name, incs) =>
      totals.updateOne(
        { guildId, playerId },
        { $inc: Object.fromEntries(Object.entries(incs).map(([task, n]) => [`t.${task}`, n])), $set: { name } },
        { upsert: true },
      ),
    groundsTotals: (guildId) => totals.find({ guildId }).limit(500).toArray(),

    /** Marks the guild's grounds as changed and records completed locations. Returns the guild afterwards. */
    bumpGrounds: (guildId, done) =>
      guilds.findOneAndUpdate(
        { _id: guildId },
        { $inc: { groundsRev: 1 }, ...(done.length ? { $addToSet: { groundsDone: { $each: done } } } : {}) },
        { returnDocument: 'after' },
      ),

    /** Returns the new id, or false when this player already sent a donation with the same nonce. */
    async insertGift(doc) {
      try {
        const r = await gifts.insertOne(doc);
        return r.insertedId;
      } catch (e) {
        if (isDup(e)) return false;
        throw e;
      }
    },
    getGift: (playerId, nonce) => gifts.findOne({ playerId, nonce }),
    setGiftAccepted: (id, accepted) => gifts.updateOne({ _id: id }, { $set: { accepted } }),

    /** True for the first caller with a batch number newer than any this player has sent. */
    async takeGroundsSeq(playerId, seq) {
      const r = await players.updateOne(
        { _id: playerId, $or: [{ groundsSeq: { $exists: false } }, { groundsSeq: { $lt: seq } }] },
        { $set: { groundsSeq: seq } },
      );
      return r.modifiedCount === 1;
    },

    purgeGroundsOfGuild: (guildId) => Promise.all([grounds.deleteOne({ _id: guildId }), totals.deleteMany({ guildId })]),
    purgeGroundsOfPlayer: (playerId) => Promise.all([totals.deleteMany({ playerId }), gifts.deleteMany({ playerId })]),
  };
}
