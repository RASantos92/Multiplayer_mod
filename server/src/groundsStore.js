// Data access for Guild Grounds. Mixed into the main store (see store.js).
//
// groundsMine:   one document per player, `p.<taskId>` = progress in thousandths of a unit.
// groundsGifts:  one document per donation, keyed by the donor's nonce, so a donation sent twice
//                (after a crash or a lost reply) is only counted once.
// Also on the player document: `groundsRev` (changes whenever progress does), `groundsDone` (ids of
// completed locations) and `groundsSeeded`, so /sync can report them without another query.
//
// From the time progress was shared by a guild (up to 0.6.1), only read to start players off:
// groundsTotals: one document per guild and player, `t.<taskId>` = what that player contributed.
// grounds:       one document per guild; no longer used.

const DAY = 24 * 60 * 60;
const isDup = (e) => e?.code === 11000;

export function createGroundsStore(db) {
  const players = db.collection('players');
  const grounds = db.collection('grounds');
  const mine = db.collection('groundsMine');
  const totals = db.collection('groundsTotals');
  const gifts = db.collection('groundsGifts');

  return {
    groundsIndexes: () => [
      totals.createIndex({ guildId: 1, playerId: 1 }, { unique: true }),
      totals.createIndex({ playerId: 1 }),
      gifts.createIndex({ playerId: 1, nonce: 1 }, { unique: true }),
      gifts.createIndex({ at: 1 }, { expireAfterSeconds: 30 * DAY }),
    ],

    getMyGrounds: (playerId) => mine.findOne({ _id: playerId }),
    groundsTotalsOf: (playerId) => totals.find({ playerId }).limit(20).toArray(),
    /** Creates the player's progress document; does nothing if it is already there. */
    async insertMyGrounds(playerId, p) {
      try {
        await mine.insertOne({ _id: playerId, p });
      } catch (e) {
        if (!isDup(e)) throw e;
      }
    },
    /** Starts the change counter well above any a guild had, so every game reloads its view once. */
    markGroundsSeeded: (playerId, done) =>
      players.findOneAndUpdate(
        { _id: playerId },
        { $set: { groundsSeeded: true, groundsRev: 1_000_000, groundsDone: done } },
        { returnDocument: 'after' },
      ),

    /**
     * Adds progress to several tasks in one atomic update, never past a task's `need`.
     * `adds` is [{task, add, need}] in thousandths. Returns the progress as it was BEFORE (`{task: n}`),
     * so the caller can work out how much of each add was accepted.
     */
    async addMyGroundsProgress(playerId, adds) {
      const set = {};
      for (const { task, add, need } of adds) {
        set[`p.${task}`] = { $min: [need, { $add: [{ $ifNull: [`$p.${task}`, 0] }, add] }] };
      }
      const op = () => mine.findOneAndUpdate({ _id: playerId }, [{ $set: set }], { upsert: true, returnDocument: 'before' });
      let before;
      try {
        before = await op();
      } catch (e) {
        if (!isDup(e)) throw e; // two first contributions raced to create the document
        before = await op();
      }
      return before?.p ?? {};
    },

    /** Marks the player's grounds as changed and records completed locations. Returns the player afterwards. */
    bumpMyGrounds: (playerId, done) =>
      players.findOneAndUpdate(
        { _id: playerId },
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

    // What members gave to a disbanded guild stays until each of them has been started off with it.
    purgeGroundsOfGuild: (guildId) => grounds.deleteOne({ _id: guildId }),
    // Also for a ban, which keeps the player document: their finished locations go with their progress.
    purgeGroundsOfPlayer: (playerId) =>
      Promise.all([
        mine.deleteOne({ _id: playerId }),
        totals.deleteMany({ playerId }),
        gifts.deleteMany({ playerId }),
        players.updateOne({ _id: playerId }, { $set: { groundsDone: [] }, $inc: { groundsRev: 1 } }),
      ]),
  };
}
