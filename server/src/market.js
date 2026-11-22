// Guild marketplace handlers. The server is the ledger: it never sees anyone's bank, so every
// movement of items or gold is a "claim" that the player's own game applies and then confirms.
//
//   list    seller's game removes the items, then POSTs the listing
//   buy     the quantity is reserved here; the buyer gets a `purchase` claim (pay gold, get items)
//   confirm a confirmed purchase creates the seller's `payout` claim (get gold)
//   fail    a purchase the buyer could not complete puts the items back on the listing
//   cancel / expiry / leaving the guild: unsold items go back to the seller as a `return` claim
import { ObjectId } from 'mongodb';
import { HttpError } from './app.js';

export const MARKET_LIMITS = {
  maxListingsPerSeller: 20, // open listings per player per guild
  listingDays: 14,
  offerHours: 48,
  purchaseHours: 24, // a reserved purchase the buyer never completes is undone after this
  minPercent: 80,
  maxPercent: 120,
  maxQty: 1_000_000_000,
  maxGold: 1_000_000_000_000,
};

const GAME_ID_RE = /^[A-Z][A-Za-z0-9]*:[A-Z][A-Za-z0-9_]*$/;
const bad = (code, message) => new HttpError(400, code, message);
const conflict = (code, message) => new HttpError(409, code, message);
const notFound = (code, message) => new HttpError(404, code, message);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const ms = (d) => (d instanceof Date ? d.getTime() : null);

/** The lowest and highest price allowed for an item worth `value` gold: 80% to 120%, whole gold, at least 1. */
export function priceRange(value, M = MARKET_LIMITS) {
  const min = Math.max(1, Math.ceil((value * M.minPercent) / 100));
  return { min, max: Math.max(min, Math.floor((value * M.maxPercent) / 100)) };
}

function vId(v, code, what) {
  if (typeof v !== 'string' || !/^[0-9a-f]{24}$/.test(v)) throw notFound(code, `${what} not found`);
  return new ObjectId(v);
}

const listingOut = (l) => ({
  id: String(l._id),
  item: l.item,
  qty: l.qty,
  price: l.price,
  value: l.value,
  sellerId: l.sellerId,
  sellerName: l.sellerName,
  createdAt: ms(l.createdAt),
  expiresAt: ms(l.expireAt),
});
const offerOut = (o) => ({
  id: String(o._id),
  listingId: String(o.listingId),
  item: o.item,
  qty: o.qty,
  price: o.price,
  buyerId: o.buyerId,
  buyerName: o.buyerName,
  sellerId: o.sellerId,
  at: ms(o.at),
  expiresAt: ms(o.expireAt),
});
export const claimOut = (c) => ({
  id: String(c._id),
  kind: c.kind,
  item: c.item,
  qty: c.qty,
  gold: c.gold,
  other: c.other ?? '',
  reason: c.reason ?? '',
  at: ms(c.at),
});

export function createMarket({ store, now, guildCtx, requireRank, limits = {} }) {
  const M = { ...MARKET_LIMITS, ...limits };
  const date = () => new Date(now());
  let lastSweep = 0;

  /** Unsold items of an ended listing go back to the seller. Safe to call twice: one claim per listing end. */
  async function returnItems(listing, reason) {
    if (!listing || listing.qty <= 0) return;
    await store.insertClaim({
      playerId: listing.sellerId, guildId: listing.guildId, kind: 'return', item: listing.item, qty: listing.qty, gold: 0,
      reason, state: 'pending', at: date(), source: `end:${listing._id}`,
    });
  }

  async function endListing(filter, state, reason) {
    const old = await store.endListing(filter, state);
    if (!old) return null;
    await returnItems(old, reason);
    await store.deleteOffers({ listingId: old._id });
    await store.bumpMarket(old.guildId);
    return old;
  }

  /** Reserved items of a purchase that will not happen: back onto the listing, or to the seller if it has ended. */
  async function undoPurchase(claim) {
    const restored = await store.restoreListing(claim.listingId, claim.qty);
    if (!restored) {
      await store.insertClaim({
        playerId: claim.sellerId, guildId: claim.guildId, kind: 'return', item: claim.item, qty: claim.qty, gold: 0,
        reason: 'unsold', state: 'pending', at: date(), source: `undo:${claim._id}`,
      });
    }
    await store.bumpMarket(claim.guildId);
  }

  /** Housekeeping that needs follow-up claims (offers simply expire through a TTL index). */
  async function sweep(force = false) {
    const t = now();
    if (!force && t - lastSweep < 60_000) return;
    lastSweep = t;
    for (const l of await store.expiredListings(new Date(t), 50)) await endListing({ _id: l._id }, 'expired', 'expired');
    for (const c of await store.stalePurchases(new Date(t - M.purchaseHours * 3_600_000), 50)) {
      if (await store.finishClaim(c._id, c.playerId, 'failed')) await undoPurchase(c);
    }
  }

  async function memberCtx(idParam, me) {
    const ctx = await guildCtx(idParam, me);
    requireRank(ctx, 'owner', 'officer', 'member');
    return ctx;
  }

  /** Reserves the items and hands the buyer the claim their game will apply. */
  async function sell(ctx, listingId, buyer, qty, price, atListedPrice) {
    // A direct purchase only goes through at the price the buyer saw; an accepted offer has its own price.
    const listing = await store.reserveListing(listingId, ctx.gid, qty, atListedPrice ? price : null);
    if (!listing) throw conflict('not_available', 'That many are no longer available at this price');
    const id = await store.insertClaim({
      playerId: buyer.id, guildId: ctx.gid, kind: 'purchase', item: listing.item, qty, gold: qty * price,
      other: listing.sellerName, buyerName: buyer.name, sellerId: listing.sellerId, listingId: listing._id,
      state: 'pending', at: date(),
    });
    await store.bumpMarket(ctx.gid);
    return claimOut(await store.getClaim(id));
  }

  const h = {
    async list({ me, params }) {
      const ctx = await memberCtx(params.id, me);
      await sweep();
      const [listings, offers] = await Promise.all([store.listListings(ctx.gid), store.offersFor(ctx.gid, me, date())]);
      return {
        rev: ctx.guild.marketRev ?? 0,
        listings: listings.map(listingOut),
        offers: offers.map(offerOut),
        rules: { minPercent: M.minPercent, maxPercent: M.maxPercent, maxListings: M.maxListingsPerSeller },
      };
    },

    async create({ me, player, params, body }) {
      const ctx = await memberCtx(params.id, me);
      if (typeof body.item !== 'string' || body.item.length > 80 || !GAME_ID_RE.test(body.item)) {
        throw bad('invalid_listing', 'item must be a game id like "Namespace:LocalId"');
      }
      if (!isInt(body.qty, 1, M.maxQty)) throw bad('invalid_listing', `qty must be a whole number from 1 to ${M.maxQty}`);
      if (!isInt(body.value, 1, M.maxGold)) throw bad('invalid_listing', 'value must be the item\'s gold value, at least 1');
      const range = priceRange(body.value, M);
      if (!isInt(body.price, range.min, range.max)) {
        throw bad('price_out_of_range', `The price must be between ${range.min} and ${range.max} gold (${M.minPercent}% to ${M.maxPercent}% of the item's value)`);
      }
      if (!Number.isSafeInteger(body.qty * body.price)) throw bad('invalid_listing', 'That listing is worth too much gold');
      // The game takes the items out of the bank before it asks, so it must be able to ask again after a
      // lost reply without listing them twice: the same nonce always means the same listing.
      const nonce = body.nonce;
      if (nonce !== undefined && (typeof nonce !== 'string' || !/^[A-Za-z0-9]{8,40}$/.test(nonce))) {
        throw bad('invalid_listing', 'nonce must be 8 to 40 letters or digits');
      }
      if (nonce) {
        const existing = await store.listingByNonce(me, nonce);
        if (existing) return { status: 200, body: { listing: listingOut(existing) } };
      }
      if ((await store.countOpenListings(ctx.gid, me)) >= M.maxListingsPerSeller) {
        throw conflict('too_many_listings', `You can have at most ${M.maxListingsPerSeller} listings in a guild`);
      }
      const t = date();
      const doc = {
        guildId: ctx.gid, sellerId: me, sellerName: player.name, item: body.item, qty: body.qty, price: body.price, value: body.value,
        state: 'open', createdAt: t, expireAt: new Date(t.getTime() + M.listingDays * 86_400_000),
        ...(nonce ? { nonce } : {}),
      };
      const id = await store.insertListing(doc);
      if (id === false) return { status: 200, body: { listing: listingOut(await store.listingByNonce(me, nonce)) } };
      doc._id = id;
      await store.bumpMarket(ctx.gid);
      return { status: 201, body: { listing: listingOut(doc) } };
    },

    // The seller can always take a listing down, even after leaving the guild.
    async cancel({ me, params }) {
      const gid = vId(params.id, 'guild_not_found', 'Guild');
      const old = await endListing({ _id: vId(params.listingId, 'listing_not_found', 'Listing'), guildId: gid, sellerId: me }, 'cancelled', 'cancelled');
      if (!old) throw notFound('listing_not_found', 'Listing not found');
      return { ok: true, returned: old.qty };
    },

    async buy({ me, player, params, body }) {
      const ctx = await memberCtx(params.id, me);
      const listingId = vId(params.listingId, 'listing_not_found', 'Listing');
      const listing = await store.getListing(listingId);
      if (!listing || String(listing.guildId) !== String(ctx.gid) || listing.state !== 'open') throw notFound('listing_not_found', 'Listing not found');
      if (listing.sellerId === me) throw bad('own_listing', 'You cannot buy your own listing');
      if (!isInt(body.qty, 1, M.maxQty)) throw bad('invalid_quantity', 'qty must be a whole number, at least 1');
      // The price is sent back so a buyer never pays a price they did not see.
      if (body.price !== listing.price) throw conflict('price_changed', 'The price is not what you saw. Refresh and try again.');
      return { status: 201, body: { claim: await sell(ctx, listingId, { id: me, name: player.name }, body.qty, listing.price, true) } };
    },

    async offer({ me, player, params, body }) {
      const ctx = await memberCtx(params.id, me);
      const listing = await store.getListing(vId(params.listingId, 'listing_not_found', 'Listing'));
      if (!listing || String(listing.guildId) !== String(ctx.gid) || listing.state !== 'open') throw notFound('listing_not_found', 'Listing not found');
      if (listing.sellerId === me) throw bad('own_listing', 'You cannot make an offer on your own listing');
      if (!isInt(body.qty, 1, listing.qty)) throw bad('invalid_quantity', `qty must be from 1 to ${listing.qty}`);
      const { min } = priceRange(listing.value, M);
      if (!isInt(body.price, min, listing.price - 1)) {
        throw bad('price_out_of_range', min >= listing.price
          ? 'This listing is already at the lowest price allowed'
          : `An offer must be from ${min} to ${listing.price - 1} gold each`);
      }
      const t = date();
      const offer = await store.putOffer({
        listingId: listing._id, guildId: ctx.gid, buyerId: me, buyerName: player.name, sellerId: listing.sellerId,
        item: listing.item, qty: body.qty, price: body.price, at: t, expireAt: new Date(t.getTime() + M.offerHours * 3_600_000),
      });
      await store.bumpMarket(ctx.gid);
      return { status: 201, body: { offer: offerOut(offer) } };
    },

    // The buyer withdraws their own offer.
    async withdraw({ me, params }) {
      const gid = vId(params.id, 'guild_not_found', 'Guild');
      const offer = await store.takeOffer({ _id: vId(params.offerId, 'offer_not_found', 'Offer'), guildId: gid, buyerId: me });
      if (!offer) throw notFound('offer_not_found', 'Offer not found');
      await store.bumpMarket(gid);
      return { ok: true };
    },

    // The seller accepts or declines. Accepting sells at the offered price, exactly like a purchase.
    async answerOffer({ me, params, body }) {
      const ctx = await memberCtx(params.id, me);
      if (typeof body.accept !== 'boolean') throw bad('invalid_body', 'accept must be true or false');
      const offer = await store.takeOffer({ _id: vId(params.offerId, 'offer_not_found', 'Offer'), guildId: ctx.gid, sellerId: me, expireAt: { $gt: date() } });
      if (!offer) throw notFound('offer_not_found', 'Offer not found');
      await store.bumpMarket(ctx.gid);
      if (!body.accept) return { ok: true, accepted: false };
      // The buyer may have left the guild since making the offer.
      if (!(await store.getMember(ctx.gid, offer.buyerId))) throw conflict('buyer_left', 'That player is no longer in the guild');
      const claim = await sell(ctx, offer.listingId, { id: offer.buyerId, name: offer.buyerName }, offer.qty, offer.price, false);
      return { ok: true, accepted: true, qty: claim.qty, gold: claim.gold };
    },

    /** The player's game applied a claim to its bank. For a purchase, that is when the seller gets paid. */
    async confirmClaim({ me, params }) {
      const id = vId(params.claimId, 'claim_not_found', 'Claim');
      const claim = await store.getClaim(id);
      if (!claim || claim.playerId !== me) throw notFound('claim_not_found', 'Claim not found');
      if (claim.state === 'failed') throw conflict('claim_failed', 'This purchase was already cancelled');
      if (claim.kind === 'purchase') {
        // Payout first, keyed on this purchase, so a retry can never pay twice or skip the payout.
        await store.insertClaim({
          playerId: claim.sellerId, guildId: claim.guildId, kind: 'payout', item: claim.item, qty: claim.qty, gold: claim.gold,
          other: claim.buyerName ?? '', state: 'pending', at: date(), source: `paid:${claim._id}`,
        });
      }
      await store.finishClaim(id, me, 'done');
      return { ok: true };
    },

    /** The buyer's game could not complete a purchase (not enough gold, bank full): undo the reservation. */
    async failClaim({ me, params }) {
      const id = vId(params.claimId, 'claim_not_found', 'Claim');
      const claim = await store.getClaim(id);
      if (!claim || claim.playerId !== me) throw notFound('claim_not_found', 'Claim not found');
      if (claim.kind !== 'purchase') throw bad('not_a_purchase', 'Only a purchase can be cancelled');
      if (claim.state === 'done') throw conflict('claim_done', 'This purchase was already completed');
      if (await store.finishClaim(id, me, 'failed')) await undoPurchase(claim);
      return { ok: true };
    },
  };

  return {
    handlers: h,
    sweep,
    pendingClaims: async (playerId) => (await store.pendingClaims(playerId)).map(claimOut),
    /** A member left, was kicked or the guild is going away: their listings end and the items go back. */
    async closeListings(filter, reason) {
      for (const l of await store.liveListingsOf(filter)) await endListing({ _id: l._id }, 'cancelled', reason);
    },
    /** True while the player has anything on the market or waiting to be collected. */
    hasUnfinished: async (playerId) => (await store.hasLiveListings(playerId)) || (await store.hasPendingClaims(playerId)),
    routes: [
      ['GET', 'guilds/:id/market', h.list],
      ['POST', 'guilds/:id/market', h.create],
      ['DELETE', 'guilds/:id/market/:listingId', h.cancel],
      ['POST', 'guilds/:id/market/:listingId/buy', h.buy],
      ['POST', 'guilds/:id/market/:listingId/offers', h.offer],
      ['DELETE', 'guilds/:id/offers/:offerId', h.withdraw],
      ['POST', 'guilds/:id/offers/:offerId', h.answerOffer],
      ['POST', 'claims/:claimId/confirm', h.confirmClaim],
      ['POST', 'claims/:claimId/fail', h.failClaim],
    ],
  };
}
