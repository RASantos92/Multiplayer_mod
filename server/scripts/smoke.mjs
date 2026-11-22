#!/usr/bin/env node
// End-to-end check against a deployed guild API.
//
//   node scripts/smoke.mjs https://your-project.vercel.app
//
// Registers two throwaway players (Steam IDs in a range Steam has not issued),
// walks through the guild flow, and deletes everything it created, also when a
// step fails.
import { randomBytes, randomInt } from 'node:crypto';

const base = (process.argv[2] || process.env.GUILD_API_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/smoke.mjs <base url>   (or set GUILD_API_URL)');
  process.exit(2);
}

const mkPlayer = (name) => ({
  id: `765612021${String(randomInt(0, 100_000_000)).padStart(8, '0')}`,
  key: randomBytes(24).toString('hex'),
  name,
  registered: false,
});
const alice = mkPlayer('Smoke Alice');
const bob = mkPlayer('Smoke Bob');
let guildId = null;
let step = 0;

async function call(player, method, path, body, headers = { 'X-Mod-Protocol': '1' }) {
  const h = { ...headers };
  if (player) h.Authorization = `Bearer ${player.id}:${player.key}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

async function expect(label, want, player, method, path, body, headers) {
  const r = await call(player, method, path, body, headers);
  const wanted = Array.isArray(want) ? want : [want];
  const good = wanted.includes(r.status);
  console.log(`${good ? 'ok  ' : 'FAIL'} ${String(++step).padStart(2)}. ${label}  [${method} ${path} -> ${r.status}]`);
  if (!good) throw new Error(`${label}: expected ${wanted.join('/')}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

function check(label, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${String(++step).padStart(2)}. ${label}`);
  if (!cond) throw new Error(`check failed: ${label}`);
}

async function run() {
  const health = await expect('health + database reachable', 200, null, 'GET', '/health?db=1', undefined, {});
  check('health reports db: true', health.db === true);
  await expect('missing protocol header is refused', 426, null, 'GET', '/me', undefined, {});

  await expect('register Alice', 201, null, 'POST', '/register', { steamId: alice.id, name: alice.name, key: alice.key, code: process.env.MELVOR2_TESTER_CODE });
  alice.registered = true;
  await expect('register Bob', 201, null, 'POST', '/register', { steamId: bob.id, name: bob.name, key: bob.key, code: process.env.MELVOR2_TESTER_CODE });
  bob.registered = true;
  await expect('register Alice again with the same key', 200, null, 'POST', '/register', { steamId: alice.id, name: alice.name, key: alice.key, code: process.env.MELVOR2_TESTER_CODE });
  await expect('register Alice with another key is refused', 409, null, 'POST', '/register', { steamId: alice.id, name: 'Mallory', key: randomBytes(24).toString('hex') });
  await expect('wrong key is refused', 401, { id: alice.id, key: randomBytes(24).toString('hex') }, 'GET', '/me');

  const name = `Smoke ${randomBytes(4).toString('hex')}`;
  const created = await expect('Alice creates a guild', 201, alice, 'POST', '/guilds', { name, description: 'smoke test, safe to delete' });
  guildId = created.guild.id;
  await expect('duplicate name is refused', 409, bob, 'POST', '/guilds', { name: name.toUpperCase() });
  const found = await expect('search finds it', 200, bob, 'GET', `/guilds/search?q=${encodeURIComponent(name.toLowerCase())}`);
  check('search result contains the guild', found.guilds.some((g) => g.id === guildId));

  await expect('Bob asks to join', 201, bob, 'POST', `/guilds/${guildId}/join`);
  const pending = await expect('Alice sees the request', 200, alice, 'GET', `/guilds/${guildId}`);
  check('request is listed', pending.requests.some((r) => r.playerId === bob.id));
  await expect('Alice accepts', 200, alice, 'POST', `/guilds/${guildId}/requests/${bob.id}`, { accept: true });

  const s0 = await expect('Bob syncs (no cursor)', 200, bob, 'POST', '/sync', { status: { skill: 'Smoke testing', level: 1 } });
  check('Bob is in the guild as member', s0.guilds.some((g) => g.id === guildId && g.rank === 'member'));
  await expect('Alice posts a message', 201, alice, 'POST', `/guilds/${guildId}/messages`, { body: 'hello from the smoke test' });
  const s1 = await expect('Bob syncs with the cursor', 200, bob, 'POST', '/sync', { since: s0.cursor });
  check('Bob received exactly the new message', s1.messages.length === 1 && s1.messages[0].body === 'hello from the smoke test');
  const s2 = await expect('Bob syncs again', 200, bob, 'POST', '/sync', { since: s1.cursor });
  check('nothing is delivered twice', s2.messages.length === 0);
  const view = await expect('Alice views the guild', 200, alice, 'GET', `/guilds/${guildId}`);
  check('Bob\'s presence is visible', view.members.some((m) => m.id === bob.id && m.status?.skill === 'Smoke testing'));

  // Current action (mod v0.3)
  const action = { entity: 'Melvor:Woodcutting', target: 'Melvor:OakTree', name: 'Oak Tree' };
  await expect('Bob syncs with an action', 200, bob, 'POST', '/sync', { since: s2.cursor, status: { skill: 'Woodcutting', level: 7, action } });
  const s3 = await expect('Alice syncs', 200, alice, 'POST', '/sync', {});
  const bobSeen = s3.guilds.find((g) => g.id === guildId)?.members.find((m) => m.id === bob.id);
  check('Alice sees Bob\'s action', bobSeen?.status?.action?.target === 'Melvor:OakTree' && bobSeen.status.action.name === 'Oak Tree');
  await expect('a malformed action is refused', 400, bob, 'POST', '/sync', { status: { skill: 'x', level: 1, action: { ...action, entity: 'not an id' } } });
  await expect('Bob syncs a status without action', 200, bob, 'POST', '/sync', { status: { skill: 'Woodcutting', level: 7 } });
  const view2 = await expect('Alice views the guild again', 200, alice, 'GET', `/guilds/${guildId}`);
  check('the action is cleared', view2.members.some((m) => m.id === bob.id && m.status && !('action' in m.status)));

  // Profiles (mod v0.3)
  const profile = {
    skills: [{ id: 'Melvor:Woodcutting', level: 7 }, { id: 'Melvor:Fishing', level: 3 }],
    gear: [{ slot: 'Melvor:Weapon', item: 'Melvor:BronzeSword', qty: 1 }],
  };
  await expect('Bob uploads his profile', 200, bob, 'PUT', '/me/profile', profile);
  await expect('a profile with a duplicate skill is refused', 400, bob, 'PUT', '/me/profile', { skills: [profile.skills[0], profile.skills[0]] });
  await expect('a profile upload over 4 KB is accepted', 200, bob, 'PUT', '/me/profile', { ...profile, pad: 'x'.repeat(6000) });
  const own = await expect('Bob reads his own profile', 200, bob, 'GET', `/players/${bob.id}/profile`);
  check('own profile matches', JSON.stringify([own.profile.skills, own.profile.gear]) === JSON.stringify([profile.skills, profile.gear]));
  const mate = await expect('Alice reads Bob\'s profile as a guild mate', 200, alice, 'GET', `/players/${bob.id}/profile`);
  check('guild mate sees the gear', mate.profile.gear[0].item === 'Melvor:BronzeSword' && mate.player.name === bob.name);

  await expect('member cannot change settings', 403, bob, 'PATCH', `/guilds/${guildId}`, { description: 'nope' });
  await expect('Alice promotes Bob', 200, alice, 'POST', `/guilds/${guildId}/members/${bob.id}/rank`, { rank: 'officer' });
  await expect('officer cannot kick the owner', 403, bob, 'DELETE', `/guilds/${guildId}/members/${alice.id}`);
  await expect('Bob leaves', 200, bob, 'POST', `/guilds/${guildId}/leave`);
  await expect('Alice can no longer read Bob\'s profile', 403, alice, 'GET', `/players/${bob.id}/profile`);

  await expect('Alice invites Bob', 201, alice, 'POST', `/guilds/${guildId}/invite`, { steamId: bob.id });
  const me = await expect('Bob sees the invite', 200, bob, 'GET', '/me');
  check('invite is listed', me.invites.some((i) => i.guildId === guildId));
  await expect('Bob accepts the invite', 200, bob, 'POST', `/invites/${guildId}`, { accept: true });

  await expect('Alice transfers ownership to Bob', 200, alice, 'POST', `/guilds/${guildId}/transfer`, { playerId: bob.id });
  await expect('owner cannot leave', 409, bob, 'POST', `/guilds/${guildId}/leave`);
  await expect('owner cannot delete their data', 409, bob, 'DELETE', '/me');
  await expect('Bob kicks Alice', 200, bob, 'DELETE', `/guilds/${guildId}/members/${alice.id}`);
  await expect('Bob disbands the guild', 200, bob, 'DELETE', `/guilds/${guildId}`);
  guildId = null;
  await expect('guild is gone', 404, alice, 'GET', `/guilds/${created.guild.id}`);
}

async function cleanup() {
  const quiet = async (player, method, path) => {
    try {
      return (await call(player, method, path)).status;
    } catch {
      return 0;
    }
  };
  if (guildId) {
    // Whoever owns it at this point can disband it.
    for (const p of [alice, bob]) if (p.registered) await quiet(p, 'DELETE', `/guilds/${guildId}`);
  }
  for (const p of [alice, bob]) {
    if (!p.registered) continue;
    const status = await quiet(p, 'DELETE', '/me');
    console.log(`${status === 200 ? 'ok  ' : 'FAIL'} cleanup: delete ${p.name} -> ${status}`);
    if (status !== 200) process.exitCode = 1;
  }
}

try {
  await run();
  console.log('\nAll steps passed.');
} catch (e) {
  console.error(`\nSmoke test failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
