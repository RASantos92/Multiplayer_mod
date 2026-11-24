// Data access for Guild Grounds. Mixed into the main store (see store.js).
//
// groundsGuild:   one document per guild, `p.<taskId>` = progress this round, in thousandths of a unit.
// groundsGivers:  one document per guild and player, `t.<taskId>` = what that player gave this round.
// groundsGifts:   one document per donation, keyed by the donor's nonce, so a donation sent twice
//                 (after a crash or a lost reply) is only counted once.
// On the guild document, so /sync can report them without another query:
//   groundsRev     changes whenever the guild's grounds do
//   groundsDone    {locationId: Date} when each finished location's bonus ends
//   groundsPooled  true once the guild has been started off (see `pool` in grounds.js)
// On the player document: `groundsSeq`, the last batch of counts taken from them.
//
// From 0.6.2 to 0.6.5 progress belonged to each player:
// groundsMine:    one document per player, `p.<taskId>`. Only read to start guilds off.
// groundsTotals, grounds: older still; no longer used.

const DAY = 24 * 60 * 60;
const isDup = (e) => e?.code === 11000;

export function createGroundsStore(db) {
  const players = db.collection('players');
  const guilds = db.collection('guilds');
  const old = db.collection('grounds');
  const shared = db.collection('groundsGuild');
  const givers = db.collection('groundsGivers');
  const mine = db.collection('groundsMine');
  const totals = db.collection('groundsTotals');
  const gifts = db.collection('groundsGifts');

  return {
    groundsIndexes: () => [
      givers.createIndex({ guildId: 1, playerId: 1 }, { unique: true }),
      givers.createIndex({ playerId: 1 }),
      totals.createIndex({ guildId: 1, playerId: 1 }, { unique: true }),
      totals.createIndex({ playerId: 1 }),
      gifts.createIndex({ playerId: 1, nonce: 1 }, { unique: true }),
      gifts.createIndex({ at: 1 }, { expireAfterSeconds: 30 * DAY }),
    ],

    /** The guild's progress this round: `{taskId: thousandths}`. */
    guildGrounds: async (guildId) => (await shared.findOne({ _id: guildId }))?.p ?? {},
    giversOf: (guildId) => givers.find({ guildId }).limit(100).toArray(),
    myGroundsOf: (playerIds) => mine.find({ _id: { $in: playerIds } }).toArray(),

    /** Creates the guild's progress and its givers; does nothing for what is already there. */
    async insertGuildGrounds(guildId, p, given) {
      try {
        await shared.insertOne({ _id: guildId, p });
      } catch (e) {
        if (!isDup(e)) throw e;
      }
      await Promise.all(given.map(({ playerId, t }) =>
        givers.updateOne({ guildId, playerId }, { $setOnInsert: { t } }, { upsert: true }).catch((e) => {
          if (!isDup(e)) throw e;
        })));
    },
    /** Marks the guild as started off, for the first caller only. Returns the guild afterwards, or null. */
    markGroundsPooled: (guildId, rev) =>
      guilds.findOneAndUpdate(
        { _id: guildId, groundsPooled: { $ne: true } },
        { $set: { groundsPooled: true, groundsRev: rev } },
        { returnDocument: 'after' },
      ),

    /**
     * Adds progress to several tasks in one atomic update, never past a task's `need`.
     * `adds` is [{task, add, need}] in thousandths. Returns the progress as it was BEFORE (`{task: n}`),
     * so the caller can work out how much of each add was accepted.
     */
    async addGuildProgress(guildId, adds) {
      const set = {};
      for (const { task, add, need } of adds) {
        // Progress above `need` (the guild shrank) is left alone rather than cut down.
        set[`p.${task}`] = { $max: [{ $ifNull: [`$p.${task}`, 0] }, { $min: [need, { $add: [{ $ifNull: [`$p.${task}`, 0] }, add] }] }] };
      }
      const op = () => shared.findOneAndUpdate({ _id: guildId }, [{ $set: set }], { upsert: true, returnDocument: 'before' });
      let before;
      try {
        before = await op();
      } catch (e) {
        if (!isDup(e)) throw e; // two first contributions raced to create the document
        before = await op();
      }
      return before?.p ?? {};
    },
    /** Records what a player gave: `given` is {taskId: thousandths}. */
    async addGiven(guildId, playerId, given) {
      const inc = Object.fromEntries(Object.entries(given).map(([task, n]) => [`t.${task}`, n]));
      const op = () => givers.updateOne({ guildId, playerId }, { $inc: inc }, { upsert: true });
      try {
        await op();
      } catch (e) {
        if (!isDup(e)) throw e;
        await op();
      }
    },

    /** Marks the guild's grounds as changed. Returns the guild afterwards. */
    bumpGrounds: (guildId, by = 1) =>
      guilds.findOneAndUpdate({ _id: guildId }, { $inc: { groundsRev: by } }, { returnDocument: 'after' }),

    /**
     * Finishes a location: its bonus now runs until `until`, and its tasks start again from nothing.
     * Only the first caller to move it on from `was` (the end date it had, or null) wins; returns the
     * guild afterwards, or null for everyone else.
     */
    async completeLocation(guildId, location, was, until, taskIds) {
      const key = `groundsDone.${location}`;
      const guild = await guilds.findOneAndUpdate(
        { _id: guildId, [key]: was ?? { $exists: false } },
        { $set: { [key]: until }, $inc: { groundsRev: 3 } },
        { returnDocument: 'after' },
      );
      if (!guild) return null;
      await Promise.all([
        shared.updateOne({ _id: guildId }, { $set: Object.fromEntries(taskIds.map((id) => [`p.${id}`, 0])) }),
        givers.updateMany({ guildId }, { $unset: Object.fromEntries(taskIds.map((id) => [`t.${id}`, ''])) }),
      ]);
      return guild;
    },

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

    purgeGroundsOfGuild: (guildId) =>
      Promise.all([
        shared.deleteOne({ _id: guildId }),
        givers.deleteMany({ guildId }),
        totals.deleteMany({ guildId }),
        old.deleteOne({ _id: guildId }),
      ]),
    // The guild keeps the progress; only the player's name on it goes.
    purgeGroundsOfPlayer: (playerId) =>
      Promise.all([
        givers.deleteMany({ playerId }),
        mine.deleteOne({ _id: playerId }),
        totals.deleteMany({ playerId }),
        gifts.deleteMany({ playerId }),
      ]),
  };
}
