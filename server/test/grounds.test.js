import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { createFetchHandler } from '../src/http.js';
import { worths } from '../src/grounds.js';
import { GROUPS, TIERS } from '../src/groundsData.js';
import { createStore } from '../src/store.js';

let mongod, client, store, fetchApi;

before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  store = createStore(client.db('groundstest'));
  await store.init();
  const app = createApp({ store, limits: { rate: { register: [10_000, 3_600_000], write: [10_000, 60_000], read: [10_000, 60_000], sync: [10_000, 60_000] } } });
  fetchApi = createFetchHandler(async () => ({ handle: app.handle, ping: store.ping }));
});

after(async () => {
  await client?.close();
  await mongod?.stop();
});

// ---------- helpers ----------

let counter = 0;
const newSteamId = () => `765612020${String(++counter).padStart(8, '0')}`;
const nonce = () => randomBytes(12).toString('hex');

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
/** A guild with an owner, a member, and an outsider who is not in it. */
async function guildOf() {
  const [owner, member, outsider] = [await newPlayer('Owner'), await newPlayer('Member'), await newPlayer('Outsider')];
  const { guild } = await ok(owner, 'POST', '/guilds', { name: `Grounds ${randomBytes(4).toString('hex')}`, description: '' });
  await ok(member, 'POST', `/guilds/${guild.id}/join`);
  await ok(owner, 'POST', `/guilds/${guild.id}/requests/${member.id}`, { accept: true });
  return { owner, member, outsider, guild, g: `/guilds/${guild.id}/grounds` };
}
const locations = (view) => view.tiers.flatMap((t) => t.locations);
const taskOf = (view, id) => locations(view).flatMap((l) => l.tasks).find((t) => t.id === id);
const give = (p, g, task, item, qty, n = nonce()) => ok(p, 'POST', `${g}/donate`, { task, item, qty, nonce: n });
const syncOf = (p, grounds) => ok(p, 'POST', '/sync', grounds ? { grounds } : {});
const guildIn = (sync, guild) => sync.guilds.find((x) => x.id === guild.id);

const LOGS = GROUPS.logs.items;
const BASE = LOGS.indexOf(GROUPS.logs.base);

// ---------- tests ----------

test('item worth: the base item is 1, each step up 25% more, each step down needs 25% more', () => {
  const w = worths('logs');
  assert.equal(w.get(LOGS[BASE]), 1000);
  assert.equal(w.get(LOGS[BASE + 1]), 1250);
  assert.equal(w.get(LOGS[BASE - 1]), 800); // 1 / 0.8 = 1.25 times as many
  assert.equal(w.get(LOGS[BASE - 2]), 640);
  for (const tier of TIERS) {
    for (const loc of tier.locations) {
      assert.equal(loc.tasks.length, 5, loc.id);
      for (const t of loc.tasks) assert.ok(t.kind !== 'donate' || GROUPS[t.group].items.includes(GROUPS[t.group].base), t.id);
    }
  }
  const ids = TIERS.flatMap((t) => t.locations.flatMap((l) => l.tasks.map((x) => x.id)));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-z0-9_]+$/.test(id)));
});

test('view: members see every location with empty progress; outsiders do not', async () => {
  const { owner, outsider, g } = await guildOf();
  const view = await ok(owner, 'GET', g);
  assert.equal(view.unit, 1000);
  assert.equal(locations(view).length, 5);
  const logs = taskOf(view, 'gatehouse_logs');
  assert.deepEqual([logs.kind, logs.need, logs.have, logs.mine, logs.top.length], ['donate', 500_000, 0, 0, 0]);
  assert.deepEqual(logs.items.find((i) => i.item === GROUPS.logs.base), { item: GROUPS.logs.base, worth: 1000 });
  assert.equal(taskOf(view, 'gatehouse_kills').items, undefined);
  assert.ok(locations(view).every((l) => !l.done && l.bonus.id && l.bonus.text));
  await fails(403, 'not_member', outsider, 'GET', g);
  await fails(403, 'not_member', outsider, 'POST', `${g}/donate`, { task: 'gatehouse_logs', item: LOGS[BASE], qty: 1, nonce: nonce() });
});

test('donate: worth by step, contributors, a repeated nonce counts once, and bad input is refused', async () => {
  const { owner, member, guild, g } = await guildOf();
  const rev0 = guildIn(await syncOf(owner), guild).groundsRev;

  assert.deepEqual(await give(owner, g, 'gatehouse_logs', LOGS[BASE], 10), { accepted: 10, qty: 10 });
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE + 1], 10), { accepted: 10, qty: 10 });
  const n = nonce();
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE - 1], 10, n), { accepted: 10, qty: 10 });
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE - 1], 10, n), { accepted: 10, qty: 10 });

  const view = await ok(member, 'GET', g);
  const logs = taskOf(view, 'gatehouse_logs');
  assert.equal(logs.have, 10_000 + 12_500 + 8_000);
  assert.equal(logs.mine, 20_500);
  assert.deepEqual(logs.top.map((t) => [t.name, t.amount]), [['Member', 20_500], ['Owner', 10_000]]);
  assert.ok(guildIn(await syncOf(owner), guild).groundsRev > rev0);
  assert.equal(view.rev, guildIn(await syncOf(owner), guild).groundsRev);

  const d = (over) => ({ task: 'gatehouse_logs', item: LOGS[BASE], qty: 1, nonce: nonce(), ...over });
  await fails(400, 'bad_task', owner, 'POST', `${g}/donate`, d({ task: 'nope' }));
  await fails(400, 'bad_task', owner, 'POST', `${g}/donate`, d({ task: 'gatehouse_kills' }));
  await fails(400, 'bad_item', owner, 'POST', `${g}/donate`, d({ item: 'MelvorBase:Feathers' }));
  await fails(400, 'bad_qty', owner, 'POST', `${g}/donate`, d({ qty: 0 }));
  await fails(400, 'bad_qty', owner, 'POST', `${g}/donate`, d({ qty: 1.5 }));
  await fails(400, 'bad_nonce', owner, 'POST', `${g}/donate`, d({ nonce: 'x' }));
});

test('donate: a donation larger than what is left is trimmed, and a full task accepts nothing', async () => {
  const { owner, g } = await guildOf();
  assert.equal((await give(owner, g, 'watchtower_feathers', 'MelvorBase:Feathers', 190)).accepted, 190);
  assert.deepEqual(await give(owner, g, 'watchtower_feathers', 'MelvorBase:Feathers', 50), { accepted: 10, qty: 50 });
  assert.deepEqual(await give(owner, g, 'watchtower_feathers', 'MelvorBase:Feathers', 5), { accepted: 0, qty: 5 });
  // 7.5 base logs short: six step-up logs (1.25 each) cover it, the seventh is not needed.
  await give(owner, g, 'watchtower_logs', LOGS[BASE], 392);
  await give(owner, g, 'watchtower_logs', LOGS[BASE - 1], 1); // 0.8 -> 392.8 of 400
  assert.deepEqual(await give(owner, g, 'watchtower_logs', LOGS[BASE + 1], 9), { accepted: 6, qty: 9 });
  const logs = taskOf(await ok(owner, 'GET', g), 'watchtower_logs');
  assert.equal(logs.have, logs.need);
});

test('donate: two members racing for the last units never push a task past its need', async () => {
  const { owner, member, g } = await guildOf();
  await give(owner, g, 'ramparts_clay', 'MelvorBase:Clay', 140);
  const results = await Promise.all([
    give(owner, g, 'ramparts_clay', 'MelvorBase:Clay', 8),
    give(member, g, 'ramparts_clay', 'MelvorBase:Clay', 8),
    give(member, g, 'ramparts_clay', 'MelvorBase:Clay', 8),
  ]);
  assert.equal(results.reduce((sum, r) => sum + r.accepted, 0), 10);
  const clay = taskOf(await ok(owner, 'GET', g), 'ramparts_clay');
  assert.equal(clay.have, 150_000);
  assert.equal(clay.top.reduce((sum, t) => sum + t.amount, 0), 150_000);
});

test('counts: batches from /sync are applied once each, to every matching task', async () => {
  const { owner, member, guild, g } = await guildOf();
  const first = await syncOf(member, { seq: 100, kills: { 'MelvorBase:Chicken': 7, 'MelvorBase:Cow': 3 }, laps: { 'MelvorBase:SomeCourse': 2 }, steals: { 'MelvorBase:Man': 4 } });
  assert.equal(first.groundsAck, 100);
  assert.ok(guildIn(first, guild).groundsRev > 0);
  // The same batch again, and an older one, change nothing but are still acknowledged.
  assert.equal((await syncOf(member, { seq: 100, kills: { 'MelvorBase:Chicken': 7 } })).groundsAck, 100);
  assert.equal((await syncOf(member, { seq: 50, kills: { 'MelvorBase:Chicken': 7 } })).groundsAck, 50);
  // Junk is dropped without failing the sync.
  await syncOf(member, { seq: 101, kills: { 'not an id': 5, 'MelvorBase:Cow': -2, 'MelvorBase:Pig': 1.5 }, laps: 'many' });
  assert.equal((await syncOf(member, 'nonsense')).groundsAck, undefined);
  assert.equal((await syncOf(member)).groundsAck, undefined);

  const view = await ok(owner, 'GET', g);
  for (const loc of locations(view)) {
    const kills = loc.tasks.find((t) => t.kind === 'kill');
    assert.equal(kills.have, kills.enemies ? 0 : Math.min(kills.need, 10_000), kills.id); // chickens and cows are not on any list
    assert.equal(loc.tasks.find((t) => t.kind === 'lap').have, 2_000);
    assert.equal(loc.tasks.find((t) => t.kind === 'steal').have, 4_000);
    assert.deepEqual(kills.top.map((t) => t.name), kills.enemies ? [] : ['Member']);
  }
  // Counts never overshoot.
  await syncOf(owner, { seq: 1, kills: { 'MelvorBase:Chicken': 100_000, 'MelvorBase:Wolf': 5 } });
  assert.equal(taskOf(await ok(owner, 'GET', g), 'kennels_kills').have, 5_000); // wolves are beasts
  const kills = taskOf(await ok(owner, 'GET', g), 'gatehouse_kills');
  assert.equal(kills.have, kills.need);
});

test('counts go to every guild the player is in', async () => {
  const a = await guildOf();
  const { guild: second } = await ok(a.member, 'POST', '/guilds', { name: `Second ${randomBytes(4).toString('hex')}`, description: '' });
  await syncOf(a.member, { seq: 5, laps: { 'MelvorBase:SomeCourse': 3 } });
  assert.equal(taskOf(await ok(a.owner, 'GET', a.g), 'moat_laps').have, 3_000);
  assert.equal(taskOf(await ok(a.member, 'GET', `/guilds/${second.id}/grounds`), 'moat_laps').have, 3_000);
});

test('completing every task at a location gives the guild its bonus through /sync', async () => {
  const { owner, member, guild, g } = await guildOf();
  await give(owner, g, 'moat_fish', GROUPS.fish.base, 300);
  await give(owner, g, 'moat_crops', GROUPS.crops.base, 250);
  await syncOf(owner, { seq: 1, kills: { 'MelvorBase:Chicken': 500, 'MelvorBase:Sailfish': 60 }, laps: { 'MelvorBase:SomeCourse': 19 }, steals: { 'MelvorBase:Man': 30 } });
  assert.deepEqual(guildIn(await syncOf(member), guild).bonuses, []);
  assert.equal(locations(await ok(owner, 'GET', g)).find((l) => l.id === 'moat').done, false);

  // The sync that carries the last lap already reports the bonus.
  const done = await syncOf(member, { seq: 1, laps: { 'MelvorBase:SomeCourse': 1 } });
  assert.deepEqual(guildIn(done, guild).bonuses, [{ id: 'fishingSpeed', value: 2 }]);
  assert.deepEqual(guildIn(await syncOf(owner), guild).bonuses, [{ id: 'fishingSpeed', value: 2 }]);
  const view = await ok(owner, 'GET', g);
  assert.deepEqual(locations(view).filter((l) => l.done).map((l) => l.id), ['moat']);
});

test('leaving keeps contributions; deleting your data removes them; disbanding removes the grounds', async () => {
  const { owner, member, guild, g } = await guildOf();
  await give(member, g, 'kennels_bones', 'MelvorBase:Bone', 20);
  await give(owner, g, 'kennels_bones', 'MelvorBase:BigBone', 4);
  await ok(member, 'POST', `/guilds/${guild.id}/leave`);
  let bones = taskOf(await ok(owner, 'GET', g), 'kennels_bones');
  assert.deepEqual(bones.top.map((t) => [t.name, t.amount]), [['Member', 20_000], ['Owner', 5_000]]);

  await ok(member, 'DELETE', '/me');
  bones = taskOf(await ok(owner, 'GET', g), 'kennels_bones');
  assert.equal(bones.have, 25_000); // the guild keeps the progress
  assert.deepEqual(bones.top.map((t) => t.name), ['Owner']);

  const db = client.db('groundstest');
  const docsBefore = await db.collection('grounds').countDocuments({});
  await ok(owner, 'DELETE', `/guilds/${guild.id}`);
  assert.equal(await db.collection('grounds').countDocuments({}), docsBefore - 1);
  assert.equal(await db.collection('groundsTotals').countDocuments({ playerId: { $in: [owner.id, member.id] } }), 0);
  await fails(404, 'guild_not_found', owner, 'GET', g);
});
