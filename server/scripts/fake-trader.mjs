// A throwaway guild member for testing the marketplace without a second person. It registers a fake
// player and asks to join the named guild (accept it in game on the Owner tab). It has no bank, so it only
// pretends, but it uses the real endpoints, so your side of every trade is real.
//
// What it does, a few seconds after you list something:
//   1. buys 1 of it at your price (you get the gold)
//   2. offers the lowest allowed price for 1 more (accept or decline it in the Marketplace tab)
//   3. lists 5 of the same item at the same price, so you have something to buy and haggle over
// It accepts any offer you make on its listings.
//
//   node scripts/fake-trader.mjs "<guild name>"      run for --minutes <n> (default 30), then clean up
//   node scripts/fake-trader.mjs --stop              make a running or crashed one clean up and delete itself
//
// Options: --url <base url> (default https://melvor2-guilds.vercel.app). Ctrl+C also cleans up.

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
const minutes = Number(take('--minutes', '30'));
const stateFile = join(tmpdir(), 'melvor2-fake-trader.json');
const isFake = (id) => id.startsWith('7656120');

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

/** Claims are what the real mod applies to the bank; the trader has no bank, so it just says "done". */
async function settleClaims() {
  const sync = await call('POST', '/sync', {});
  for (const c of sync.json.claims ?? []) {
    await call('POST', `/claims/${c.id}/confirm`, {});
    if (c.kind === 'payout') console.log(`  was paid ${c.gold} gold for ${c.qty} ${c.item} by ${c.other}`);
    if (c.kind === 'purchase') console.log(`  received ${c.qty} ${c.item} for ${c.gold} gold`);
  }
  return sync;
}

async function cleanup(reason) {
  if (!auth) return;
  console.log(`\nCleaning up (${reason})...`);
  const me = await call('GET', '/me');
  for (const g of me.json.guilds ?? []) {
    const market = await call('GET', `/guilds/${g.id}/market`);
    for (const l of market.json.listings ?? []) if (l.sellerId === auth.steamId) await call('DELETE', `/guilds/${g.id}/market/${l.id}`);
    await call('POST', `/guilds/${g.id}/leave`, {});
  }
  for (const r of me.json.requests ?? []) await call('DELETE', `/guilds/${r.guildId}/join`);
  await settleClaims(); // returned items must be collected before the record can be deleted
  const del = await call('DELETE', '/me');
  console.log(del.ok ? 'Fake trader deleted.' : `Could not delete fake trader: ${JSON.stringify(del.json)}`);
  await rm(stateFile, { force: true });
  auth = null;
}

if (args[0] === '--stop') {
  try {
    auth = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    console.log('No fake trader on record.');
    process.exit(0);
  }
  await cleanup('--stop');
  process.exit(0);
}

const [guildName] = args;
if (!guildName) {
  console.error('Usage: node scripts/fake-trader.mjs "<guild name>"   |   --stop');
  process.exit(1);
}

auth = { steamId: '7656120' + String(randomInt(1_000_000_000, 2_000_000_000)), key: randomBytes(36).toString('base64') };
await writeFile(stateFile, JSON.stringify(auth));
const reg = await call('POST', '/register', { steamId: auth.steamId, name: 'Test Trader', key: auth.key });
if (!reg.ok) { console.error('Register failed:', reg.json); process.exit(1); }
process.on('SIGINT', async () => { await cleanup('Ctrl+C'); process.exit(0); });

const found = await call('GET', '/guilds/search?q=' + encodeURIComponent(guildName));
const guild = (found.json.guilds ?? []).find((g) => g.name.toLowerCase() === guildName.toLowerCase());
if (!guild) { console.error(`No guild named "${guildName}".`); await cleanup('guild not found'); process.exit(1); }
const joined = await call('POST', `/guilds/${guild.id}/join`, {});
if (!joined.ok) { console.error('Join request failed:', joined.json); await cleanup('join failed'); process.exit(1); }
console.log(`"Test Trader" asked to join "${guild.name}". Accept it in game: Guild window > Owner tab > Join requests.`);

const m = `/guilds/${guild.id}/market`;
const bought = new Set();
const offered = new Set();
const copied = new Set();
const deadline = Date.now() + minutes * 60_000;
let member = false;

while (Date.now() < deadline) {
  const sync = await settleClaims();
  const mine = (sync.json.guilds ?? []).find((g) => g.id === guild.id);
  if (mine && !member) {
    member = true;
    console.log('Accepted into the guild. List something in the Marketplace tab and watch.');
  }

  if (mine) {
    const market = await call('GET', m);
    const minPercent = market.json.rules?.minPercent ?? 80;
    for (const l of market.json.listings ?? []) {
      if (isFake(l.sellerId)) continue;
      const floor = Math.max(1, Math.ceil((l.value * minPercent) / 100));
      if (!bought.has(l.id)) {
        bought.add(l.id);
        const r = await call('POST', `${m}/${l.id}/buy`, { qty: 1, price: l.price });
        console.log(r.ok ? `Bought 1 ${l.item} from ${l.sellerName} for ${l.price} gold.` : `Buy refused: ${JSON.stringify(r.json)}`);
      } else if (!offered.has(l.id) && floor < l.price) {
        offered.add(l.id);
        const r = await call('POST', `${m}/${l.id}/offers`, { qty: 1, price: floor });
        console.log(r.ok ? `Offered ${floor} gold for 1 ${l.item} (asking ${l.price}).` : `Offer refused: ${JSON.stringify(r.json)}`);
      }
      if (!copied.has(l.item)) {
        copied.add(l.item);
        const r = await call('POST', m, { item: l.item, qty: 5, price: l.price, value: l.value });
        console.log(r.ok ? `Listed 5 ${l.item} at ${l.price} gold each.` : `Listing refused: ${JSON.stringify(r.json)}`);
      }
    }
    for (const o of market.json.offers ?? []) {
      if (o.sellerId !== auth.steamId) continue;
      const r = await call('POST', `/guilds/${guild.id}/offers/${o.id}`, { accept: true });
      console.log(r.ok ? `Accepted ${o.buyerName}'s offer: ${o.qty} ${o.item} at ${o.price} each.` : `Could not accept: ${JSON.stringify(r.json)}`);
    }
  }
  await new Promise((r) => setTimeout(r, 4000));
}

await cleanup(`${minutes} minutes elapsed`);
