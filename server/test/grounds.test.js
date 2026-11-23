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

const NEED = new Map(TIERS.flatMap((t) => t.locations.flatMap((l) => l.tasks.map((x) => [x.id, x.need]))));
const need = (id) => NEED.get(id);
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
  assert.equal(locations(view).length, 35);
  assert.deepEqual(view.tiers.map((x) => x.locations.length), [5, 10, 6, 7, 7]);
  const logs = taskOf(view, 'gatehouse_logs');
  assert.deepEqual([logs.kind, logs.need, logs.have, logs.mine, logs.top.length], ['donate', need('gatehouse_logs') * 1000, 0, 0, 0]);
  assert.deepEqual(logs.items.find((i) => i.item === GROUPS.logs.base), { item: GROUPS.logs.base, worth: 1000 });
  assert.equal(taskOf(view, 'gatehouse_kills').items, undefined);
  assert.ok(locations(view).every((l) => !l.done && l.bonus.id && l.bonus.text));
  await fails(403, 'not_member', outsider, 'GET', g);
  await fails(403, 'not_member', outsider, 'POST', `${g}/donate`, { task: 'gatehouse_logs', item: LOGS[BASE], qty: 1, nonce: nonce() });
});

test('donate: worth by step, each player has their own progress, a repeated nonce counts once, and bad input is refused', async () => {
  const { owner, member, guild, g } = await guildOf();
  const rev0 = guildIn(await syncOf(owner), guild).groundsRev;
  const memberRev0 = guildIn(await syncOf(member), guild).groundsRev;

  assert.deepEqual(await give(owner, g, 'gatehouse_logs', LOGS[BASE], 10), { accepted: 10, qty: 10 });
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE + 1], 10), { accepted: 10, qty: 10 });
  const n = nonce();
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE - 1], 10, n), { accepted: 10, qty: 10 });
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE - 1], 10, n), { accepted: 10, qty: 10 });

  const view = await ok(member, 'GET', g);
  const logs = taskOf(view, 'gatehouse_logs');
  assert.equal(logs.have, 12_500 + 8_000);
  assert.deepEqual([logs.mine, logs.top], [20_500, []]);
  // What a guild mate gave is theirs alone.
  const ownerView = await ok(owner, 'GET', g);
  assert.equal(taskOf(ownerView, 'gatehouse_logs').have, 10_000);
  assert.equal(guildIn(await syncOf(owner), guild).groundsRev, rev0 + 1);
  assert.equal(guildIn(await syncOf(member), guild).groundsRev, memberRev0 + 2);
  assert.equal(ownerView.rev, rev0 + 1);

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
  const feathers = need('watchtower_feathers');
  assert.equal((await give(owner, g, 'watchtower_feathers', 'MelvorBase:Feathers', feathers - 10)).accepted, feathers - 10);
  assert.deepEqual(await give(owner, g, 'watchtower_feathers', 'MelvorBase:Feathers', 50), { accepted: 10, qty: 50 });
  assert.deepEqual(await give(owner, g, 'watchtower_feathers', 'MelvorBase:Feathers', 5), { accepted: 0, qty: 5 });
  // 7.2 base logs short: six step-up logs (1.25 each) cover it, the seventh is not needed.
  await give(owner, g, 'watchtower_logs', LOGS[BASE], need('watchtower_logs') - 8);
  await give(owner, g, 'watchtower_logs', LOGS[BASE - 1], 1); // 0.8 more: 7.2 short
  assert.deepEqual(await give(owner, g, 'watchtower_logs', LOGS[BASE + 1], 9), { accepted: 6, qty: 9 });
  const logs = taskOf(await ok(owner, 'GET', g), 'watchtower_logs');
  assert.equal(logs.have, logs.need);
});

test('donate: donations racing for the last units never push a task past its need', async () => {
  const { owner, g } = await guildOf();
  await give(owner, g, 'ramparts_clay', 'MelvorBase:Clay', need('ramparts_clay') - 10);
  const results = await Promise.all([
    give(owner, g, 'ramparts_clay', 'MelvorBase:Clay', 8),
    give(owner, g, 'ramparts_clay', 'MelvorBase:Clay', 8),
    give(owner, g, 'ramparts_clay', 'MelvorBase:Clay', 8),
  ]);
  assert.equal(results.reduce((sum, r) => sum + r.accepted, 0), 10);
  const clay = taskOf(await ok(owner, 'GET', g), 'ramparts_clay');
  assert.equal(clay.have, clay.need);
});

const KILLS = 'MelvorBase:CombatEnemyKilled';
const COURSES = 'MelvorBase:AgilityCourseCompleted';
const THEFTS = 'MelvorBase:ThievingSuccessfulAction';
const COOKED = 'MelvorBase:CookingItemGained';

test('counts: batches from /sync are applied once each, only to the tasks that name that counter and object', async () => {
  const { owner, member, guild, g } = await guildOf();
  const first = await syncOf(member, {
    seq: 100,
    counts: {
      [KILLS]: { 'MelvorBase:Golbin': 7, 'MelvorBase:GolbinScout': 3, 'MelvorBase:Chicken': 9 },
      [COURSES]: { 'MelvorBase:Climb1': 2, 'MelvorBase:SomeCourse': 50 },
      [THEFTS]: { 'MelvorBase:Citizen': 4 },
      [COOKED]: { 'MelvorBase:Shrimp': 6, 'MelvorBase:Sardine': 5, 'MelvorBase:Trout': 1 },
      'MelvorBase:SmithingItemGained': { 'MelvorBase:Shrimp': 99 }, // the right item from the wrong skill
    },
  });
  assert.equal(first.groundsAck, 100);
  assert.ok(guildIn(first, guild).groundsRev > 0);
  // The same batch again, and an older one, change nothing but are still acknowledged.
  assert.equal((await syncOf(member, { seq: 100, counts: { [KILLS]: { 'MelvorBase:Golbin': 7 } } })).groundsAck, 100);
  assert.equal((await syncOf(member, { seq: 50, counts: { [KILLS]: { 'MelvorBase:Golbin': 7 } } })).groundsAck, 50);
  // Junk is dropped without failing the sync.
  await syncOf(member, { seq: 101, counts: { [KILLS]: { 'not an id': 5, 'MelvorBase:Golbin': -2, 'MelvorBase:GolbinScout': 1.5 }, [COURSES]: 'many', 'bad counter': { 'MelvorBase:Climb1': 3 } } });
  await syncOf(member, { seq: 102, counts: 'nonsense' });
  assert.equal((await syncOf(member, 'nonsense')).groundsAck, undefined);
  assert.equal((await syncOf(member)).groundsAck, undefined);

  assert.equal(taskOf(await ok(owner, 'GET', g), 'gatehouse_kills').have, 0); // not a guild mate's
  const view = await ok(member, 'GET', g);
  const have = (id) => taskOf(view, id).have;
  // Golbins live in the Golbin Forest (Gatehouse and Watchtower); chickens are in no area.
  assert.deepEqual(['gatehouse_kills', 'watchtower_kills', 'ramparts_kills', 'kennels_kills'].map(have), [10_000, 10_000, 0, 0]);
  assert.equal(have('gatehouse_act1'), 2_000); // Climb 1 only
  assert.equal(have('ramparts_act2'), 0); // Climb 2
  assert.equal(have('gatehouse_act2'), 4_000); // Citizens
  assert.equal(have('moat_act2'), 0); // Thugs
  assert.equal(have('moat_act1'), 11_000); // Shrimp and Sardines cooked, not Trout
  assert.equal(have('ramparts_act1'), 0); // Copper Bars smithed
  assert.equal(have('kitchen_act1'), 1_000); // Trout
  const kills = taskOf(view, 'gatehouse_kills');
  assert.deepEqual([kills.kind, kills.stat, kills.area, kills.ids.includes('MelvorBase:Golbin')], ['kill', KILLS, 'Golbin Forest', true]);
  // A task without `ids` counts everything its counter counts.
  await syncOf(member, { seq: 103, counts: { 'MelvorBase:HerbloreItemGained': { 'MelvorBase:FishingPotionP1A': 3, 'MelvorBase:MiningPotionP1A': 2 } } });
  const brew = taskOf(await ok(member, 'GET', g), 'brewery_act2');
  assert.deepEqual([brew.have, brew.ids], [5_000, undefined]);

  // Counts never overshoot.
  await syncOf(owner, { seq: 1, counts: { [KILLS]: { 'MelvorBase:Golbin': 100_000, 'MelvorBase:MagicCow': 5 } } });
  assert.equal(taskOf(await ok(owner, 'GET', g), 'kennels_kills').have, 5_000); // Magic Cows live in the Corrupted Farmlands
  const full = taskOf(await ok(owner, 'GET', g), 'gatehouse_kills');
  assert.equal(full.have, full.need);
});

test('a player has one set of progress, the same in every guild they are in and kept when they change guilds', async () => {
  const a = await guildOf();
  const { guild: second } = await ok(a.member, 'POST', '/guilds', { name: `Second ${randomBytes(4).toString('hex')}`, description: '' });
  const g2 = `/guilds/${second.id}/grounds`;
  await syncOf(a.member, { seq: 5, counts: { [THEFTS]: { 'MelvorBase:Thug': 3 } } });
  await give(a.member, g2, 'moat_fish', GROUPS.fish.base, 4);
  for (const g of [a.g, g2]) {
    const view = await ok(a.member, 'GET', g);
    assert.deepEqual([taskOf(view, 'moat_act2').have, taskOf(view, 'moat_fish').have], [3_000, 4_000]);
  }
  assert.equal(taskOf(await ok(a.owner, 'GET', a.g), 'moat_act2').have, 0);
  await ok(a.member, 'POST', `/guilds/${a.guild.id}/leave`);
  assert.equal(taskOf(await ok(a.member, 'GET', g2), 'moat_act2').have, 3_000);
});

test('completing every task at a location gives that player its bonus through /sync, once however many guilds they are in', async () => {
  const { owner, member, guild, g } = await guildOf();
  const { guild: second } = await ok(owner, 'POST', '/guilds', { name: `Second ${randomBytes(4).toString('hex')}`, description: '' });
  await give(owner, g, 'moat_fish', GROUPS.fish.base, need('moat_fish'));
  await give(owner, g, 'moat_crops', GROUPS.crops.base, need('moat_crops'));
  const almost = await syncOf(owner, {
    seq: 1,
    counts: {
      [KILLS]: { 'MelvorBase:Chicken': 500, 'MelvorBase:GreenSlime': need('moat_kills') },
      [COOKED]: { 'MelvorBase:Shrimp': need('moat_act1') },
      [THEFTS]: { 'MelvorBase:Thug': need('moat_act2') - 1 },
    },
  });
  assert.deepEqual(guildIn(almost, guild).bonuses, []);
  assert.equal(locations(await ok(owner, 'GET', g)).find((l) => l.id === 'moat').done, false);

  // The sync that carries the last pickpocket already reports the bonus, the same in each guild.
  const done = await syncOf(owner, { seq: 2, counts: { [THEFTS]: { 'MelvorBase:Thug': 1 } } });
  assert.deepEqual(done.guilds.map((x) => x.bonuses), [[{ id: 'fishingSpeed', value: 2 }], [{ id: 'fishingSpeed', value: 2 }]]);
  assert.deepEqual(locations(await ok(owner, 'GET', `/guilds/${second.id}/grounds`)).filter((l) => l.done).map((l) => l.id), ['moat']);
  // A guild mate did none of it and gets nothing.
  assert.deepEqual(guildIn(await syncOf(member), guild).bonuses, []);
  assert.equal(locations(await ok(member, 'GET', g)).some((l) => l.done), false);
  // The bonus needs a guild: out of every guild there is nowhere for it to be reported.
  await ok(owner, 'DELETE', `/guilds/${guild.id}`);
  await ok(owner, 'DELETE', `/guilds/${second.id}`);
  assert.deepEqual((await syncOf(owner)).guilds, []);
});

test('players from the time of shared guild progress start from what they contributed themselves', async () => {
  const { owner, member, guild, g } = await guildOf();
  const { guild: second } = await ok(owner, 'POST', '/guilds', { name: `Second ${randomBytes(4).toString('hex')}`, description: '' });
  const db = client.db('groundstest');
  const { ObjectId } = await import('mongodb');
  const moat = TIERS[0].locations.find((l) => l.id === 'moat');
  const all = Object.fromEntries(moat.tasks.map((t) => [t.id, t.need * 1000]));
  // As 0.6.1 left it: the owner finished the Moat alone in one guild and gave more in another;
  // the member gave a little. Counts were recorded in both of the owner's guilds.
  await db.collection('groundsTotals').insertMany([
    { guildId: new ObjectId(guild.id), playerId: owner.id, name: 'Owner', t: { ...all, gatehouse_logs: 30_000, gatehouse_kills: 7_000, old_task: 5 } },
    { guildId: new ObjectId(second.id), playerId: owner.id, name: 'Owner', t: { gatehouse_logs: 12_000, gatehouse_kills: 9_000 } },
    { guildId: new ObjectId(guild.id), playerId: member.id, name: 'Member', t: { gatehouse_logs: 2_000 } },
  ]);
  await db.collection('players').updateMany({ _id: { $in: [owner.id, member.id] } }, { $unset: { groundsSeeded: '', groundsRev: '', groundsDone: '' } });
  await db.collection('groundsMine').deleteMany({ _id: { $in: [owner.id, member.id] } });

  // A plain sync is enough to bring the bonus back.
  const sync = await syncOf(owner);
  assert.deepEqual(guildIn(sync, guild).bonuses, [{ id: 'fishingSpeed', value: 2 }]);
  assert.ok(guildIn(sync, guild).groundsRev >= 1_000_000);
  const view = await ok(owner, 'GET', g);
  assert.deepEqual(locations(view).filter((l) => l.done).map((l) => l.id), ['moat']);
  assert.equal(taskOf(view, 'gatehouse_logs').have, 42_000); // donations add up over guilds
  assert.equal(taskOf(view, 'gatehouse_kills').have, 9_000); // counts were in both: the larger one
  assert.equal(taskOf(await ok(member, 'GET', g), 'gatehouse_logs').have, 2_000);
  // Only once: later progress is not replaced by it.
  await give(owner, g, 'gatehouse_logs', LOGS[BASE], 1);
  await syncOf(owner);
  assert.equal(taskOf(await ok(owner, 'GET', g), 'gatehouse_logs').have, 43_000);
});

test('two finished locations with the same kind of bonus add up', async () => {
  const { bonusesOf } = await import('../src/grounds.js');
  assert.deepEqual(bonusesOf({ groundsDone: ['gatehouse', 'armory', 'moat', 'nope'] }), [{ id: 'protection', value: 5 }, { id: 'fishingSpeed', value: 2 }]);
  assert.deepEqual(bonusesOf({}), []);
});

test('disbanding a guild keeps its members\' progress; deleting your data removes yours', async () => {
  const { owner, member, guild, g } = await guildOf();
  await give(member, g, 'kennels_bones', 'MelvorBase:Bone', 20);
  await give(owner, g, 'kennels_bones', 'MelvorBase:BigBone', 4);
  const db = client.db('groundstest');
  assert.equal((await db.collection('groundsMine').findOne({ _id: member.id })).p.kennels_bones, 20_000);

  await ok(member, 'DELETE', '/me');
  assert.equal(await db.collection('groundsMine').countDocuments({ _id: member.id }), 0);
  assert.equal(await db.collection('groundsGifts').countDocuments({ playerId: member.id }), 0);

  await ok(owner, 'DELETE', `/guilds/${guild.id}`);
  await fails(404, 'guild_not_found', owner, 'GET', g);
  const { guild: next } = await ok(owner, 'POST', '/guilds', { name: `Next ${randomBytes(4).toString('hex')}`, description: '' });
  assert.equal(taskOf(await ok(owner, 'GET', `/guilds/${next.id}/grounds`), 'kennels_bones').have, 5_000);
});
