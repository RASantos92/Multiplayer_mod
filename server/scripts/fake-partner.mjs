// A throwaway guild member for testing profiles, the Join button and the party XP bonus without a second
// person. It registers a fake player, asks to join the named guild (accept it in game on the Owner tab),
// uploads a sample profile, then reports an action every few seconds.
//
//   node scripts/fake-partner.mjs "<guild name>"                 mirror: copies whatever another member is doing
//   node scripts/fake-partner.mjs "<guild name>" <entity> <target> [display name]
//                                                               fixed action, e.g. MelvorBase:Fishing MelvorBase:RapidRuns
//   node scripts/fake-partner.mjs --stop                         make a running or crashed one leave and delete itself
//
// Options: --url <base url> (default https://melvor2-guilds.vercel.app), --minutes <n> (default 20, then it cleans up).
// Ctrl+C also cleans up. Credentials for --stop are kept in the OS temp folder, never in the repo.

import { randomBytes, randomInt } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const take = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const base = take('--url', 'https://melvor2-guilds.vercel.app').replace(/\/$/, '');
const minutes = Number(take('--minutes', '20'));
const stateFile = join(tmpdir(), 'melvor2-fake-partner.json');

let auth = null;

async function call(method, path, body) {
  const headers = { 'X-Mod-Protocol': '1' };
  if (auth) headers.Authorization = `Bearer ${auth.steamId}:${auth.key}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {};
  try { json = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, json };
}

async function cleanup(reason) {
  if (!auth) return;
  console.log(`\nCleaning up (${reason})...`);
  const me = await call('GET', '/me');
  for (const g of me.json.guilds ?? []) await call('POST', `/guilds/${g.id}/leave`, {});
  for (const r of me.json.requests ?? []) await call('DELETE', `/guilds/${r.guildId}/join`);
  const del = await call('DELETE', '/me');
  console.log(del.ok ? 'Fake player deleted.' : `Could not delete fake player: ${JSON.stringify(del.json)}`);
  await rm(stateFile, { force: true });
  auth = null;
}

if (args[0] === '--stop') {
  try {
    auth = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    console.log('No fake partner on record.');
    process.exit(0);
  }
  await cleanup('--stop');
  process.exit(0);
}

const [guildName, fixedEntity, fixedTarget, fixedName] = args;
if (!guildName) {
  console.error('Usage: node scripts/fake-partner.mjs "<guild name>" [entity target [name]]   |   --stop');
  process.exit(1);
}

// A Steam-ID-shaped number in a range real accounts do not use, and a random key.
auth = { steamId: '7656120' + String(randomInt(1_000_000_000, 9_999_999_999)), key: randomBytes(36).toString('base64') };
await writeFile(stateFile, JSON.stringify(auth));

const reg = await call('POST', '/register', { steamId: auth.steamId, name: 'Test Partner', key: auth.key });
if (!reg.ok) { console.error('Register failed:', reg.json); process.exit(1); }

process.on('SIGINT', async () => { await cleanup('Ctrl+C'); process.exit(0); });

const found = await call('GET', '/guilds/search?q=' + encodeURIComponent(guildName));
const guild = (found.json.guilds ?? []).find((g) => g.name.toLowerCase() === guildName.toLowerCase());
if (!guild) { console.error(`No guild named "${guildName}".`); await cleanup('guild not found'); process.exit(1); }

const joined = await call('POST', `/guilds/${guild.id}/join`, {});
if (!joined.ok) { console.error('Join request failed:', joined.json); await cleanup('join failed'); process.exit(1); }
console.log(`"Test Partner" asked to join "${guild.name}". Accept it in game: Guild window > Owner tab > Join requests.`);

const profile = {
  skills: [
    ['Woodcutting', 52], ['Mining', 48], ['Fishing', 75], ['Cooking', 40], ['Firemaking', 33], ['Smithing', 29],
    ['Attack', 30], ['Strength', 28], ['Defence', 31], ['Hitpoints', 35], ['Ranged', 12], ['Magic', 9],
  ].map(([name, level]) => ({ id: `MelvorBase:${name}`, level })),
  gear: [
    ['Helmet', 'LeatherCowl', 1], ['Weapon', 'OakBow', 1], ['Ammo', 'CopperArrows', 250],
    ['Torso', 'LeatherBody', 1], ['Legs', 'LeatherChaps', 1], ['Boots', 'LeatherBoots', 1],
  ].map(([slot, item, qty]) => ({ slot: `MelvorBase:${slot}`, item: `MelvorBase:${item}`, qty })),
};

const deadline = Date.now() + minutes * 60_000;
let member = false;
let lastShown = '';
let cursor;

while (Date.now() < deadline) {
  let action = fixedEntity && fixedTarget
    ? { entity: fixedEntity, target: fixedTarget, name: fixedName ?? `${fixedEntity.split(':')[1]}: ${fixedTarget.split(':')[1]}` }
    : null;

  // First sync without an action to see what the others are doing (mirror mode), then report.
  const peek = await call('POST', '/sync', { since: cursor });
  if (peek.ok) cursor = peek.json.cursor ?? cursor;
  const mine = (peek.json.guilds ?? []).find((g) => g.id === guild.id);

  if (mine && !member) {
    member = true;
    const put = await call('PUT', '/me/profile', profile);
    console.log(put.ok ? 'Accepted into the guild. Sample profile uploaded.' : `Profile upload failed: ${JSON.stringify(put.json)}`);
  }

  if (mine && !action) {
    const other = mine.members.find((m) => m.id !== auth.steamId && m.status?.action && peek.json.now - m.lastSeen < 60_000);
    if (other) action = other.status.action;
  }

  if (mine) {
    const status = action ? { skill: action.entity.split(':')[1], level: 75, action } : null;
    const sent = await call('POST', '/sync', { since: cursor, status });
    if (sent.ok) cursor = sent.json.cursor ?? cursor;
    const shown = action ? `${action.entity} | ${action.target}` : '(idle: nobody to mirror)';
    if (shown !== lastShown) { console.log(`Reporting: ${shown}`); lastShown = shown; }
    if (!sent.ok) console.log('Sync refused:', JSON.stringify(sent.json));
  }

  await new Promise((r) => setTimeout(r, 5000));
}

await cleanup(`${minutes} minutes elapsed`);
