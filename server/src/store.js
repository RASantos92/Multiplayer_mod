// Thin data-access layer. Handlers in app.js only talk to MongoDB through this
// module, so they can be exercised against any database handle (tests use
// mongodb-memory-server).

import { createMarketStore } from './marketStore.js';

const DAY = 24 * 60 * 60;
const isDup = (e) => e?.code === 11000;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createStore(db) {
  const players = db.collection('players');
  const guilds = db.collection('guilds');
  const members = db.collection('members');
  const requests = db.collection('requests');
  const messages = db.collection('messages');
  const ratelimits = db.collection('ratelimits');

  const market = createMarketStore(db);
  let initPromise;

  /** insertOne that reports a duplicate key as `false` instead of throwing. */
  async function tryInsert(col, doc) {
    try {
      const r = await col.insertOne(doc);
      return r.insertedId;
    } catch (e) {
      if (isDup(e)) return false;
      throw e;
    }
  }

  return {
    ...market,
    /** Create indexes once per process (idempotent on the server). */
    init() {
      initPromise ??= Promise.all([
        guilds.createIndex({ nameLower: 1 }, { unique: true }),
        guilds.createIndex({ ownerId: 1 }),
        members.createIndex({ guildId: 1, playerId: 1 }, { unique: true }),
        members.createIndex({ playerId: 1 }),
        requests.createIndex({ guildId: 1, playerId: 1 }, { unique: true }),
        requests.createIndex({ playerId: 1, kind: 1 }),
        messages.createIndex({ guildId: 1, at: 1 }),
        messages.createIndex({ playerId: 1 }),
        messages.createIndex({ at: 1 }, { expireAfterSeconds: 14 * DAY }),
        ratelimits.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
        ...market.marketIndexes(),
      ]).catch((e) => {
        initPromise = undefined;
        throw e;
      });
      return initPromise;
    },

    ping: () => db.command({ ping: 1 }),

    // ---- rate limiting (fixed window counter) ----
    /** Count one hit; returns true while the caller is within `limit` per window. */
    async hit(key, limit, windowMs, nowMs) {
      const start = Math.floor(nowMs / windowMs) * windowMs;
      const op = () =>
        ratelimits.findOneAndUpdate(
          { _id: `${key}:${windowMs}:${start}` },
          { $inc: { n: 1 }, $setOnInsert: { expireAt: new Date(start + windowMs + 60_000) } },
          { upsert: true, returnDocument: 'after' },
        );
      let doc;
      try {
        doc = await op();
      } catch (e) {
        if (!isDup(e)) throw e;
        doc = await op(); // two concurrent upserts raced; the retry is a plain update
      }
      return doc.n <= limit;
    },

    // ---- players ----
    getPlayer: (id) => players.findOne({ _id: id }),
    insertPlayer: async (doc) => (await tryInsert(players, doc)) !== false,
    setPlayerName: (id, name) => players.updateOne({ _id: id }, { $set: { name } }),
    /** Authenticates and updates in one round trip. Returns the updated player or null. */
    touchPlayer: (id, keyHash, set) =>
      players.findOneAndUpdate({ _id: id, keyHash, banned: { $ne: true } }, { $set: set }, { returnDocument: 'after' }),
    setBanned: (id, banned) => players.updateOne({ _id: id }, banned ? { $set: { banned: true, status: null } } : { $unset: { banned: '' } }),
    findPlayersByName: (q, limit) =>
      players.find({ name: { $regex: escapeRegex(q), $options: 'i' } }).sort({ lastSeen: -1 }).limit(limit).toArray(),
    deletePlayer: (id) => players.deleteOne({ _id: id }),
    countPlayers: (filter = {}) => players.countDocuments(filter),
    countGuilds: () => guilds.countDocuments({}),
    /** Admin: forget the player's key so their next register can set a new one. */
    resetPlayerKey: (id) => players.updateOne({ _id: id }, { $set: { keyHash: null } }),
    /** Sets a new key on a player whose key was reset. False if someone else got there first. */
    async claimPlayer(id, keyHash, name) {
      const r = await players.updateOne({ _id: id, keyHash: null }, { $set: { keyHash, name } });
      return r.modifiedCount === 1;
    },
    setProfile: (id, profile) => players.updateOne({ _id: id }, { $set: { profile } }),
    /** True when the two players are members of at least one common guild. */
    async shareGuild(a, b) {
      const mine = await members.find({ playerId: a }, { projection: { guildId: 1 } }).toArray();
      if (!mine.length) return false;
      return (await members.countDocuments({ playerId: b, guildId: { $in: mine.map((m) => m.guildId) } }, { limit: 1 })) > 0;
    },

    // ---- guilds ----
    /** Returns the new id, or false when the name is taken. */
    insertGuild: (doc) => tryInsert(guilds, doc),
    getGuild: (id) => guilds.findOne({ _id: id }),
    getGuildByName: (nameLower) => guilds.findOne({ nameLower }),
    /** Returns 'ok', 'dup' (name taken) or 'missing'. */
    async updateGuild(id, set) {
      try {
        const r = await guilds.updateOne({ _id: id }, { $set: set });
        return r.matchedCount ? 'ok' : 'missing';
      } catch (e) {
        if (isDup(e)) return 'dup';
        throw e;
      }
    },
    /** Atomic ownership swap; false if `from` is no longer the owner. */
    async setOwner(id, from, to) {
      const r = await guilds.updateOne({ _id: id, ownerId: from }, { $set: { ownerId: to } });
      return r.matchedCount === 1;
    },
    deleteGuild: (id) => guilds.deleteOne({ _id: id }),
    countOwned: (playerId) => guilds.countDocuments({ ownerId: playerId }),
    async searchGuilds(qLower, limit) {
      const filter = qLower ? { nameLower: { $regex: escapeRegex(qLower) } } : {};
      const found = await guilds.find(filter).sort({ nameLower: 1 }).limit(limit).toArray();
      if (!found.length) return [];
      const counts = await members
        .aggregate([
          { $match: { guildId: { $in: found.map((g) => g._id) } } },
          { $group: { _id: '$guildId', n: { $sum: 1 } } },
        ])
        .toArray();
      const byId = new Map(counts.map((c) => [String(c._id), c.n]));
      return found.map((guild) => ({ guild, memberCount: byId.get(String(guild._id)) ?? 0 }));
    },

    // ---- members ----
    getMember: (guildId, playerId) => members.findOne({ guildId, playerId }),
    insertMember: async (doc) => (await tryInsert(members, doc)) !== false,
    countMembers: (guildId) => members.countDocuments({ guildId }),
    countGuildsOf: (playerId) => members.countDocuments({ playerId }),
    setRank: (guildId, playerId, rank) => members.updateOne({ guildId, playerId }, { $set: { rank } }),
    async deleteMember(guildId, playerId) {
      const r = await members.deleteOne({ guildId, playerId });
      return r.deletedCount === 1;
    },
    /** My memberships joined with their guild: [{ member, guild }]. */
    async membershipsOf(playerId) {
      const rows = await members
        .aggregate([
          { $match: { playerId } },
          { $lookup: { from: 'guilds', localField: 'guildId', foreignField: '_id', as: 'g' } },
        ])
        .toArray();
      return rows.filter((r) => r.g.length).map(({ g, ...member }) => ({ member, guild: g[0] }));
    },
    /** All members of the given guilds joined with their player record. */
    async rosters(guildIds) {
      if (!guildIds.length) return [];
      const rows = await members
        .aggregate([
          { $match: { guildId: { $in: guildIds } } },
          { $lookup: { from: 'players', localField: 'playerId', foreignField: '_id', as: 'p' } },
          { $project: { guildId: 1, playerId: 1, rank: 1, joinedAt: 1, 'p.name': 1, 'p.lastSeen': 1, 'p.status': 1 } },
        ])
        .toArray();
      return rows.map(({ p, ...m }) => ({
        ...m,
        name: p[0]?.name ?? 'Unknown',
        lastSeen: p[0]?.lastSeen ?? null,
        status: p[0]?.status ?? null,
      }));
    },

    // ---- join requests and invites ----
    getRequest: (guildId, playerId) => requests.findOne({ guildId, playerId }),
    insertRequest: async (doc) => (await tryInsert(requests, doc)) !== false,
    async deleteRequest(guildId, playerId, kind) {
      const r = await requests.deleteOne(kind ? { guildId, playerId, kind } : { guildId, playerId });
      return r.deletedCount === 1;
    },
    countRequestsOf: (playerId, kind) => requests.countDocuments({ playerId, kind }),
    countRequestsFor: (guildId) => requests.countDocuments({ guildId }),
    /** Pending requests and invites of a guild, with the player's name. */
    async listRequests(guildId) {
      const rows = await requests
        .aggregate([
          { $match: { guildId } },
          { $lookup: { from: 'players', localField: 'playerId', foreignField: '_id', as: 'p' } },
          { $sort: { at: 1 } },
        ])
        .toArray();
      return rows.map((r) => ({ playerId: r.playerId, name: r.p[0]?.name ?? 'Unknown', kind: r.kind, by: r.by, at: r.at }));
    },
    /** A player's pending requests and invites, with guild name and inviter name. */
    async requestsOf(playerId) {
      const rows = await requests
        .aggregate([
          { $match: { playerId } },
          { $lookup: { from: 'guilds', localField: 'guildId', foreignField: '_id', as: 'g' } },
          { $lookup: { from: 'players', localField: 'by', foreignField: '_id', as: 'b' } },
          { $sort: { at: 1 } },
        ])
        .toArray();
      return rows
        .filter((r) => r.g.length)
        .map((r) => ({
          guildId: r.guildId,
          guildName: r.g[0].name,
          kind: r.kind,
          by: r.by,
          byName: r.b[0]?.name ?? 'Unknown',
          at: r.at,
        }));
    },

    // ---- messages ----
    insertMessage: (doc) => tryInsert(messages, doc),
    /** Messages newer than `after`, oldest first. */
    messagesSince(guildIds, after, limit) {
      if (!guildIds.length) return Promise.resolve([]);
      return messages
        .find({ guildId: { $in: guildIds }, at: { $gt: after } })
        .sort({ at: 1, _id: 1 })
        .limit(limit)
        .toArray();
    },
    /** The latest `limit` messages, returned oldest first. */
    async latestMessages(guildIds, limit) {
      if (!guildIds.length) return [];
      const rows = await messages
        .find({ guildId: { $in: guildIds } })
        .sort({ at: -1, _id: -1 })
        .limit(limit)
        .toArray();
      return rows.reverse();
    },

    // ---- bulk removal ----
    /** Remove everything that hangs off a guild (not the guild document itself). */
    purgeGuildChildren: (guildId, { withMessages = true } = {}) =>
      Promise.all([
        members.deleteMany({ guildId }),
        requests.deleteMany({ guildId }),
        withMessages ? messages.deleteMany({ guildId }) : null,
        market.purgeMarketOfGuild(guildId),
      ]),
    /** Remove everything that hangs off a player (not the player document itself). */
    purgePlayerChildren: (playerId) =>
      Promise.all([
        members.deleteMany({ playerId }),
        requests.deleteMany({ $or: [{ playerId }, { by: playerId, kind: 'invite' }] }),
        messages.deleteMany({ playerId }),
        market.purgeMarketOfPlayer(playerId),
      ]),
  };
}
