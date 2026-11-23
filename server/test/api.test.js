import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { createFetchHandler } from '../src/http.js';
import { createStore } from '../src/store.js';

let mongod, client, db, store;
let fetchApi; // default limits, except a roomy register limit (all tests share one "IP")

function makeFetch(limits, config) {
  const app = createApp({ store, limits, config });
  return createFetchHandler(async () => ({ handle: app.handle, ping: store.ping }));
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('guildtest');
  store = createStore(db);
  await store.init();
  fetchApi = makeFetch({ rate: { register: [10_000, 3_600_000] } });
});

after(async () => {
  await client?.close();
  await mongod?.stop();
});

// ---------- helpers ----------

let counter = 0;
// Valid SteamID64 format, in a range Steam has not handed out.
const newSteamId = () => `765612021${String(++counter).padStart(8, '0')}`;
const newKey = () => randomBytes(24).toString('hex');
const uniq = (prefix) => `${prefix} ${randomBytes(4).toString('hex')}`;

async function call(player, method, path, body, { fetcher = fetchApi, headers = {} } = {}) {
  const h = { 'x-mod-protocol': '1', ...headers };
  if (player) h.authorization = `Bearer ${player.id}:${player.key}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetcher(new Request(`https://guilds.test${path}`, init));
  return { status: res.status, body: await res.json() };
}

async function ok(player, method, path, body, opts) {
  const r = await call(player, method, path, body, opts);
  assert.ok(r.status === 200 || r.status === 201, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function fails(status, code, player, method, path, body, opts) {
  const r = await call(player, method, path, body, opts);
  assert.equal(r.status, status, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error.code, code);
  assert.equal(typeof r.body.error.message, 'string');
  return r.body;
}

async function newPlayer(name = 'Player') {
  const p = { id: newSteamId(), key: newKey(), name };
  await ok(null, 'POST', '/register', { steamId: p.id, name, key: p.key });
  return p;
}

async function newGuild(owner, description = '') {
  const { guild } = await ok(owner, 'POST', '/guilds', { name: uniq('Guild'), description });
  return guild;
}

/** Adds `player` to the guild through join request + accept. */
async function addTo(guild, owner, player) {
  await ok(player, 'POST', `/guilds/${guild.id}/join`);
  await ok(owner, 'POST', `/guilds/${guild.id}/requests/${player.id}`, { accept: true });
}

/** owner + officer + member in a fresh guild. */
async function trio() {
  const [owner, officer, member] = [await newPlayer('Owner'), await newPlayer('Officer'), await newPlayer('Member')];
  const guild = await newGuild(owner);
  await addTo(guild, owner, officer);
  await addTo(guild, owner, member);
  await ok(owner, 'POST', `/guilds/${guild.id}/members/${officer.id}/rank`, { rank: 'officer' });
  return { owner, officer, member, guild };
}

const ranks = async (viewer, guild) =>
  Object.fromEntries((await ok(viewer, 'GET', `/guilds/${guild.id}`)).members.map((m) => [m.id, m.rank]));

// ---------- tests ----------

test('health works without auth or protocol header', async () => {
  const res = await fetchApi(new Request('https://guilds.test/health?db=1'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'melvor2-guild-api', protocol: 1, db: true });
});

test('routing accepts the rewritten /api?__path= form and an /api prefix', async () => {
  const p = await newPlayer();
  const a = await ok(p, 'GET', '/api?__path=me');
  const b = await ok(p, 'GET', '/api/me');
  assert.equal(a.player.id, p.id);
  assert.equal(b.player.id, p.id);
  const s = await ok(p, 'GET', '/api?__path=guilds/search&q=zzzzzz');
  assert.deepEqual(s.guilds, []);
});

test('protocol header is required', async () => {
  const p = await newPlayer();
  for (const v of [undefined, '0', 'abc']) {
    const headers = { 'x-mod-protocol': v };
    if (v === undefined) delete headers['x-mod-protocol'];
    const req = new Request('https://guilds.test/me', {
      headers: { authorization: `Bearer ${p.id}:${p.key}`, ...headers },
    });
    const res = await fetchApi(req);
    assert.equal(res.status, 426);
    assert.equal((await res.json()).error.code, 'upgrade_required');
  }
  await ok(p, 'GET', '/me', undefined, { headers: { 'x-mod-protocol': '2' } }); // newer clients are fine
});

test('register: first claim wins, same key is idempotent, other key is refused', async () => {
  const id = newSteamId();
  const key = newKey();
  const first = await call(null, 'POST', '/register', { steamId: id, name: 'Alice', key });
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);

  const again = await call(null, 'POST', '/register', { steamId: id, name: 'Alice Renamed', key });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal((await ok({ id, key }, 'GET', '/me')).player.name, 'Alice Renamed');

  await fails(409, 'steam_id_claimed', null, 'POST', '/register', { steamId: id, name: 'Mallory', key: newKey() });
  await fails(401, 'unauthorized', { id, key: newKey() }, 'GET', '/me');
  await fails(401, 'unauthorized', { id: newSteamId(), key }, 'GET', '/me');
  await fails(401, 'unauthorized', null, 'GET', '/me');

  // Only the hash is stored.
  const doc = await db.collection('players').findOne({ _id: id });
  assert.match(doc.keyHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(doc).includes(key));
});

test('register: input validation', async () => {
  const good = { steamId: newSteamId(), name: 'X', key: newKey() };
  await fails(400, 'invalid_steam_id', null, 'POST', '/register', { ...good, steamId: '123' });
  await fails(400, 'invalid_steam_id', null, 'POST', '/register', { ...good, steamId: '99999999999999999' });
  await fails(400, 'invalid_steam_id', null, 'POST', '/register', { ...good, steamId: 76561202100000001 });
  await fails(400, 'invalid_key', null, 'POST', '/register', { ...good, key: 'short' });
  await fails(400, 'invalid_name', null, 'POST', '/register', { ...good, name: 'x'.repeat(33) });
  await fails(400, 'invalid_name', null, 'POST', '/register', { ...good, name: '\u0001\u0002' });
  await fails(400, 'invalid_json', null, 'POST', '/register', '{nope');
  await fails(400, 'invalid_json', null, 'POST', '/register', '[1]');
  await ok(null, 'POST', '/register', { ...good, name: 'x'.repeat(32) });
});

test('request bodies over 4 KB are refused', async () => {
  const p = await newPlayer();
  await fails(413, 'body_too_large', p, 'POST', '/guilds', { name: 'Big', description: 'x'.repeat(5000) });
});

test('unknown paths and methods', async () => {
  const p = await newPlayer();
  await fails(404, 'not_found', p, 'GET', '/nope');
  await fails(405, 'method_not_allowed', p, 'PATCH', '/me', {});
  await fails(404, 'guild_not_found', p, 'GET', '/guilds/not-an-id');
  await fails(404, 'guild_not_found', p, 'GET', '/guilds/0123456789abcdef01234567');
});

test('create guild: validation, unique name, shows up in /me and search', async () => {
  const a = await newPlayer('Alice');
  const b = await newPlayer('Bob');
  const name = uniq('Iron Wolves');
  const { guild } = await ok(a, 'POST', '/guilds', { name: `  ${name}  `, description: 'We chop\ntrees' });
  assert.equal(guild.name, name);
  assert.equal(guild.description, 'We chop trees');
  assert.equal(guild.rank, 'owner');
  assert.equal(guild.ownerId, a.id);

  await fails(409, 'name_taken', b, 'POST', '/guilds', { name: name.toUpperCase() });
  for (const bad of ['ab', 'x'.repeat(25), 'bad!name', 'emoji 😀', 42, undefined]) {
    await fails(400, 'invalid_guild_name', b, 'POST', '/guilds', { name: bad });
  }
  await fails(400, 'invalid_description', b, 'POST', '/guilds', { name: uniq('Ok'), description: 'd'.repeat(201) });
  await ok(b, 'POST', '/guilds', { name: uniq('Ok_-9'), description: 'd'.repeat(200) });

  const me = await ok(a, 'GET', '/me');
  assert.deepEqual(me.guilds.map((g) => [g.id, g.rank]), [[guild.id, 'owner']]);
  assert.deepEqual(me.invites, []);

  const found = await ok(b, 'GET', `/guilds/search?q=${encodeURIComponent(name.slice(3).toUpperCase())}`);
  assert.deepEqual(found.guilds.map((g) => [g.id, g.memberCount]), [[guild.id, 1]]);
  // Regex characters in q are literal.
  assert.deepEqual((await ok(b, 'GET', '/guilds/search?q=.*')).guilds, []);
});

test('join request: created, visible to staff only, accepted by officer', async () => {
  const { owner, officer, member, guild } = await trio();
  const joiner = await newPlayer('Joiner');

  const r1 = await call(joiner, 'POST', `/guilds/${guild.id}/join`);
  assert.equal(r1.status, 201);
  assert.deepEqual(r1.body, { joined: false, requested: true });
  assert.equal((await call(joiner, 'POST', `/guilds/${guild.id}/join`)).status, 200); // idempotent

  // An outsider sees the guild and their own pending state, but not who is in it.
  const outside = await ok(joiner, 'GET', `/guilds/${guild.id}`);
  assert.equal(outside.guild.myRank, null);
  assert.equal(outside.guild.myPending, 'request');
  assert.equal(outside.requests, undefined);
  assert.deepEqual(outside.members, []);
  assert.equal(outside.guild.memberCount, 3);
  assert.equal(outside.guild.ownerId, undefined);
  assert.ok(!JSON.stringify(outside).includes(owner.id));
  const inside = await ok(member, 'GET', `/guilds/${guild.id}`);
  assert.equal(inside.members.length, 3);
  assert.equal(inside.guild.ownerId, owner.id);
  const found = (await ok(joiner, 'GET', '/guilds/search?q=' + encodeURIComponent(guild.name))).guilds;
  assert.equal(found.length, 1);
  assert.equal(found[0].ownerId, undefined);
  assert.deepEqual((await ok(joiner, 'GET', '/me')).requests.map((r) => r.guildId), [guild.id]);

  // Plain members do not see or answer requests.
  const asMember = await ok(member, 'GET', `/guilds/${guild.id}`);
  assert.equal(asMember.requests, undefined);
  assert.ok(asMember.members.every((m) => 'lastSeen' in m));
  await fails(403, 'forbidden', member, 'POST', `/guilds/${guild.id}/requests/${joiner.id}`, { accept: true });
  await fails(403, 'not_member', joiner, 'POST', `/guilds/${guild.id}/requests/${joiner.id}`, { accept: true });

  const asOfficer = await ok(officer, 'GET', `/guilds/${guild.id}`);
  assert.deepEqual(asOfficer.requests.map((r) => [r.playerId, r.name]), [[joiner.id, 'Joiner']]);
  await fails(400, 'invalid_body', officer, 'POST', `/guilds/${guild.id}/requests/${joiner.id}`, { accept: 'yes' });
  await ok(officer, 'POST', `/guilds/${guild.id}/requests/${joiner.id}`, { accept: true });
  await fails(404, 'request_not_found', officer, 'POST', `/guilds/${guild.id}/requests/${joiner.id}`, { accept: true });

  assert.equal((await ranks(owner, guild))[joiner.id], 'member');
  assert.deepEqual((await ok(owner, 'GET', `/guilds/${guild.id}`)).requests, []);
  await fails(409, 'already_member', joiner, 'POST', `/guilds/${guild.id}/join`);
});

test('join request: declined, and cancelled by the requester', async () => {
  const owner = await newPlayer();
  const p = await newPlayer();
  const guild = await newGuild(owner);

  await ok(p, 'POST', `/guilds/${guild.id}/join`);
  await ok(owner, 'POST', `/guilds/${guild.id}/requests/${p.id}`, { accept: false });
  assert.equal((await ok(p, 'GET', `/guilds/${guild.id}`)).guild.myPending, null);

  await ok(p, 'POST', `/guilds/${guild.id}/join`);
  await ok(p, 'DELETE', `/guilds/${guild.id}/join`);
  assert.deepEqual((await ok(owner, 'GET', `/guilds/${guild.id}`)).requests, []);
  assert.equal((await ok(owner, 'GET', `/guilds/${guild.id}`)).members.length, 1);
});

test('invite: staff only, shows in /me and /sync, accept and decline', async () => {
  const { owner, officer, member, guild } = await trio();
  const a = await newPlayer('InviteeA');
  const b = await newPlayer('InviteeB');

  await fails(403, 'forbidden', member, 'POST', `/guilds/${guild.id}/invite`, { steamId: a.id });
  await fails(403, 'not_member', a, 'POST', `/guilds/${guild.id}/invite`, { steamId: b.id });
  await fails(404, 'player_not_found', owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: newSteamId() });
  await fails(400, 'invalid_target', owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: owner.id });
  await fails(409, 'already_member', owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: member.id });

  assert.equal((await call(officer, 'POST', `/guilds/${guild.id}/invite`, { steamId: a.id })).status, 201);
  assert.equal((await call(owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: a.id })).status, 200); // idempotent
  await ok(owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: b.id });

  const me = await ok(a, 'GET', '/me');
  assert.deepEqual(
    me.invites.map((i) => [i.guildId, i.guildName, i.by, i.byName]),
    [[guild.id, guild.name, officer.id, 'Officer']],
  );
  assert.equal((await ok(a, 'POST', '/sync', {})).invites.length, 1);
  assert.deepEqual((await ok(owner, 'GET', `/guilds/${guild.id}`)).invites.map((i) => i.playerId).sort(), [a.id, b.id].sort());

  // Staff cannot accept on the invitee's behalf; nobody else can use the invite.
  await fails(409, 'not_a_join_request', owner, 'POST', `/guilds/${guild.id}/requests/${a.id}`, { accept: true });
  await fails(404, 'invite_not_found', member, 'POST', `/invites/${guild.id}`, { accept: true });

  assert.deepEqual(await ok(a, 'POST', `/invites/${guild.id}`, { accept: true }), { ok: true, joined: true });
  assert.equal((await ranks(owner, guild))[a.id], 'member');
  assert.deepEqual((await ok(a, 'GET', '/me')).invites, []);
  await fails(404, 'invite_not_found', a, 'POST', `/invites/${guild.id}`, { accept: true });

  assert.deepEqual(await ok(b, 'POST', `/invites/${guild.id}`, { accept: false }), { ok: true, joined: false });
  assert.equal((await ranks(owner, guild))[b.id], undefined);
  assert.deepEqual((await ok(b, 'GET', '/me')).invites, []);

  // Staff can cancel an invite.
  const c = await newPlayer('InviteeC');
  await ok(owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: c.id });
  await ok(officer, 'POST', `/guilds/${guild.id}/requests/${c.id}`, { accept: false });
  assert.deepEqual((await ok(c, 'GET', '/me')).invites, []);
});

test('an invite and a join request for the same player meet in the middle', async () => {
  const owner = await newPlayer();
  const guild = await newGuild(owner);

  const a = await newPlayer();
  await ok(owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: a.id });
  assert.deepEqual(await ok(a, 'POST', `/guilds/${guild.id}/join`), { joined: true, requested: false });

  const b = await newPlayer();
  await ok(b, 'POST', `/guilds/${guild.id}/join`);
  assert.deepEqual(await ok(owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: b.id }), { joined: true, invited: false });

  const r = await ranks(owner, guild);
  assert.equal(r[a.id], 'member');
  assert.equal(r[b.id], 'member');
  const view = await ok(owner, 'GET', `/guilds/${guild.id}`);
  assert.deepEqual([view.requests, view.invites], [[], []]);
});

test('rank changes: owner only', async () => {
  const { owner, officer, member, guild } = await trio();
  const path = (p) => `/guilds/${guild.id}/members/${p.id}/rank`;

  await fails(403, 'forbidden', officer, 'POST', path(member), { rank: 'officer' });
  await fails(403, 'forbidden', member, 'POST', path(officer), { rank: 'member' });
  await fails(403, 'not_member', await newPlayer(), 'POST', path(member), { rank: 'officer' });
  await fails(400, 'invalid_rank', owner, 'POST', path(member), { rank: 'owner' });
  await fails(400, 'invalid_rank', owner, 'POST', path(member), { rank: 'king' });
  await fails(400, 'invalid_target', owner, 'POST', path(owner), { rank: 'member' });
  await fails(404, 'member_not_found', owner, 'POST', path(await newPlayer()), { rank: 'officer' });

  await ok(owner, 'POST', path(member), { rank: 'officer' });
  await ok(owner, 'POST', path(officer), { rank: 'member' });
  assert.deepEqual(await ranks(owner, guild), { [owner.id]: 'owner', [officer.id]: 'member', [member.id]: 'officer' });
});

test('guild settings and disband: owner only', async () => {
  const { owner, officer, member, guild } = await trio();
  const other = await newGuild(await newPlayer());
  for (const p of [officer, member]) {
    await fails(403, 'forbidden', p, 'PATCH', `/guilds/${guild.id}`, { description: 'hax' });
    await fails(403, 'forbidden', p, 'DELETE', `/guilds/${guild.id}`);
    await fails(403, 'forbidden', p, 'POST', `/guilds/${guild.id}/transfer`, { playerId: p.id });
  }
  await fails(403, 'not_member', await newPlayer(), 'PATCH', `/guilds/${guild.id}`, { description: 'hax' });
  await fails(400, 'nothing_to_update', owner, 'PATCH', `/guilds/${guild.id}`, {});
  await fails(409, 'name_taken', owner, 'PATCH', `/guilds/${guild.id}`, { name: other.name.toLowerCase() });
  await fails(400, 'invalid_guild_name', owner, 'PATCH', `/guilds/${guild.id}`, { name: 'x' });

  const newName = uniq('Renamed');
  const patched = await ok(owner, 'PATCH', `/guilds/${guild.id}`, { name: newName, description: 'New words' });
  assert.equal(patched.guild.name, newName);
  const view = await ok(member, 'GET', `/guilds/${guild.id}`);
  assert.deepEqual([view.guild.name, view.guild.description], [newName, 'New words']);
  // Renaming to the same name in a different case is allowed.
  await ok(owner, 'PATCH', `/guilds/${guild.id}`, { name: newName.toUpperCase() });
});

test('kick rules: officers kick members only, owner kicks anyone but self', async () => {
  const { owner, officer, member, guild } = await trio();
  const officer2 = await newPlayer('Officer2');
  const member2 = await newPlayer('Member2');
  await addTo(guild, owner, officer2);
  await addTo(guild, owner, member2);
  await ok(owner, 'POST', `/guilds/${guild.id}/members/${officer2.id}/rank`, { rank: 'officer' });
  const kick = (p) => `/guilds/${guild.id}/members/${p.id}`;

  await fails(403, 'forbidden', member, 'DELETE', kick(member2));
  await fails(403, 'forbidden', member, 'DELETE', kick(officer));
  await fails(403, 'not_member', await newPlayer(), 'DELETE', kick(member));
  await fails(403, 'forbidden', officer, 'DELETE', kick(officer2));
  await fails(403, 'forbidden', officer, 'DELETE', kick(owner));
  await fails(400, 'invalid_target', officer, 'DELETE', kick(officer));
  await fails(400, 'invalid_target', owner, 'DELETE', kick(owner));
  await fails(404, 'member_not_found', owner, 'DELETE', kick(await newPlayer()));

  await ok(officer, 'DELETE', kick(member2));
  await ok(owner, 'DELETE', kick(officer2));
  await ok(owner, 'DELETE', kick(member));
  assert.deepEqual(await ranks(owner, guild), { [owner.id]: 'owner', [officer.id]: 'officer' });
  assert.deepEqual((await ok(member, 'GET', '/me')).guilds, []);
  await fails(403, 'not_member', member, 'POST', `/guilds/${guild.id}/messages`, { body: 'still here?' });
});

test('transfer: old owner becomes officer, new owner has owner powers', async () => {
  const { owner, officer, member, guild } = await trio();
  await fails(400, 'invalid_target', owner, 'POST', `/guilds/${guild.id}/transfer`, { playerId: owner.id });
  await fails(404, 'member_not_found', owner, 'POST', `/guilds/${guild.id}/transfer`, { playerId: (await newPlayer()).id });
  await fails(400, 'invalid_steam_id', owner, 'POST', `/guilds/${guild.id}/transfer`, {});

  assert.deepEqual(await ok(owner, 'POST', `/guilds/${guild.id}/transfer`, { playerId: member.id }), { ok: true, ownerId: member.id });
  assert.deepEqual(await ranks(owner, guild), { [owner.id]: 'officer', [officer.id]: 'officer', [member.id]: 'owner' });
  assert.equal((await ok(member, 'GET', '/me')).guilds[0].rank, 'owner');
  assert.equal((await ok(owner, 'GET', '/me')).guilds[0].rank, 'officer');

  await fails(403, 'forbidden', owner, 'PATCH', `/guilds/${guild.id}`, { description: 'mine?' });
  await fails(403, 'forbidden', owner, 'POST', `/guilds/${guild.id}/transfer`, { playerId: officer.id });
  await ok(member, 'PATCH', `/guilds/${guild.id}`, { description: 'mine now' });
  await ok(owner, 'POST', `/guilds/${guild.id}/leave`); // the old owner may now leave
});

test('leave: members and officers can, the owner cannot', async () => {
  const { owner, officer, member, guild } = await trio();
  await fails(409, 'owner_cannot_leave', owner, 'POST', `/guilds/${guild.id}/leave`);
  await fails(403, 'not_member', await newPlayer(), 'POST', `/guilds/${guild.id}/leave`);
  await ok(member, 'POST', `/guilds/${guild.id}/leave`);
  await ok(officer, 'POST', `/guilds/${guild.id}/leave`);
  await fails(403, 'not_member', member, 'POST', `/guilds/${guild.id}/leave`);
  assert.deepEqual(await ranks(owner, guild), { [owner.id]: 'owner' });
});

test('disband removes the guild, members, requests and messages', async () => {
  const { owner, officer, member, guild } = await trio();
  const pending = await newPlayer();
  const invited = await newPlayer();
  await ok(pending, 'POST', `/guilds/${guild.id}/join`);
  await ok(owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: invited.id });
  await ok(member, 'POST', `/guilds/${guild.id}/messages`, { body: 'last words' });

  await ok(owner, 'DELETE', `/guilds/${guild.id}`);

  await fails(404, 'guild_not_found', owner, 'GET', `/guilds/${guild.id}`);
  for (const p of [owner, officer, member, pending, invited]) {
    const me = await ok(p, 'GET', '/me');
    assert.deepEqual([me.guilds, me.invites, me.requests], [[], [], []]);
  }
  for (const col of ['guilds', 'members', 'requests', 'messages']) {
    const filter = col === 'guilds' ? { nameLower: guild.name.toLowerCase() } : { guildId: { $exists: true } };
    const left = (await db.collection(col).find(filter).toArray()).filter((d) => col === 'guilds' || String(d.guildId) === guild.id);
    assert.equal(left.length, 0, `${col} still has documents for the disbanded guild`);
  }
  // The name is free again.
  await ok(owner, 'POST', '/guilds', { name: guild.name });
});

test('messages: members only, validated, control characters stripped', async () => {
  const { owner, member, guild } = await trio();
  const outsider = await newPlayer();
  const path = `/guilds/${guild.id}/messages`;

  await fails(403, 'not_member', outsider, 'POST', path, { body: 'hi' });
  await fails(403, 'not_member', outsider, 'GET', path);
  await fails(400, 'invalid_message', member, 'POST', path, { body: '' });
  await fails(400, 'invalid_message', member, 'POST', path, { body: ' \u0000\u0007 ' });
  await fails(400, 'invalid_message', member, 'POST', path, { body: 'x'.repeat(301) });
  await fails(400, 'invalid_message', member, 'POST', path, { body: 5 });

  const r = await call(member, 'POST', path, { body: '  he\u0000llo\u202e\tthere\r\n ' });
  assert.equal(r.status, 201);
  assert.equal(r.body.message.body, 'hello there');
  assert.equal(r.body.message.name, 'Member');
  assert.equal(r.body.message.playerId, member.id);
  assert.equal(r.body.message.guildId, guild.id);
  await ok(owner, 'POST', path, { body: 'x'.repeat(300) });

  const history = await ok(owner, 'GET', path);
  assert.deepEqual(history.messages.map((m) => m.body), ['hello there', 'x'.repeat(300)]);
});

test('sync: presence, status, and a cursor that delivers each message once', async () => {
  const { owner, member, guild } = await trio();
  const other = await newGuild(member); // member is in two guilds
  const post = (p, g, body) => ok(p, 'POST', `/guilds/${g.id}/messages`, { body });

  await post(owner, guild, 'one');
  await post(member, other, 'two');

  // First sync without a cursor returns recent history from all my guilds.
  const s1 = await ok(member, 'POST', '/sync', { status: { skill: 'Woodcutting', level: 42 } });
  assert.deepEqual(s1.messages.map((m) => m.body), ['one', 'two']);
  assert.deepEqual(s1.guilds.map((g) => [g.id, g.rank]).sort(), [[guild.id, 'member'], [other.id, 'owner']].sort());
  assert.equal(typeof s1.cursor, 'string');
  assert.equal(typeof s1.now, 'number');

  // Nothing new: nothing repeated, even though the server re-reads the overlap window.
  const s2 = await ok(member, 'POST', '/sync', { since: s1.cursor });
  assert.deepEqual(s2.messages, []);

  await post(owner, guild, 'three');
  await post(member, guild, 'four');
  const s3 = await ok(member, 'POST', '/sync', { since: s2.cursor });
  assert.deepEqual(s3.messages.map((m) => m.body), ['three', 'four']);
  const s4 = await ok(member, 'POST', '/sync', { since: s3.cursor });
  assert.deepEqual(s4.messages, []);

  // The owner is only in the first guild and never sees the other guild's messages.
  const o1 = await ok(owner, 'POST', '/sync', {});
  assert.deepEqual(o1.messages.map((m) => m.body), ['one', 'three', 'four']);
  assert.equal(o1.guilds.length, 1);

  // Presence: the member's status and lastSeen are visible to guild mates.
  const seen = o1.guilds[0].members.find((m) => m.id === member.id);
  assert.equal(seen.rank, 'member');
  assert.equal(seen.status.skill, 'Woodcutting');
  assert.equal(seen.status.level, 42);
  assert.ok(Math.abs(seen.lastSeen - Date.now()) < 60_000);
  assert.equal(o1.guilds[0].members[0].rank, 'owner'); // sorted by rank

  // Omitting status keeps it; null clears it; name can be refreshed.
  await ok(member, 'POST', '/sync', { since: s4.cursor });
  let view = await ok(owner, 'GET', `/guilds/${guild.id}`);
  assert.equal(view.members.find((m) => m.id === member.id).status.skill, 'Woodcutting');
  await ok(member, 'POST', '/sync', { since: s4.cursor, status: null, name: 'Member Renamed' });
  view = await ok(owner, 'GET', `/guilds/${guild.id}`);
  const m = view.members.find((x) => x.id === member.id);
  assert.equal(m.status, null);
  assert.equal(m.name, 'Member Renamed');

  await fails(400, 'invalid_cursor', member, 'POST', '/sync', { since: 'yesterday' });
  await fails(400, 'invalid_status', member, 'POST', '/sync', { status: { skill: 'x', level: -1 } });

  // Combat state rides along with the status, is range-checked, and is cleared by a status without it.
  const fight = { entity: 'MelvorBase:Combat', target: 'MelvorBase:Chicken', area: 'MelvorBase:Farmlands', name: 'Chicken' };
  await ok(member, 'POST', '/sync', { status: { skill: 'Combat', level: 0, action: fight, combat: { hp: 500, maxHp: 300, dps: 42, level: 17, interval: 2400, hit: 79 } } });
  view = await ok(owner, 'GET', `/guilds/${guild.id}`);
  const fighter = view.members.find((x) => x.id === member.id).status;
  assert.deepEqual(fighter.combat, { hp: 300, maxHp: 300, dps: 42, level: 17, interval: 2400, hit: 79 }); // hp clamped to maxHp
  assert.equal(fighter.action.area, 'MelvorBase:Farmlands');
  await ok(member, 'POST', '/sync', { status: { skill: 'Combat', level: 0, action: fight } });
  view = await ok(owner, 'GET', `/guilds/${guild.id}`);
  assert.equal(view.members.find((x) => x.id === member.id).status.combat, undefined);
  for (const combat of [{ hp: 1, maxHp: 0, dps: 1, level: 1 }, { hp: 1, maxHp: 10, dps: -1, level: 1 }, { hp: 1, maxHp: 10, dps: 1.5, level: 1 }, { hp: 1, maxHp: 10, dps: 1 }, { hp: 1, maxHp: 10, dps: 1, level: 1, interval: 5 }, { hp: 1, maxHp: 10, dps: 1, level: 1, hit: 0 }, 'strong']) {
    await fails(400, 'invalid_status', member, 'POST', '/sync', { status: { skill: 'Combat', level: 0, combat } });
  }
  await fails(401, 'unauthorized', { id: member.id, key: newKey() }, 'POST', '/sync', {});
  await fails(401, 'unauthorized', null, 'POST', '/sync', {});
});

test('sync: a message stamped just before the cursor is still delivered once', async () => {
  const owner = await newPlayer();
  const guild = await newGuild(owner);
  await ok(owner, 'POST', `/guilds/${guild.id}/messages`, { body: 'first' });
  const s1 = await ok(owner, 'POST', '/sync', {});
  assert.equal(s1.messages.length, 1);

  // Simulate an insert from another server instance that landed late with an older timestamp.
  const first = await db.collection('messages').findOne({ body: 'first', playerId: owner.id });
  await db.collection('messages').insertOne({
    guildId: first.guildId, playerId: owner.id, name: 'Player', body: 'late', at: new Date(first.at.getTime() - 500),
  });
  const s2 = await ok(owner, 'POST', '/sync', { since: s1.cursor });
  assert.deepEqual(s2.messages.map((m) => m.body), ['late']);
  const s3 = await ok(owner, 'POST', '/sync', { since: s2.cursor });
  assert.deepEqual(s3.messages, []);
});

test('sync: large backlogs are paged without loss', async () => {
  const fetcher = makeFetch({ syncMaxMessages: 3, syncInitialMessages: 2, rate: { register: [10_000, 3_600_000] } });
  const owner = await newPlayer();
  const guild = await newGuild(owner);
  const s0 = await ok(owner, 'POST', '/sync', {}, { fetcher });
  const gid = (await db.collection('members').findOne({ playerId: owner.id })).guildId;
  const base = Date.now();
  await db.collection('messages').insertMany(
    Array.from({ length: 8 }, (_, i) => ({ guildId: gid, playerId: owner.id, name: 'Player', body: `m${i}`, at: new Date(base + i) })),
  );
  const got = [];
  let cursor = s0.cursor;
  for (let i = 0; i < 5; i++) {
    const s = await ok(owner, 'POST', '/sync', { since: cursor }, { fetcher });
    assert.ok(s.messages.length <= 3);
    got.push(...s.messages.map((m) => m.body));
    cursor = s.cursor;
  }
  assert.deepEqual(got, ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  // A fresh client only gets the newest few.
  const fresh = await ok(owner, 'POST', '/sync', {}, { fetcher });
  assert.deepEqual(fresh.messages.map((m) => m.body), ['m6', 'm7']);
  assert.equal(guild.id, String(gid));
});

test('limit: at most 3 guilds per player', async () => {
  const p = await newPlayer();
  for (let i = 0; i < 3; i++) await newGuild(p);
  await fails(409, 'guild_limit', p, 'POST', '/guilds', { name: uniq('Fourth') });

  const owner = await newPlayer();
  const fourth = await newGuild(owner);
  await fails(409, 'guild_limit', p, 'POST', `/guilds/${fourth.id}/join`);
  // An invite can be sent but not accepted while at the limit; it survives for later.
  await ok(owner, 'POST', `/guilds/${fourth.id}/invite`, { steamId: p.id });
  await fails(409, 'guild_limit', p, 'POST', `/invites/${fourth.id}`, { accept: true });
  assert.equal((await ok(p, 'GET', '/me')).invites.length, 1);
  assert.equal((await ok(p, 'GET', '/me')).guilds.length, 3);

  const mine = (await ok(p, 'GET', '/me')).guilds[0];
  await ok(p, 'DELETE', `/guilds/${mine.id}`);
  await ok(p, 'POST', `/invites/${fourth.id}`, { accept: true });
  assert.equal((await ok(p, 'GET', '/me')).guilds.length, 3);
});

test('limit: member cap per guild (cap lowered to 3 for the test)', async () => {
  const fetcher = makeFetch({ maxMembersPerGuild: 3, rate: { register: [10_000, 3_600_000] } });
  const owner = await newPlayer();
  const guild = await newGuild(owner);
  const [a, b, c, d] = [await newPlayer(), await newPlayer(), await newPlayer(), await newPlayer()];
  const o = { fetcher };

  await ok(a, 'POST', `/guilds/${guild.id}/join`, undefined, o);
  await ok(b, 'POST', `/guilds/${guild.id}/join`, undefined, o);
  await ok(c, 'POST', `/guilds/${guild.id}/join`, undefined, o);
  await ok(owner, 'POST', `/guilds/${guild.id}/requests/${a.id}`, { accept: true }, o);
  await ok(owner, 'POST', `/guilds/${guild.id}/requests/${b.id}`, { accept: true }, o);
  // Full: the queued request cannot be accepted, new requests and invites are refused.
  await fails(409, 'guild_full', owner, 'POST', `/guilds/${guild.id}/requests/${c.id}`, { accept: true }, o);
  await fails(409, 'guild_full', d, 'POST', `/guilds/${guild.id}/join`, undefined, o);
  await fails(409, 'guild_full', owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: d.id }, o);
  assert.equal((await ok(owner, 'GET', `/guilds/${guild.id}`, undefined, o)).members.length, 3);

  // A free slot makes the still-pending request acceptable.
  await ok(a, 'POST', `/guilds/${guild.id}/leave`, undefined, o);
  await ok(owner, 'POST', `/guilds/${guild.id}/requests/${c.id}`, { accept: true }, o);
});

test('limit: the real default member cap is 50', async () => {
  const owner = await newPlayer();
  const guild = await newGuild(owner);
  const gid = (await db.collection('members').findOne({ playerId: owner.id }))._id && (await db.collection('members').findOne({ playerId: owner.id })).guildId;
  // Fill to 50 directly, then go through the API for number 51.
  await db.collection('members').insertMany(
    Array.from({ length: 49 }, (_, i) => ({ guildId: gid, playerId: `filler-${guild.id}-${i}`, rank: 'member', joinedAt: new Date() })),
  );
  const p = await newPlayer();
  await fails(409, 'guild_full', p, 'POST', `/guilds/${guild.id}/join`);
  await fails(409, 'guild_full', owner, 'POST', `/guilds/${guild.id}/invite`, { steamId: p.id });
});

test('rate limits: writes, messages and registration', async () => {
  const fetcher = makeFetch({ rate: { write: [5, 60_000], message: [2, 60_000], register: [3, 3_600_000], sync: [2, 60_000], read: [3, 60_000] } });
  const o = { fetcher };
  const p = await newPlayer();
  const q = await newPlayer();
  const guild = await newGuild(p); // counters live in the database, so this create is write 1 of 5

  await ok(p, 'POST', `/guilds/${guild.id}/messages`, { body: '1' }, o);
  await ok(p, 'POST', `/guilds/${guild.id}/messages`, { body: '2' }, o);
  await fails(429, 'rate_limited', p, 'POST', `/guilds/${guild.id}/messages`, { body: '3' }, o);
  // Other writes still pass until the write budget (5) is used up: 4 used so far.
  await ok(p, 'PATCH', `/guilds/${guild.id}`, { description: 'a' }, o);
  await fails(429, 'rate_limited', p, 'PATCH', `/guilds/${guild.id}`, { description: 'c' }, o);
  // Limits are per player.
  await ok(q, 'POST', `/guilds/${guild.id}/join`, undefined, o);

  await ok(q, 'POST', '/sync', {}, o);
  await ok(q, 'POST', '/sync', {}, o);
  await fails(429, 'rate_limited', q, 'POST', '/sync', {}, o);

  for (let i = 0; i < 3; i++) await ok(q, 'GET', '/me', undefined, o);
  await fails(429, 'rate_limited', q, 'GET', '/me', undefined, o);

  // Registration is limited per IP.
  const ip = { fetcher, headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } };
  for (let i = 0; i < 3; i++) await ok(null, 'POST', '/register', { steamId: newSteamId(), name: 'R', key: newKey() }, ip);
  await fails(429, 'rate_limited', null, 'POST', '/register', { steamId: newSteamId(), name: 'R', key: newKey() }, ip);
  await ok(null, 'POST', '/register', { steamId: newSteamId(), name: 'R', key: newKey() }, { fetcher, headers: { 'x-forwarded-for': '203.0.113.10' } });
});

test('delete my data: refused while owning a guild, then removes everything', async () => {
  const { owner, officer, member, guild } = await trio();
  const other = await newGuild(officer);
  const target = await newPlayer();
  await ok(member, 'POST', `/guilds/${other.id}/join`); // a pending request of mine
  await ok(member, 'POST', `/guilds/${guild.id}/messages`, { body: 'remember me' });
  await ok(owner, 'POST', `/guilds/${guild.id}/messages`, { body: 'stays' });
  await ok(owner, 'POST', `/guilds/${guild.id}/members/${member.id}/rank`, { rank: 'officer' });
  await ok(member, 'POST', `/guilds/${guild.id}/invite`, { steamId: target.id }); // an invite I issued

  await fails(409, 'owns_guild', owner, 'DELETE', '/me');

  assert.deepEqual(await ok(member, 'DELETE', '/me'), { ok: true });
  await fails(401, 'unauthorized', member, 'GET', '/me');
  assert.equal(await db.collection('players').countDocuments({ _id: member.id }), 0);
  for (const col of ['members', 'requests', 'messages']) {
    assert.equal(await db.collection(col).countDocuments({ playerId: member.id }), 0, col);
  }
  assert.equal(await db.collection('requests').countDocuments({ by: member.id }), 0);
  assert.deepEqual(await ranks(owner, guild), { [owner.id]: 'owner', [officer.id]: 'officer' });
  assert.deepEqual((await ok(owner, 'GET', `/guilds/${guild.id}/messages`)).messages.map((m) => m.body), ['stays']);
  assert.deepEqual((await ok(officer, 'GET', `/guilds/${other.id}`)).requests, []);

  // The Steam ID can be registered again, with a new key.
  const again = { id: member.id, key: newKey() };
  await ok(null, 'POST', '/register', { steamId: again.id, name: 'Back', key: again.key });
  assert.deepEqual((await ok(again, 'GET', '/me')).guilds, []);

  // After a transfer the old owner can delete their data too.
  await ok(owner, 'POST', `/guilds/${guild.id}/transfer`, { playerId: officer.id });
  await ok(owner, 'DELETE', '/me');
  assert.deepEqual(await ranks(officer, guild), { [officer.id]: 'owner' });
});

test('indexes exist, including the 14 day message expiry', async () => {
  const idx = async (col) => db.collection(col).indexes();
  const ttl = (await idx('messages')).find((i) => i.expireAfterSeconds !== undefined);
  assert.equal(ttl.expireAfterSeconds, 14 * 24 * 60 * 60);
  assert.deepEqual(ttl.key, { at: 1 });
  assert.ok((await idx('guilds')).some((i) => i.unique && i.key.nameLower === 1));
  assert.ok((await idx('members')).some((i) => i.unique && i.key.guildId === 1 && i.key.playerId === 1));
  assert.ok((await idx('requests')).some((i) => i.unique && i.key.guildId === 1 && i.key.playerId === 1));
});

// ---------- v0.3: current action and player profiles ----------

const ACTION = { entity: 'Melvor:Woodcutting', target: 'Melvor:OakTree', name: 'Oak Tree' };
const statusOf = async (viewer, guild, player) =>
  (await ok(viewer, 'GET', `/guilds/${guild.id}`)).members.find((m) => m.id === player.id).status;

test('sync: status.action is stored, returned to guild mates, and cleared', async () => {
  const { owner, member, guild } = await trio();
  const BEL = String.fromCharCode(7);

  await ok(member, 'POST', '/sync', { status: { skill: 'Woodcutting', level: 42, action: { ...ACTION, name: `  Oak${BEL} Tree\n`, extra: 'dropped' } } });
  const viaSync = (await ok(owner, 'POST', '/sync', {})).guilds[0].members.find((m) => m.id === member.id);
  assert.deepEqual(viaSync.status.action, ACTION);
  assert.equal(viaSync.status.skill, 'Woodcutting');
  assert.deepEqual((await statusOf(owner, guild, member)).action, ACTION);

  // Combat sends an area as well.
  const combat = { entity: 'Melvor:Combat', target: 'Melvor:Cow', area: 'Melvor:Farmlands', name: 'Cow' };
  await ok(member, 'POST', '/sync', { status: { skill: 'Combat', level: 3, action: combat } });
  assert.deepEqual((await statusOf(owner, guild, member)).action, combat);

  // Omitting status keeps it, including the action.
  await ok(member, 'POST', '/sync', {});
  assert.deepEqual((await statusOf(owner, guild, member)).action, combat);

  // A status without action (what a v0.2.0 client sends) clears the action only.
  await ok(member, 'POST', '/sync', { status: { skill: 'Combat', level: 3 } });
  const cleared = await statusOf(owner, guild, member);
  assert.equal('action' in cleared, false);
  assert.equal(cleared.skill, 'Combat');

  // action: null is the same as leaving it out; status: null clears everything.
  await ok(member, 'POST', '/sync', { status: { skill: 'Combat', level: 3, action: ACTION } });
  await ok(member, 'POST', '/sync', { status: { skill: 'Combat', level: 3, action: null } });
  assert.equal('action' in (await statusOf(owner, guild, member)), false);
  await ok(member, 'POST', '/sync', { status: { skill: 'x', level: 1, action: ACTION } });
  await ok(member, 'POST', '/sync', { status: null });
  assert.equal(await statusOf(owner, guild, member), null);

  // Non-members still get no status at all.
  await ok(member, 'POST', '/sync', { status: { skill: 'x', level: 1, action: ACTION } });
  const outside = await ok(await newPlayer(), 'GET', `/guilds/${guild.id}`);
  assert.ok(outside.members.every((m) => !('status' in m)));
});

test('sync: invalid status.action is refused and leaves the stored status alone', async () => {
  const { owner, member, guild } = await trio();
  await ok(member, 'POST', '/sync', { status: { skill: 'Fishing', level: 9, action: ACTION } });
  const long = `Melvor:${'A'.repeat(74)}`; // 81 characters
  const badActions = [
    'Melvor:OakTree',
    [ACTION],
    {},
    { ...ACTION, entity: undefined },
    { ...ACTION, target: 5 },
    { ...ACTION, entity: 'melvor:Woodcutting' },
    { ...ACTION, entity: 'Melvor:oakTree' },
    { ...ACTION, entity: 'Melvor' },
    { ...ACTION, entity: 'Melvor:Oak:Tree' },
    { ...ACTION, entity: 'Melvor:Oak_Tree' },
    { ...ACTION, entity: 'Melvor:Oak Tree' },
    { ...ACTION, target: long },
    { ...ACTION, area: 'not an id' },
    { ...ACTION, area: 7 },
    { ...ACTION, name: '' },
    { ...ACTION, name: undefined },
    { ...ACTION, name: 'x'.repeat(61) },
    { ...ACTION, name: String.fromCharCode(1, 2) },
  ];
  for (const action of badActions) {
    await fails(400, 'invalid_status', member, 'POST', '/sync', { status: { skill: 'Fishing', level: 9, action } });
  }
  const kept = await statusOf(owner, guild, member);
  assert.deepEqual([kept.skill, kept.action], ['Fishing', ACTION]);

  // Boundaries that are allowed.
  const edge = { entity: 'A:B', target: `Melvor:${'A'.repeat(73)}`, name: 'x'.repeat(60) };
  await ok(member, 'POST', '/sync', { status: { skill: '', level: 0, action: edge } });
  assert.deepEqual((await statusOf(owner, guild, member)).action, edge);
});

const SKILLS = [{ id: 'Melvor:Woodcutting', level: 42 }, { id: 'Melvor:Fishing', level: 0 }];
const GEAR = [{ slot: 'Melvor:Weapon', item: 'Melvor:BronzeSword', qty: 1 }, { slot: 'Melvor:Quiver', item: 'Melvor:BronzeArrows', qty: 1_000_000_000 }];

test('profile: upload, replace, and read my own', async () => {
  const p = await newPlayer('Solo');
  const empty = await ok(p, 'GET', `/players/${p.id}/profile`);
  assert.deepEqual([empty.player, empty.profile, empty.status], [{ id: p.id, name: 'Solo' }, null, null]);
  assert.equal(typeof empty.lastSeen, 'number');

  const put = await ok(p, 'PUT', '/me/profile', { skills: SKILLS.map((s) => ({ ...s, junk: 1 })), gear: GEAR });
  assert.equal(put.ok, true);
  assert.equal(typeof put.updatedAt, 'number');
  const got = await ok(p, 'GET', `/players/${p.id}/profile`);
  assert.deepEqual(got.profile, { skills: SKILLS, gear: GEAR, updatedAt: put.updatedAt });

  // PUT replaces the whole profile; missing lists become empty.
  await ok(p, 'PUT', '/me/profile', { skills: [{ id: 'Melvor:Mining', level: 1000 }] });
  const replaced = (await ok(p, 'GET', `/players/${p.id}/profile`)).profile;
  assert.deepEqual([replaced.skills, replaced.gear], [[{ id: 'Melvor:Mining', level: 1000 }], []]);

  // /me is unchanged for old clients: no profile in it.
  assert.equal('profile' in (await ok(p, 'GET', '/me')).player, false);
});

test('profile: validation and limits', async () => {
  const p = await newPlayer();
  await ok(p, 'PUT', '/me/profile', { skills: SKILLS, gear: GEAR });
  const skill = (i) => ({ id: `Melvor:Skill${i}`, level: i });
  const gear = (i) => ({ slot: `Melvor:Slot${i}`, item: 'Melvor:Thing', qty: i });
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const badBodies = [
    { skills: 'all of them' },
    { gear: {} },
    { skills: many(61, skill) },
    { gear: many(41, gear) },
    { skills: [null] },
    { skills: ['Melvor:Woodcutting'] },
    { skills: [{ id: 'woodcutting', level: 1 }] },
    { skills: [{ id: `Melvor:${'A'.repeat(74)}`, level: 1 }] },
    { skills: [{ id: 'Melvor:Woodcutting' }] },
    { skills: [{ id: 'Melvor:Woodcutting', level: -1 }] },
    { skills: [{ id: 'Melvor:Woodcutting', level: 1001 }] },
    { skills: [{ id: 'Melvor:Woodcutting', level: 1.5 }] },
    { skills: [{ id: 'Melvor:Woodcutting', level: '5' }] },
    { skills: [{ id: 'Melvor:Woodcutting', level: 1 }, { id: 'Melvor:Woodcutting', level: 2 }] },
    { gear: [{ slot: 'Melvor:Weapon', item: 'sword', qty: 1 }] },
    { gear: [{ slot: 'weapon', item: 'Melvor:Sword', qty: 1 }] },
    { gear: [{ slot: 'Melvor:Weapon', item: 'Melvor:Sword' }] },
    { gear: [{ slot: 'Melvor:Weapon', item: 'Melvor:Sword', qty: -1 }] },
    { gear: [{ slot: 'Melvor:Weapon', item: 'Melvor:Sword', qty: 1_000_000_001 }] },
    { gear: [{ slot: 'Melvor:Weapon', item: 'Melvor:Sword', qty: 1 }, { slot: 'Melvor:Weapon', item: 'Melvor:Axe', qty: 1 }] },
  ];
  for (const body of badBodies) await fails(400, 'invalid_profile', p, 'PUT', '/me/profile', body);
  // A refused upload leaves the stored profile alone.
  assert.deepEqual((await ok(p, 'GET', `/players/${p.id}/profile`)).profile.skills, SKILLS);

  // The maximum sizes are accepted, and the same item may sit in two slots.
  await ok(p, 'PUT', '/me/profile', { skills: many(60, skill), gear: many(40, gear) });
  const full = (await ok(p, 'GET', `/players/${p.id}/profile`)).profile;
  assert.deepEqual([full.skills.length, full.gear.length], [60, 40]);
  await ok(p, 'PUT', '/me/profile', {});

  await fails(401, 'unauthorized', null, 'PUT', '/me/profile', {});
  await fails(405, 'method_not_allowed', p, 'POST', '/me/profile', {});
});

test('profile: body cap is 16 KB on this route only', async () => {
  const p = await newPlayer();
  const pad = (n) => ({ skills: [], gear: [], pad: 'x'.repeat(n) });
  await ok(p, 'PUT', '/me/profile', pad(15_000)); // over 4 KB, under 16 KB
  const r = await fails(413, 'body_too_large', p, 'PUT', '/me/profile', pad(17_000));
  assert.match(r.error.message, /16384/);
  // Worst-case real payload fits: 60 skills and 40 gear rows with 80-character ids.
  const id = (i) => `Melvor:${'A'.repeat(70)}${String(i).padStart(3, '0')}`;
  const big = {
    skills: Array.from({ length: 60 }, (_, i) => ({ id: id(i), level: 1000 })),
    gear: Array.from({ length: 40 }, (_, i) => ({ slot: id(i), item: id(i), qty: 1_000_000_000 })),
  };
  assert.ok(JSON.stringify(big).length < 16 * 1024);
  await ok(p, 'PUT', '/me/profile', big);
  // Everything else keeps the 4 KB cap.
  await fails(413, 'body_too_large', p, 'POST', '/sync', { pad: 'x'.repeat(5000) });
  await fails(413, 'body_too_large', p, 'PUT', '/me', { pad: 'x'.repeat(5000) });
});

test('profile: visible to myself and guild mates only', async () => {
  const { owner, officer, member, guild } = await trio();
  const stranger = await newPlayer('Stranger');
  await ok(member, 'PUT', '/me/profile', { skills: SKILLS, gear: GEAR });
  await ok(member, 'POST', '/sync', { status: { skill: 'Woodcutting', level: 42, action: ACTION } });
  const path = `/players/${member.id}/profile`;

  for (const viewer of [member, owner, officer]) {
    const v = await ok(viewer, 'GET', path);
    assert.deepEqual(v.player, { id: member.id, name: 'Member' });
    assert.deepEqual([v.profile.skills, v.profile.gear], [SKILLS, GEAR]);
    assert.deepEqual(v.status.action, ACTION);
    assert.ok(Math.abs(v.lastSeen - Date.now()) < 60_000);
    assert.equal(JSON.stringify(v).includes('keyHash'), false);
  }
  // A guild mate with no profile yet reads as null.
  assert.equal((await ok(member, 'GET', `/players/${owner.id}/profile`)).profile, null);

  await fails(403, 'forbidden', stranger, 'GET', path);
  await fails(403, 'forbidden', member, 'GET', `/players/${stranger.id}/profile`);
  await fails(404, 'player_not_found', owner, 'GET', `/players/${newSteamId()}/profile`);
  await fails(400, 'invalid_steam_id', owner, 'GET', '/players/abc/profile');
  await fails(401, 'unauthorized', null, 'GET', path);

  // A pending join request is not membership.
  await ok(stranger, 'POST', `/guilds/${guild.id}/join`);
  await fails(403, 'forbidden', stranger, 'GET', path);
  await ok(owner, 'POST', `/guilds/${guild.id}/requests/${stranger.id}`, { accept: true });
  await ok(stranger, 'GET', path);

  // Leaving or being kicked ends access, in both directions.
  await ok(officer, 'POST', `/guilds/${guild.id}/leave`);
  await fails(403, 'forbidden', officer, 'GET', path);
  await fails(403, 'forbidden', member, 'GET', `/players/${officer.id}/profile`);
  await ok(owner, 'DELETE', `/guilds/${guild.id}/members/${stranger.id}`);
  await fails(403, 'forbidden', stranger, 'GET', path);

  // Sharing any one guild is enough.
  const second = await newGuild(officer);
  await addTo(second, officer, member);
  await ok(officer, 'GET', path);

  // Disbanding the only shared guild ends access too.
  await ok(officer, 'DELETE', `/guilds/${second.id}`);
  await fails(403, 'forbidden', officer, 'GET', path);
});

test('profile: uploads count against the write rate limit', async () => {
  const fetcher = makeFetch({ rate: { write: [2, 60_000], register: [10_000, 3_600_000] } });
  const p = await newPlayer();
  await ok(p, 'PUT', '/me/profile', {}, { fetcher });
  await ok(p, 'PUT', '/me/profile', {}, { fetcher });
  await fails(429, 'rate_limited', p, 'PUT', '/me/profile', {}, { fetcher });
});

test('delete my data also removes the profile and action', async () => {
  const { owner, member } = await trio();
  const gear = [{ slot: 'Melvor:Weapon', item: 'Melvor:UniqueDeleteMarker', qty: 1 }];
  const action = { ...ACTION, target: 'Melvor:UniqueDeleteMarker' };
  await ok(member, 'PUT', '/me/profile', { skills: SKILLS, gear });
  await ok(member, 'POST', '/sync', { status: { skill: 'Woodcutting', level: 42, action } });
  assert.ok((await db.collection('players').findOne({ _id: member.id })).profile);

  await ok(member, 'DELETE', '/me');
  assert.equal(await db.collection('players').countDocuments({ _id: member.id }), 0);
  await fails(404, 'player_not_found', owner, 'GET', `/players/${member.id}/profile`);
  // Nothing of the profile or action is left anywhere in the database.
  for (const { name } of await db.listCollections().toArray()) {
    const docs = await db.collection(name).find({}).toArray();
    assert.equal(JSON.stringify(docs).includes('UniqueDeleteMarker'), false, name);
  }

  // Registering the same Steam ID again starts with nothing.
  const again = { id: member.id, key: newKey() };
  await ok(null, 'POST', '/register', { steamId: again.id, name: 'Back', key: again.key });
  const fresh = await ok(again, 'GET', `/players/${again.id}/profile`);
  assert.deepEqual([fresh.profile, fresh.status], [null, null]);
});

test('tester code: new players need it, known players do not', async () => {
  const closed = makeFetch({ rate: { register: [10_000, 3_600_000] } }, { registerCode: 'Oak-Logs-42, second' });
  const opts = { fetcher: closed };
  const p = { id: newSteamId(), key: newKey() };
  const reg = (extra) => ({ steamId: p.id, name: 'Tester', key: p.key, ...extra });

  await fails(403, 'code_required', null, 'POST', '/register', reg(), opts);
  await fails(403, 'code_required', null, 'POST', '/register', reg({ code: '  ' }), opts);
  await fails(403, 'code_wrong', null, 'POST', '/register', reg({ code: 'oak-logs-43' }), opts);
  await fails(403, 'code_wrong', null, 'POST', '/register', reg({ code: 'Oak-Logs-42, second' }), opts);
  await fails(401, 'unauthorized', p, 'GET', '/me', undefined, opts);

  assert.equal((await call(null, 'POST', '/register', reg({ code: ' OAK-logs-42 ' }), opts)).status, 201);
  // Signing in again later needs no code, and neither does a second code stop working.
  assert.equal((await call(null, 'POST', '/register', reg(), opts)).status, 200);
  const q = { id: newSteamId(), key: newKey() };
  assert.equal((await call(null, 'POST', '/register', { steamId: q.id, name: 'Q', key: q.key, code: 'second' }, opts)).status, 201);
  await ok(p, 'GET', '/me', undefined, opts);
});

test('admin reset: off without a key, needs the key, lets the player set a new one and keeps their guilds', async () => {
  const owner = await newPlayer('Owner');
  const guild = await newGuild(owner);
  await fails(404, 'not_found', null, 'POST', '/admin/reset-player', { steamId: owner.id });

  const admin = makeFetch({ rate: { register: [10_000, 3_600_000] } }, { adminKey: 'admin-secret-for-tests', registerCode: 'code' });
  const opts = (key) => ({ fetcher: admin, headers: key ? { 'x-admin-key': key } : {} });
  await fails(401, 'unauthorized', null, 'POST', '/admin/reset-player', { steamId: owner.id }, opts());
  await fails(401, 'unauthorized', null, 'POST', '/admin/reset-player', { steamId: owner.id }, opts('wrong'));
  await fails(404, 'player_not_found', null, 'POST', '/admin/reset-player', { steamId: newSteamId() }, opts('admin-secret-for-tests'));
  await ok(owner, 'GET', '/me', undefined, { fetcher: admin });

  const done = await ok(null, 'POST', '/admin/reset-player', { steamId: owner.id }, opts('admin-secret-for-tests'));
  assert.equal(done.player.id, owner.id);
  await fails(401, 'unauthorized', owner, 'GET', '/me', undefined, { fetcher: admin });
  await fails(401, 'unauthorized', owner, 'POST', '/sync', {}, { fetcher: admin });

  // The next register sets the new key, with no tester code needed; after that the id is taken again.
  const fresh = { id: owner.id, key: newKey() };
  assert.equal((await call(null, 'POST', '/register', { steamId: fresh.id, name: 'Owner', key: fresh.key }, { fetcher: admin })).status, 200);
  await fails(409, 'steam_id_claimed', null, 'POST', '/register', { steamId: owner.id, name: 'Thief', key: newKey() }, { fetcher: admin });
  await fails(401, 'unauthorized', owner, 'GET', '/me', undefined, { fetcher: admin });
  const me = await ok(fresh, 'GET', '/me', undefined, { fetcher: admin });
  assert.deepEqual(me.guilds.map((g) => [g.id, g.rank]), [[guild.id, 'owner']]);
});

test('an address that keeps sending a wrong key is cut off for a minute', async () => {
  let clock = Date.now();
  const app = createApp({ store, now: () => clock, limits: { rate: { authFail: [3, 60_000], register: [10_000, 3_600_000] } } });
  const limited = createFetchHandler(async () => ({ handle: app.handle, ping: store.ping }));
  const from = (ip) => ({ fetcher: limited, headers: { 'x-forwarded-for': ip } });
  const good = { id: newSteamId(), key: newKey() };
  await ok(null, 'POST', '/register', { steamId: good.id, name: 'Good', key: good.key }, from('10.0.0.2'));
  const bad = { id: good.id, key: newKey() };

  for (let i = 0; i < 3; i++) await fails(401, 'unauthorized', bad, i % 2 ? 'GET' : 'POST', i % 2 ? '/me' : '/sync', i % 2 ? undefined : {}, from('10.0.0.1'));
  await fails(429, 'rate_limited', bad, 'GET', '/me', undefined, from('10.0.0.1'));
  await fails(429, 'rate_limited', good, 'GET', '/me', undefined, from('10.0.0.1')); // the address, not the player
  await ok(good, 'GET', '/me', undefined, from('10.0.0.2'));
  clock += 61_000;
  await ok(good, 'GET', '/me', undefined, from('10.0.0.1'));
});

test('admin ban: locks the player out, removes what others see of them, and can be undone', async () => {
  const fetcher = makeFetch({ rate: { register: [10_000, 3_600_000], authFail: [10_000, 60_000] } }, { adminKey: 'admin-secret-for-tests' });
  const adm = { fetcher, headers: { 'x-admin-key': 'admin-secret-for-tests' } };
  const f = { fetcher };
  const { owner, member, guild } = await trio();
  const own = await newGuild(member); // the troublemaker also owns a guild
  await ok(member, 'POST', `/guilds/${guild.id}/messages`, { body: 'rude words' }, f);
  const { listing } = await ok(member, 'POST', `/guilds/${guild.id}/market`, { item: 'MelvorBase:OakLogs', qty: 5, price: 10, value: 10 }, f);

  await fails(401, 'unauthorized', null, 'POST', '/admin/ban', { steamId: member.id }, f);
  const found = await ok(null, 'POST', '/admin/find-player', { q: 'memb' }, adm);
  assert.ok(found.players.some((p) => p.id === member.id && !p.banned && p.guilds.some((g) => g.id === guild.id)));
  assert.deepEqual((await ok(null, 'POST', '/admin/find-player', { q: member.id }, adm)).players.map((p) => p.id), [member.id]);

  const done = await ok(null, 'POST', '/admin/ban', { steamId: member.id }, adm);
  assert.deepEqual(done.ownedGuilds.map((g) => g.id), [own.id]);
  await fails(403, 'banned', member, 'GET', '/me', undefined, f);
  await fails(403, 'banned', member, 'POST', '/sync', {}, f);
  await fails(403, 'banned', null, 'POST', '/register', { steamId: member.id, name: 'Member', key: member.key }, f);
  await fails(403, 'banned', null, 'POST', '/register', { steamId: member.id, name: 'Member', key: newKey() }, f);

  const view = await ok(owner, 'GET', `/guilds/${guild.id}`, undefined, f);
  assert.ok(!view.members.some((m) => m.id === member.id));
  assert.deepEqual((await ok(owner, 'GET', `/guilds/${guild.id}/messages`, undefined, f)).messages.filter((x) => x.playerId === member.id), []);
  assert.ok(!(await ok(owner, 'GET', `/guilds/${guild.id}/market`, undefined, f)).listings.some((l) => l.id === listing.id));
  assert.equal((await ok(null, 'POST', '/admin/find-player', { q: member.id }, adm)).players[0].banned, true);

  // Their own guild is still there until it is deleted, by name in any capitalisation.
  await fails(404, 'guild_not_found', null, 'POST', '/admin/delete-guild', { name: 'No such guild at all' }, adm);
  const gone = await ok(null, 'POST', '/admin/delete-guild', { name: own.name.toUpperCase() }, adm);
  assert.equal(gone.guild.id, own.id);
  await fails(404, 'guild_not_found', owner, 'GET', `/guilds/${own.id}`, undefined, f);

  await ok(null, 'POST', '/admin/unban', { steamId: member.id }, adm);
  const me = await ok(member, 'GET', '/me', undefined, f);
  assert.deepEqual(me.guilds, []);
  // The items from the closed listing are waiting for them.
  assert.deepEqual((await ok(member, 'POST', '/sync', {}, f)).claims.map((c) => [c.kind, c.qty]), [['return', 5]]);
});

test('player limit: no new players once it is reached; known players and admin count are unaffected', async () => {
  const cfg = { adminKey: 'admin-secret-for-tests', registerCode: 'code' };
  const limits = { rate: { register: [10_000, 3_600_000] } };
  const adm = (fetcher) => ({ fetcher, headers: { 'x-admin-key': 'admin-secret-for-tests' } });
  const open = makeFetch(limits, cfg);
  const before = await ok(null, 'POST', '/admin/stats', {}, adm(open));
  assert.deepEqual([before.maxPlayers, before.registration], [null, 'code']);
  assert.equal((await ok(null, 'POST', '/admin/stats', {}, adm(makeFetch(limits, { adminKey: cfg.adminKey })))).registration, 'open');
  await fails(401, 'unauthorized', null, 'POST', '/admin/stats', {}, { fetcher: open });

  // Room for exactly one more player.
  const capped = makeFetch(limits, { ...cfg, maxPlayers: String(before.players + 1) });
  const a = { id: newSteamId(), key: newKey() };
  const b = { id: newSteamId(), key: newKey() };
  const reg = (p) => ({ steamId: p.id, name: 'Capped', key: p.key, code: 'code' });
  assert.equal((await call(null, 'POST', '/register', reg(a), { fetcher: capped })).status, 201);
  await fails(403, 'server_full', null, 'POST', '/register', reg(b), { fetcher: capped });
  // Without the code they are told about the code, not about the limit.
  await fails(403, 'code_required', null, 'POST', '/register', { ...reg(b), code: undefined }, { fetcher: capped });
  // Players who already joined carry on.
  assert.equal((await call(null, 'POST', '/register', reg(a), { fetcher: capped })).status, 200);
  await ok(a, 'POST', '/sync', {}, { fetcher: capped });

  const full = await ok(null, 'POST', '/admin/stats', {}, adm(capped));
  assert.deepEqual([full.players, full.maxPlayers, full.registration], [before.players + 1, before.players + 1, 'full']);
  assert.ok(full.online >= 1 && full.day >= full.online && full.week >= full.day);

  // A banned player frees their place.
  await ok(null, 'POST', '/admin/ban', { steamId: a.id }, adm(capped));
  assert.equal((await ok(null, 'POST', '/admin/stats', {}, adm(capped))).registration, 'code');
  assert.equal((await call(null, 'POST', '/register', reg(b), { fetcher: capped })).status, 201);
  // A value that is not a whole number means no limit.
  assert.equal((await ok(null, 'POST', '/admin/stats', {}, adm(makeFetch(limits, { ...cfg, maxPlayers: 'lots' })))).maxPlayers, null);
});

test('tester chat: opt in to read and write, opt out to stop, and guild chat stays separate', async () => {
  const [ann, bob, cat] = [await newPlayer('Ann'), await newPlayer('Bob'), await newPlayer('Cat')];
  const sync = (p, body = {}) => ok(p, 'POST', '/sync', body);
  const heard = (s) => s.messages.filter((m) => m.guildId === 'testers').map((m) => `${m.name}: ${m.body}`);

  // Off by default: no messages, and posting is refused.
  assert.equal((await sync(ann)).testers, false);
  assert.equal((await ok(ann, 'GET', '/me')).testers, false);
  await fails(403, 'not_tester', ann, 'POST', '/testers/messages', { body: 'hello?' });
  await fails(400, 'invalid_body', ann, 'POST', '/testers', { on: 'yes' });
  await fails(401, 'unauthorized', null, 'POST', '/testers', { on: true });

  assert.deepEqual(await ok(ann, 'POST', '/testers', { on: true }), { testers: true });
  assert.deepEqual(await ok(bob, 'POST', '/testers', { on: true }), { testers: true });
  assert.equal((await ok(ann, 'GET', '/me')).testers, true);
  const sent = await ok(ann, 'POST', '/testers/messages', { body: '  the Donate button is too big  ' });
  assert.deepEqual([sent.message.guildId, sent.message.name, sent.message.body], ['testers', 'Ann', 'the Donate button is too big']);
  await fails(400, 'invalid_message', ann, 'POST', '/testers/messages', { body: '   ' });

  // Bob (opted in) hears it, also on a later sync with a cursor; Cat (not opted in) does not.
  const first = await sync(bob);
  assert.equal(first.testers, true);
  assert.ok(heard(first).includes('Ann: the Donate button is too big'));
  await ok(bob, 'POST', '/testers/messages', { body: 'agreed' });
  assert.deepEqual(heard(await sync(ann, { since: (await sync(ann)).cursor })), []);
  await ok(bob, 'POST', '/testers/messages', { body: 'one more' });
  assert.ok(heard(await sync(ann)).includes('Bob: one more'));
  assert.deepEqual(heard(await sync(cat)), []);

  // Guild chat is not mixed in.
  const { guild } = await ok(ann, 'POST', '/guilds', { name: uniq('Testers'), description: '' });
  await ok(ann, 'POST', `/guilds/${guild.id}/messages`, { body: 'guild only' });
  assert.ok(!heard(await sync(bob)).some((m) => m.includes('guild only')));
  assert.ok((await sync(ann)).messages.some((m) => m.guildId === guild.id && m.body === 'guild only'));

  // Opting out stops both directions; the messages already sent stay for the others.
  assert.deepEqual(await ok(bob, 'POST', '/testers', { on: false }), { testers: false });
  assert.deepEqual(heard(await sync(bob)), []);
  await fails(403, 'not_tester', bob, 'POST', '/testers/messages', { body: 'still here?' });
  assert.ok(heard(await sync(ann)).includes('Bob: agreed'));

  // Deleting your data removes your tester messages too.
  await ok(bob, 'DELETE', '/me');
  assert.ok(!heard(await sync(ann)).some((m) => m.startsWith('Bob:')));
});
