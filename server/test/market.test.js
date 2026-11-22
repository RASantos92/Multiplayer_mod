import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { createFetchHandler } from '../src/http.js';
import { priceRange } from '../src/market.js';
import { createStore } from '../src/store.js';

let mongod, client, store, fetchApi;
let clock = Date.now(); // tests move this forward to reach expiry

before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  store = createStore(client.db('markettest'));
  await store.init();
  const app = createApp({ store, now: () => clock, limits: { rate: { register: [10_000, 3_600_000], write: [10_000, 60_000], read: [10_000, 60_000], sync: [10_000, 60_000] } } });
  fetchApi = createFetchHandler(async () => ({ handle: app.handle, ping: store.ping }));
});

after(async () => {
  await client?.close();
  await mongod?.stop();
});

// ---------- helpers ----------

let counter = 0;
const newSteamId = () => `765612022${String(++counter).padStart(8, '0')}`;

async function call(player, method, path, body) {
  const headers = { 'x-mod-protocol': '1' };
  if (player) headers.authorization = `Bearer ${player.id}:${player.key}`;
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetchApi(new Request(`https://guilds.test${path}`, init));
  return { status: res.status, body: await res.json() };
}
async function ok(player, method, path, body) {
  const r = await call(player, method, path, body);
  assert.ok(r.status === 200 || r.status === 201, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function fails(status, code, player, method, path, body) {
  const r = await call(player, method, path, body);
  assert.equal(r.status, status, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, code);
}
async function newPlayer(name) {
  const p = { id: newSteamId(), key: randomBytes(24).toString('hex'), name };
  await ok(null, 'POST', '/register', { steamId: p.id, name, key: p.key });
  return p;
}
/** A guild with a seller (the owner), two buyers, and an outsider who is not a member. */
async function market() {
  const [seller, buyer, other, outsider] = [await newPlayer('Seller'), await newPlayer('Buyer'), await newPlayer('Other'), await newPlayer('Outsider')];
  const { guild } = await ok(seller, 'POST', '/guilds', { name: `Market ${randomBytes(4).toString('hex')}`, description: '' });
  for (const p of [buyer, other]) {
    await ok(p, 'POST', `/guilds/${guild.id}/join`);
    await ok(seller, 'POST', `/guilds/${guild.id}/requests/${p.id}`, { accept: true });
  }
  return { seller, buyer, other, outsider, guild, m: `/guilds/${guild.id}/market`, g: `/guilds/${guild.id}` };
}
const logs = (over = {}) => ({ item: 'MelvorBase:OakLogs', qty: 10, price: 10, value: 10, ...over });
const claimsOf = async (p) => (await ok(p, 'POST', '/sync', {})).claims;
const listingsOf = async (p, m) => (await ok(p, 'GET', m)).listings;

// ---------- tests ----------

test('price range is 80% to 120% of the value, in whole gold, at least 1', () => {
  assert.deepEqual(priceRange(100), { min: 80, max: 120 });
  assert.deepEqual(priceRange(10), { min: 8, max: 12 });
  assert.deepEqual(priceRange(7), { min: 6, max: 8 }); // 5.6 rounds up, 8.4 rounds down
  assert.deepEqual(priceRange(1), { min: 1, max: 1 });
  assert.deepEqual(priceRange(2), { min: 2, max: 2 });
});

test('listing: members only, validated, capped, visible to the guild', async () => {
  const { seller, buyer, outsider, m } = await market();

  const { listing } = await ok(seller, 'POST', m, logs({ price: 12 }));
  assert.equal(listing.qty, 10);
  assert.equal(listing.sellerName, 'Seller');
  assert.deepEqual((await listingsOf(buyer, m)).map((l) => [l.item, l.qty, l.price]), [['MelvorBase:OakLogs', 10, 12]]);

  await fails(403, 'not_member', outsider, 'GET', m);
  await fails(403, 'not_member', outsider, 'POST', m, logs());
  await fails(400, 'price_out_of_range', seller, 'POST', m, logs({ price: 13 }));
  await fails(400, 'price_out_of_range', seller, 'POST', m, logs({ price: 7 }));
  await fails(400, 'invalid_listing', seller, 'POST', m, logs({ qty: 0 }));
  await fails(400, 'invalid_listing', seller, 'POST', m, logs({ qty: 1.5 }));
  await fails(400, 'invalid_listing', seller, 'POST', m, logs({ value: 0 }));
  await fails(400, 'invalid_listing', seller, 'POST', m, logs({ item: 'oak logs' }));

  // Asking again with the same nonce (a lost reply) is the same listing, not a second one.
  const first = await ok(seller, 'POST', m, logs({ nonce: 'abcdef123456' }));
  const again = await ok(seller, 'POST', m, logs({ nonce: 'abcdef123456' }));
  assert.equal(again.listing.id, first.listing.id);
  assert.equal((await listingsOf(seller, m)).length, 2);
  await fails(400, 'invalid_listing', seller, 'POST', m, logs({ nonce: 'no' }));

  for (let i = 2; i < 20; i++) await ok(seller, 'POST', m, logs());
  await fails(409, 'too_many_listings', seller, 'POST', m, logs());
});

test('buy: reserves, buyer confirms, seller is paid exactly once', async () => {
  const { seller, buyer, m } = await market();
  const { listing } = await ok(seller, 'POST', m, logs());

  await fails(400, 'own_listing', seller, 'POST', `${m}/${listing.id}/buy`, { qty: 1, price: 10 });
  await fails(409, 'price_changed', buyer, 'POST', `${m}/${listing.id}/buy`, { qty: 1, price: 9 });
  await fails(409, 'not_available', buyer, 'POST', `${m}/${listing.id}/buy`, { qty: 11, price: 10 });

  const { claim } = await ok(buyer, 'POST', `${m}/${listing.id}/buy`, { qty: 3, price: 10 });
  assert.deepEqual([claim.kind, claim.item, claim.qty, claim.gold, claim.other], ['purchase', 'MelvorBase:OakLogs', 3, 30, 'Seller']);
  assert.equal((await listingsOf(buyer, m))[0].qty, 7);
  assert.deepEqual((await claimsOf(buyer)).map((c) => c.id), [claim.id]);
  assert.deepEqual(await claimsOf(seller), []); // not paid until the buyer's game has paid

  await fails(404, 'claim_not_found', seller, 'POST', `/claims/${claim.id}/confirm`);
  await ok(buyer, 'POST', `/claims/${claim.id}/confirm`);
  await ok(buyer, 'POST', `/claims/${claim.id}/confirm`); // a retry after a lost reply
  assert.deepEqual(await claimsOf(buyer), []);

  const payouts = await claimsOf(seller);
  assert.deepEqual(payouts.map((c) => [c.kind, c.gold, c.qty, c.other]), [['payout', 30, 3, 'Buyer']]);
  await ok(seller, 'POST', `/claims/${payouts[0].id}/confirm`);
  assert.deepEqual(await claimsOf(seller), []);
  await fails(409, 'claim_done', buyer, 'POST', `/claims/${claim.id}/fail`);
});

test('buy: two buyers racing for the last items, exactly one wins', async () => {
  const { seller, buyer, other, m } = await market();
  const { listing } = await ok(seller, 'POST', m, logs({ qty: 5 }));
  const results = await Promise.all([buyer, other].map((p) => call(p, 'POST', `${m}/${listing.id}/buy`, { qty: 5, price: 10 })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.deepEqual(await listingsOf(seller, m), []); // sold out listings are not shown
});

test('a purchase the buyer cannot complete puts the items back', async () => {
  const { seller, buyer, m } = await market();
  const { listing } = await ok(seller, 'POST', m, logs({ qty: 5 }));
  const { claim } = await ok(buyer, 'POST', `${m}/${listing.id}/buy`, { qty: 5, price: 10 });
  assert.deepEqual(await listingsOf(seller, m), []);

  await ok(buyer, 'POST', `/claims/${claim.id}/fail`);
  await ok(buyer, 'POST', `/claims/${claim.id}/fail`); // retry: items go back once
  assert.equal((await listingsOf(seller, m))[0].qty, 5);
  await fails(409, 'claim_failed', buyer, 'POST', `/claims/${claim.id}/confirm`);
  assert.deepEqual(await claimsOf(seller), []);

  // If the listing was taken down meanwhile, the items go to the seller instead.
  const second = (await ok(buyer, 'POST', `${m}/${listing.id}/buy`, { qty: 2, price: 10 })).claim;
  assert.equal((await ok(seller, 'DELETE', `${m}/${listing.id}`)).returned, 3);
  await ok(buyer, 'POST', `/claims/${second.id}/fail`);
  assert.deepEqual((await claimsOf(seller)).map((c) => [c.kind, c.qty]).sort(), [['return', 2], ['return', 3]]);
});

test('cancel: only the seller, items come back as a claim', async () => {
  const { seller, buyer, m } = await market();
  const { listing } = await ok(seller, 'POST', m, logs());
  await fails(404, 'listing_not_found', buyer, 'DELETE', `${m}/${listing.id}`);
  await ok(seller, 'DELETE', `${m}/${listing.id}`);
  await fails(404, 'listing_not_found', seller, 'DELETE', `${m}/${listing.id}`);
  assert.deepEqual((await claimsOf(seller)).map((c) => [c.kind, c.item, c.qty, c.reason]), [['return', 'MelvorBase:OakLogs', 10, 'cancelled']]);
  await fails(404, 'listing_not_found', buyer, 'POST', `${m}/${listing.id}/buy`, { qty: 1, price: 10 });
});

test('offers: bounded, one per buyer, seller accepts or declines', async () => {
  const { seller, buyer, other, m, g } = await market();
  const { listing } = await ok(seller, 'POST', m, logs({ price: 12 })); // value 10: offers may be 8 to 11
  const offers = `${m}/${listing.id}/offers`;

  await fails(400, 'own_listing', seller, 'POST', offers, { qty: 1, price: 9 });
  await fails(400, 'price_out_of_range', buyer, 'POST', offers, { qty: 1, price: 7 });
  await fails(400, 'price_out_of_range', buyer, 'POST', offers, { qty: 1, price: 12 });
  await fails(400, 'invalid_quantity', buyer, 'POST', offers, { qty: 11, price: 9 });

  await ok(buyer, 'POST', offers, { qty: 2, price: 8 });
  const { offer } = await ok(buyer, 'POST', offers, { qty: 4, price: 9 }); // replaces the first
  const seen = (await ok(seller, 'GET', m)).offers;
  assert.deepEqual(seen.map((o) => [o.buyerName, o.qty, o.price]), [['Buyer', 4, 9]]);
  assert.deepEqual((await ok(other, 'GET', m)).offers, []); // not their business

  await fails(404, 'offer_not_found', buyer, 'POST', `${g}/offers/${offer.id}`, { accept: true });
  const answer = await ok(seller, 'POST', `${g}/offers/${offer.id}`, { accept: true });
  assert.deepEqual([answer.accepted, answer.qty, answer.gold], [true, 4, 36]);
  assert.equal((await listingsOf(seller, m))[0].qty, 6);
  assert.deepEqual((await claimsOf(buyer)).map((c) => [c.kind, c.qty, c.gold]), [['purchase', 4, 36]]);
  await fails(404, 'offer_not_found', seller, 'POST', `${g}/offers/${offer.id}`, { accept: true });

  const declined = (await ok(other, 'POST', offers, { qty: 1, price: 8 })).offer;
  assert.equal((await ok(seller, 'POST', `${g}/offers/${declined.id}`, { accept: false })).accepted, false);
  assert.deepEqual(await claimsOf(other), []);

  const withdrawn = (await ok(other, 'POST', offers, { qty: 1, price: 8 })).offer;
  await ok(other, 'DELETE', `${g}/offers/${withdrawn.id}`);
  assert.deepEqual((await ok(seller, 'GET', m)).offers, []);

  // A listing already at the floor cannot be haggled.
  const floor = (await ok(seller, 'POST', m, logs({ price: 8 }))).listing;
  await fails(400, 'price_out_of_range', buyer, 'POST', `${m}/${floor.id}/offers`, { qty: 1, price: 8 });
});

test('expiry: old listings and abandoned purchases return the items', async () => {
  const { seller, buyer, m } = await market();
  const start = clock;
  const { listing } = await ok(seller, 'POST', m, logs({ qty: 6 }));
  await ok(buyer, 'POST', `${m}/${listing.id}/buy`, { qty: 2, price: 10 }); // never completed

  clock = start + 25 * 3_600_000; // the reservation is undone after 24 hours
  assert.equal((await listingsOf(seller, m))[0].qty, 6);
  assert.deepEqual(await claimsOf(buyer), []);

  clock = start + 15 * 86_400_000; // the listing itself ends after 14 days
  assert.deepEqual(await listingsOf(seller, m), []);
  assert.deepEqual((await claimsOf(seller)).map((c) => [c.kind, c.qty, c.reason]), [['return', 6, 'expired']]);
});

test('leaving, kicking and deleting data never strand items or gold', async () => {
  const { seller, buyer, other, m, g } = await market();
  const mine = (await ok(buyer, 'POST', m, logs({ qty: 4 }))).listing;
  const theirs = (await ok(other, 'POST', m, logs({ qty: 9 }))).listing;
  await ok(buyer, 'POST', `${m}/${theirs.id}/offers`, { qty: 1, price: 9 });

  await fails(409, 'market_pending', buyer, 'DELETE', '/me'); // has a listing

  await ok(buyer, 'POST', `${g}/leave`);
  assert.deepEqual((await claimsOf(buyer)).map((c) => [c.kind, c.qty, c.reason]), [['return', 4, 'left_guild']]);
  assert.deepEqual((await ok(other, 'GET', m)).offers, []); // the leaver's offer is gone
  assert.deepEqual((await listingsOf(seller, m)).map((l) => l.id), [theirs.id]);
  await fails(404, 'listing_not_found', buyer, 'DELETE', `${m}/${mine.id}`);

  await fails(409, 'market_pending', buyer, 'DELETE', '/me'); // still has items to collect
  const [back] = await claimsOf(buyer);
  await ok(buyer, 'POST', `/claims/${back.id}/confirm`);
  await ok(buyer, 'DELETE', '/me');

  await ok(seller, 'DELETE', `${g}/members/${other.id}`);
  assert.deepEqual((await claimsOf(other)).map((c) => [c.kind, c.qty]), [['return', 9]]);

  // Disbanding returns everything that is still listed.
  const last = (await ok(seller, 'POST', m, logs({ qty: 2 }))).listing;
  await ok(seller, 'DELETE', g);
  assert.deepEqual((await claimsOf(seller)).map((c) => [c.kind, c.qty, c.reason]), [['return', 2, 'guild_disbanded']]);
  assert.ok(last.id);
});

test('sync carries pending claims and a market revision that moves on every change', async () => {
  const { seller, buyer, guild, m } = await market();
  const rev = async () => (await ok(buyer, 'POST', '/sync', {})).guilds.find((x) => x.id === guild.id).marketRev;
  const r0 = await rev();
  const { listing } = await ok(seller, 'POST', m, logs());
  const r1 = await rev();
  assert.ok(r1 > r0);
  await ok(buyer, 'POST', `${m}/${listing.id}/buy`, { qty: 1, price: 10 });
  assert.ok((await rev()) > r1);
});
