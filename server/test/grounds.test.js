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
// Added to the real time, so a test can let weeks pass.
let clock = 0;

before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  store = createStore(client.db('groundstest'));
  await store.init();
  const app = createApp({ store, now: () => Date.now() + clock, limits: { rate: { register: [10_000, 3_600_000], write: [10_000, 60_000], read: [10_000, 60_000], sync: [10_000, 60_000] } } });
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
const KILLS = 'MelvorBase:CombatEnemyKilled';
const COURSES = 'MelvorBase:AgilityCourseCompleted';
const THEFTS = 'MelvorBase:ThievingSuccessfulAction';
const COOKED = 'MelvorBase:CookingItemGained';

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

test('view: members see every location with empty progress, amounts are for the whole guild; outsiders do not', async () => {
  const { owner, outsider, g } = await guildOf();
  const view = await ok(owner, 'GET', g);
  assert.equal(view.unit, 1000);
  assert.equal(view.members, 2);
  assert.equal(locations(view).length, 35);
  assert.deepEqual(view.tiers.map((x) => x.locations.length), [5, 10, 6, 7, 7]);
  const logs = taskOf(view, 'gatehouse_logs');
  assert.deepEqual([logs.kind, logs.need, logs.have, logs.mine, logs.top.length], ['donate', need('gatehouse_logs') * 2 * 1000, 0, 0, 0]);
  assert.deepEqual(logs.items.find((i) => i.item === GROUPS.logs.base), { item: GROUPS.logs.base, worth: 1000 });
  assert.equal(taskOf(view, 'gatehouse_kills').items, undefined);
  assert.ok(locations(view).every((l) => !l.done && l.state === 'open' && l.until === 0 && l.bonus.id && l.bonus.text));
  await fails(403, 'not_member', outsider, 'GET', g);
  await fails(403, 'not_member', outsider, 'POST', `${g}/donate`, { task: 'gatehouse_logs', item: LOGS[BASE], qty: 1, nonce: nonce() });
});

test('donate: worth by step, the guild shares progress and sees who gave what, a repeated nonce counts once, bad input is refused', async () => {
  const { owner, member, guild, g } = await guildOf();
  const rev0 = guildIn(await syncOf(owner), guild).groundsRev;

  assert.deepEqual(await give(owner, g, 'gatehouse_logs', LOGS[BASE], 10), { accepted: 10, qty: 10 });
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE + 1], 10), { accepted: 10, qty: 10 });
  const n = nonce();
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE - 1], 10, n), { accepted: 10, qty: 10 });
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE - 1], 10, n), { accepted: 10, qty: 10 });

  for (const [who, mine] of [[owner, 10_000], [member, 20_500]]) {
    const logs = taskOf(await ok(who, 'GET', g), 'gatehouse_logs');
    assert.deepEqual([logs.have, logs.mine], [30_500, mine]);
    assert.deepEqual(logs.top, [{ id: member.id, name: 'Member', amount: 20_500 }, { id: owner.id, name: 'Owner', amount: 10_000 }]);
  }
  assert.ok(guildIn(await syncOf(member), guild).groundsRev > rev0);

  const d = `${g}/donate`;
  await fails(400, 'bad_task', owner, 'POST', d, { task: 'gatehouse_kills', item: LOGS[BASE], qty: 1, nonce: nonce() });
  await fails(400, 'bad_task', owner, 'POST', d, { task: 'nope', item: LOGS[BASE], qty: 1, nonce: nonce() });
  await fails(400, 'bad_item', owner, 'POST', d, { task: 'gatehouse_logs', item: 'MelvorBase:Clay', qty: 1, nonce: nonce() });
  await fails(400, 'bad_qty', owner, 'POST', d, { task: 'gatehouse_logs', item: LOGS[BASE], qty: 0, nonce: nonce() });
  await fails(400, 'bad_qty', owner, 'POST', d, { task: 'gatehouse_logs', item: LOGS[BASE], qty: 1.5, nonce: nonce() });
  await fails(400, 'bad_nonce', owner, 'POST', d, { task: 'gatehouse_logs', item: LOGS[BASE], qty: 1, nonce: 'x' });
});

test('donate: a donation larger than what is left is trimmed, and a full task accepts nothing', async () => {
  const { owner, member, g } = await guildOf();
  const all = need('gatehouse_logs') * 2;
  await give(owner, g, 'gatehouse_logs', LOGS[BASE], all - 9);
  // 9 left: 8 of the next log up (1.25 each) cover it, the other 12 go back.
  assert.deepEqual(await give(member, g, 'gatehouse_logs', LOGS[BASE + 1], 20), { accepted: 8, qty: 20 });
  assert.deepEqual(await give(owner, g, 'gatehouse_logs', LOGS[BASE], 5), { accepted: 0, qty: 5 });
  const logs = taskOf(await ok(owner, 'GET', g), 'gatehouse_logs');
  assert.equal(logs.have, logs.need);
});

test('donate: donations racing for the last units never push a task past its need', async () => {
  const { owner, member, g } = await guildOf();
  const all = need('watchtower_feathers') * 2;
  await give(owner, g, 'watchtower_feathers', 'MelvorBase:Feathers', all - 10);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => give(i % 2 ? owner : member, g, 'watchtower_feathers', 'MelvorBase:Feathers', 4)));
  assert.equal(results.reduce((sum, r) => sum + r.accepted, 0), 10);
  const task = taskOf(await ok(owner, 'GET', g), 'watchtower_feathers');
  assert.equal(task.have, task.need);
  assert.equal(task.top.reduce((sum, x) => sum + x.amount, 0), task.need);
});

test('counts: batches from /sync are applied once each, to the guild, only to the tasks that name that counter and object', async () => {
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

  const view = await ok(owner, 'GET', g); // a guild mate sees it too
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
  assert.deepEqual(kills.top, [{ id: member.id, name: 'Member', amount: 10_000 }]);
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

test('counts go to every guild the player is in; a donation only to the guild it was made in', async () => {
  const a = await guildOf();
  const { guild: second } = await ok(a.member, 'POST', '/guilds', { name: `Second ${randomBytes(4).toString('hex')}`, description: '' });
  const g2 = `/guilds/${second.id}/grounds`;
  await syncOf(a.member, { seq: 5, counts: { [THEFTS]: { 'MelvorBase:Thug': 3 } } });
  await give(a.member, g2, 'moat_fish', GROUPS.fish.base, 4);
  const [one, two] = [await ok(a.member, 'GET', a.g), await ok(a.member, 'GET', g2)];
  assert.deepEqual([taskOf(one, 'moat_act2').have, taskOf(one, 'moat_fish').have], [3_000, 0]);
  assert.deepEqual([taskOf(two, 'moat_act2').have, taskOf(two, 'moat_fish').have], [3_000, 4_000]);
  assert.equal(taskOf(two, 'moat_fish').need, need('moat_fish') * 1000); // a guild of one
});

/** Does everything the Moat asks of a guild of `size`. */
async function finishMoat(p, g, size, seq, short = 0) {
  await give(p, g, 'moat_fish', GROUPS.fish.base, need('moat_fish') * size);
  await give(p, g, 'moat_crops', GROUPS.crops.base, need('moat_crops') * size);
  return syncOf(p, {
    seq,
    counts: {
      [KILLS]: { 'MelvorBase:GreenSlime': need('moat_kills') * size },
      [COOKED]: { 'MelvorBase:Shrimp': need('moat_act1') * size },
      [THEFTS]: { 'MelvorBase:Thug': need('moat_act2') * size - short },
    },
  });
}
const moatOf = async (p, g) => locations(await ok(p, 'GET', g)).find((l) => l.id === 'moat');
const gidOf = async (guild) => (await client.db('groundstest').collection('guilds').findOne({ name: guild.name }))._id;
const DAY = 24 * 60 * 60 * 1000;
const FISHING = [{ id: 'fishingSpeed', value: 2 }];

test('amounts follow the number of members; a member leaving can finish a location', async () => {
  const { owner, member, guild, g } = await guildOf();
  const third = await newPlayer('Third');
  await ok(third, 'POST', `/guilds/${guild.id}/join`);
  await ok(owner, 'POST', `/guilds/${guild.id}/requests/${third.id}`, { accept: true });
  assert.equal(taskOf(await ok(owner, 'GET', g), 'moat_fish').need, need('moat_fish') * 3000);

  // Enough for two members, which is not enough for three.
  assert.deepEqual(guildIn(await finishMoat(member, g, 2, 1), guild).bonuses, []);
  assert.equal((await moatOf(owner, g)).state, 'open');
  await ok(third, 'POST', `/guilds/${guild.id}/leave`);
  assert.deepEqual(guildIn(await syncOf(owner), guild).bonuses, FISHING);
  assert.equal((await moatOf(owner, g)).state, 'active');
});

test('a finished location gives every member its bonus for 30 days, hides its tasks and takes nothing more', async () => {
  const { owner, member, guild, g } = await guildOf();
  const almost = await finishMoat(owner, g, 2, 1, 1);
  assert.deepEqual(guildIn(almost, guild).bonuses, []);
  assert.equal((await moatOf(owner, g)).done, false);

  // The sync that carries the last pickpocket already reports the bonus.
  const t0 = Date.now() + clock;
  const done = await syncOf(owner, { seq: 2, counts: { [THEFTS]: { 'MelvorBase:Thug': 1 } } });
  assert.deepEqual(guildIn(done, guild).bonuses, FISHING);
  assert.ok(guildIn(done, guild).groundsRev > guildIn(almost, guild).groundsRev);
  // A guild mate who did none of it has it, and so does someone who joins afterwards.
  assert.deepEqual(guildIn(await syncOf(member), guild).bonuses, FISHING);
  const late = await newPlayer('Late');
  await ok(late, 'POST', `/guilds/${guild.id}/join`);
  await ok(owner, 'POST', `/guilds/${guild.id}/requests/${late.id}`, { accept: true });
  assert.deepEqual(guildIn(await syncOf(late), guild).bonuses, FISHING);

  const moat = await moatOf(late, g);
  assert.deepEqual([moat.done, moat.state], [true, 'active']);
  assert.ok(Math.abs(moat.until - (t0 + 30 * DAY)) < 60_000);
  assert.equal(moat.renewFrom, moat.until - 7 * DAY);
  assert.ok(moat.tasks.every((t) => t.have === t.need && t.top.length === 0)); // what older games show as finished

  assert.deepEqual(await give(member, g, 'moat_fish', GROUPS.fish.base, 5), { accepted: 0, qty: 5 });
  await syncOf(member, { seq: 1, counts: { [THEFTS]: { 'MelvorBase:Thug': 9 } } });
  const p = await store.guildGrounds(await gidOf(guild));
  assert.deepEqual([p.moat_fish, p.moat_act2], [0, 0]);
});

test('in the last week the tasks come back at nothing, and finishing them adds 30 days to the end date', async () => {
  const { owner, member, guild, g } = await guildOf();
  await finishMoat(owner, g, 2, 1);
  const first = await moatOf(owner, g);
  const rev = guildIn(await syncOf(owner), guild).groundsRev;

  clock += 23 * DAY + 60_000;
  const week = await syncOf(member);
  assert.deepEqual(guildIn(week, guild).bonuses, FISHING);
  assert.notEqual(guildIn(week, guild).groundsRev, rev); // games reload the tab with nothing having been written
  const open = await moatOf(member, g);
  assert.deepEqual([open.done, open.state, open.until], [true, 'renew', first.until]);
  assert.ok(open.tasks.every((t) => t.have === 0));

  assert.deepEqual(await give(member, g, 'moat_fish', GROUPS.fish.base, 5), { accepted: 5, qty: 5 });
  await give(member, g, 'moat_fish', GROUPS.fish.base, need('moat_fish') * 2); // trimmed
  await give(member, g, 'moat_crops', GROUPS.crops.base, need('moat_crops') * 2);
  await syncOf(member, { seq: 1, counts: { [KILLS]: { 'MelvorBase:GreenSlime': need('moat_kills') * 2 }, [COOKED]: { 'MelvorBase:Shrimp': need('moat_act1') * 2 }, [THEFTS]: { 'MelvorBase:Thug': need('moat_act2') * 2 } } });
  const again = await moatOf(owner, g);
  assert.deepEqual([again.state, again.until], ['active', first.until + 30 * DAY]);
});

test('a bonus that is not renewed ends; the location opens again with the renewal progress made so far', async () => {
  const { owner, member, guild, g } = await guildOf();
  await finishMoat(owner, g, 2, 1);
  clock += 25 * DAY;
  await give(member, g, 'moat_fish', GROUPS.fish.base, 7);
  const rev = guildIn(await syncOf(owner), guild).groundsRev;

  clock += 6 * DAY;
  const gone = await syncOf(owner);
  assert.deepEqual(guildIn(gone, guild).bonuses, []);
  assert.notEqual(guildIn(gone, guild).groundsRev, rev);
  const moat = await moatOf(owner, g);
  assert.deepEqual([moat.done, moat.state, moat.until], [false, 'open', 0]);
  assert.equal(moat.tasks.find((t) => t.id === 'moat_fish').have, 7_000);

  const t0 = Date.now() + clock;
  assert.deepEqual(guildIn(await finishMoat(owner, g, 2, 2), guild).bonuses, FISHING);
  assert.ok(Math.abs((await moatOf(owner, g)).until - (t0 + 30 * DAY)) < 60_000);
});

test('a guild from the time of own progress starts with its members\' progress added together', async () => {
  const { owner, member, guild, g } = await guildOf();
  const db = client.db('groundstest');
  await db.collection('guilds').updateOne({ _id: await gidOf(guild) }, { $unset: { groundsPooled: '' } });
  const whole = Object.fromEntries(['moat_fish', 'moat_crops', 'moat_kills', 'moat_act1', 'moat_act2'].map((id) => [id, need(id) * 1000]));
  await db.collection('groundsMine').insertMany([
    { _id: owner.id, p: { ...whole, gatehouse_logs: 30_000, nope: 5 } },
    { _id: member.id, p: { ...whole, gatehouse_logs: 12_000, watchtower_kills: 4_000 } },
  ]);

  // Both had finished the Moat, so the guild of two has: its 30 days start now.
  const first = await syncOf(owner);
  assert.deepEqual(guildIn(first, guild).bonuses, FISHING);
  assert.ok(guildIn(first, guild).groundsRev >= 2_000_000);
  const view = await ok(member, 'GET', g);
  const logs = taskOf(view, 'gatehouse_logs');
  assert.deepEqual([logs.have, logs.mine, logs.top.map((x) => x.amount)], [42_000, 12_000, [30_000, 12_000]]);
  assert.equal(taskOf(view, 'watchtower_kills').have, 4_000);
  // Once only.
  await syncOf(member);
  assert.equal(taskOf(await ok(owner, 'GET', g), 'gatehouse_logs').have, 42_000);

  // A guild made now starts empty, whatever its founder did alone.
  const { guild: fresh } = await ok(owner, 'POST', '/guilds', { name: `Fresh ${randomBytes(4).toString('hex')}`, description: '' });
  assert.equal(taskOf(await ok(owner, 'GET', `/guilds/${fresh.id}/grounds`), 'gatehouse_logs').have, 0);
});

test('two finished locations with the same kind of bonus add up; an ended one does not count', async () => {
  const { createGrounds } = await import('../src/grounds.js');
  const { bonusesOf } = createGrounds({ now: () => 1000 });
  const soon = new Date(5000);
  assert.deepEqual(bonusesOf({ groundsDone: { gatehouse: soon, armory: soon, moat: soon, kennels: new Date(500), nope: soon } }),
    [{ id: 'protection', value: 5 }, { id: 'fishingSpeed', value: 2 }]);
  assert.deepEqual(bonusesOf({}), []);
});

test('deleting your data takes your name off the guild\'s progress; disbanding removes the grounds', async () => {
  const { owner, member, guild, g } = await guildOf();
  await give(member, g, 'kennels_bones', 'MelvorBase:Bone', 20);
  await give(owner, g, 'kennels_bones', 'MelvorBase:BigBone', 4);
  const db = client.db('groundstest');
  const gid = await gidOf(guild);

  await ok(member, 'DELETE', '/me');
  assert.equal(await db.collection('groundsGivers').countDocuments({ playerId: member.id }), 0);
  assert.equal(await db.collection('groundsGifts').countDocuments({ playerId: member.id }), 0);
  const bones = taskOf(await ok(owner, 'GET', g), 'kennels_bones');
  assert.deepEqual([bones.have, bones.need, bones.top.length], [25_000, need('kennels_bones') * 1000, 1]);

  await ok(owner, 'DELETE', `/guilds/${guild.id}`);
  await fails(404, 'guild_not_found', owner, 'GET', g);
  assert.equal(await db.collection('groundsGuild').countDocuments({ _id: gid }), 0);
  assert.equal(await db.collection('groundsGivers').countDocuments({ guildId: gid }), 0);
});
