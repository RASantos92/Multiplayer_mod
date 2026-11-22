// Data access for the guild marketplace. Mixed into the main store (see store.js).
//
// listings: items a member has put up for sale. `qty` is what is still available; buying reserves
//           from it with one conditional update, so two buyers can never get the same items.
// offers:   a buyer's lower bid on a listing, waiting for the seller.
// claims:   things a player's game still has to apply to its own bank and then confirm:
//           purchase (pay gold, receive items), payout (receive gold), return (receive items back).

const DAY = 24 * 60 * 60;
const isDup = (e) => e?.code === 11000;

export function createMarketStore(db) {
  const guilds = db.collection('guilds');
  const listings = db.collection('listings');
  const offers = db.collection('offers');
  const claims = db.collection('claims');
  const live = { state: { $in: ['open', 'sold'] } };

  return {
    marketIndexes: () => [
      listings.createIndex({ guildId: 1, state: 1, createdAt: 1 }),
      listings.createIndex({ sellerId: 1, state: 1 }),
      listings.createIndex({ state: 1, expireAt: 1 }),
      listings.createIndex({ sellerId: 1, nonce: 1 }, { unique: true, partialFilterExpression: { nonce: { $type: 'string' } } }),
      offers.createIndex({ listingId: 1, buyerId: 1 }, { unique: true }),
      offers.createIndex({ guildId: 1, buyerId: 1 }),
      offers.createIndex({ guildId: 1, sellerId: 1 }),
      offers.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
      claims.createIndex({ playerId: 1, state: 1 }),
      claims.createIndex({ state: 1, kind: 1, at: 1 }),
      claims.createIndex({ sellerId: 1, state: 1 }, { partialFilterExpression: { sellerId: { $type: 'string' } } }),
      // One follow-up claim per cause (a payout per confirmed purchase, a return per cancelled listing...).
      claims.createIndex({ source: 1 }, { unique: true, partialFilterExpression: { source: { $type: 'string' } } }),
      // Finished claims are only kept for a while, as a record.
      claims.createIndex({ doneAt: 1 }, { expireAfterSeconds: 30 * DAY }),
    ],

    /** Tells open Marketplace tabs (through /sync) that this guild's market changed. */
    bumpMarket: (guildId) => guilds.updateOne({ _id: guildId }, { $inc: { marketRev: 1 } }),

    // ---- listings ----
    /** Returns the new id, or false when this seller already sent a listing with the same nonce. */
    async insertListing(doc) {
      try {
        const r = await listings.insertOne(doc);
        return r.insertedId;
      } catch (e) {
        if (isDup(e)) return false;
        throw e;
      }
    },
    listingByNonce: (sellerId, nonce) => listings.findOne({ sellerId, nonce }),
    getListing: (id) => listings.findOne({ _id: id }),
    countOpenListings: (guildId, sellerId) => listings.countDocuments({ guildId, sellerId, state: 'open' }),
    listListings: (guildId) => listings.find({ guildId, state: 'open', qty: { $gt: 0 } }).sort({ createdAt: 1 }).limit(500).toArray(),
    hasLiveListings: async (sellerId) => (await listings.countDocuments({ sellerId, state: 'open', qty: { $gt: 0 } }, { limit: 1 })) > 0,

    /**
     * Takes `qty` out of an open listing if that many are left (and, when given, the price still matches).
     * Returns the listing after the change, or null when it could not be reserved.
     */
    async reserveListing(id, guildId, qty, price) {
      const doc = await listings.findOneAndUpdate(
        { _id: id, guildId, state: 'open', qty: { $gte: qty }, ...(price == null ? {} : { price }) },
        { $inc: { qty: -qty } },
        { returnDocument: 'after' },
      );
      if (doc && doc.qty === 0) await listings.updateOne({ _id: id, qty: 0, state: 'open' }, { $set: { state: 'sold' } });
      return doc;
    },
    /** Puts reserved items back. Returns null if the listing was cancelled or expired meanwhile. */
    restoreListing: (id, qty) =>
      listings.findOneAndUpdate({ _id: id, ...live }, { $inc: { qty }, $set: { state: 'open' } }, { returnDocument: 'after' }),
    /** Ends a listing and returns it as it was (its `qty` is what goes back to the seller), or null. */
    endListing: (filter, state) =>
      listings.findOneAndUpdate({ ...filter, ...live }, { $set: { state, qty: 0, endedAt: new Date() } }, { returnDocument: 'before' }),
    liveListingsOf: (filter) => listings.find({ ...filter, ...live }).limit(1000).toArray(),
    expiredListings: (now, limit) => listings.find({ state: 'open', expireAt: { $lt: now } }).limit(limit).toArray(),

    // ---- offers ----
    /** One open offer per buyer per listing: a new one replaces the old. Returns the stored offer. */
    async putOffer(doc) {
      const op = () =>
        offers.findOneAndUpdate({ listingId: doc.listingId, buyerId: doc.buyerId }, { $set: doc }, { upsert: true, returnDocument: 'after' });
      try {
        return await op();
      } catch (e) {
        if (!isDup(e)) throw e;
        return op();
      }
    },
    getOffer: (id) => offers.findOne({ _id: id }),
    /** Removes an offer; returns it if it was still there (so only one caller gets to act on it). */
    takeOffer: (filter) => offers.findOneAndDelete(filter),
    offersFor: (guildId, playerId, now) =>
      offers.find({ guildId, expireAt: { $gt: now }, $or: [{ buyerId: playerId }, { sellerId: playerId }] }).sort({ at: 1 }).limit(200).toArray(),
    deleteOffers: (filter) => offers.deleteMany(filter),

    // ---- claims ----
    /** Returns the new id, or false when a claim with the same `source` already exists. */
    async insertClaim(doc) {
      try {
        const r = await claims.insertOne(doc);
        return r.insertedId;
      } catch (e) {
        if (isDup(e)) return false;
        throw e;
      }
    },
    getClaim: (id) => claims.findOne({ _id: id }),
    pendingClaims: (playerId) => claims.find({ playerId, state: 'pending' }).sort({ at: 1 }).limit(100).toArray(),
    hasPendingClaims: async (playerId) => (await claims.countDocuments({ playerId, state: 'pending' }, { limit: 1 })) > 0,
    /** Moves a pending claim to `state`; returns it only for the one caller that made the change. */
    finishClaim: (id, playerId, state) =>
      claims.findOneAndUpdate({ _id: id, playerId, state: 'pending' }, { $set: { state, doneAt: new Date() } }, { returnDocument: 'before' }),
    /** Purchases of this seller's items that the buyer's game has not completed yet. */
    hasPendingSales: async (sellerId) => (await claims.countDocuments({ sellerId, kind: 'purchase', state: 'pending' }, { limit: 1 })) > 0,
    /** Takes back a follow-up claim nobody has collected yet. */
    deletePendingClaimBySource: (source) => claims.deleteOne({ source, state: 'pending' }),
    stalePurchases: (before, limit) => claims.find({ state: 'pending', kind: 'purchase', at: { $lt: before } }).limit(limit).toArray(),

    purgeMarketOfGuild: (guildId) => offers.deleteMany({ guildId }),
    purgeMarketOfPlayer: (playerId) => offers.deleteMany({ $or: [{ buyerId: playerId }, { sellerId: playerId }] }),
  };
}
