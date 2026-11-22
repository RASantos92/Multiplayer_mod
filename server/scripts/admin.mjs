// Admin tool for the person running the guild server.
//
//   node scripts/admin.mjs reset <steamId>
//
// reset: for a player who lost their key file (new PC, reinstalled Windows) and now gets "already enabled
//        guilds on another PC". It forgets their old key; the next time they click Enable Guilds their game
//        sets a new one. Their guilds and anything waiting on the marketplace are kept.
//        Only do this for someone you are sure owns that Steam account: whoever enables guilds with that
//        Steam ID next gets the account.
//
// The admin key is the ADMIN_KEY value you set in Vercel. It is read from the MELVOR2_ADMIN_KEY environment
// variable, or asked for if that is not set. It is never written anywhere.
//
// Options: --url <base url> (default https://melvor2-guilds.vercel.app)

import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const urlAt = args.indexOf('--url');
const base = (urlAt >= 0 ? args.splice(urlAt, 2)[1] : 'https://melvor2-guilds.vercel.app').replace(/\/$/, '');
const [command, steamId] = args;

if (command !== 'reset' || !/^\d{17}$/.test(steamId ?? '')) {
  console.error('Usage: node scripts/admin.mjs reset <17-digit Steam ID>');
  process.exit(1);
}

let key = process.env.MELVOR2_ADMIN_KEY;
if (!key) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  key = (await rl.question('Admin key: ')).trim();
  rl.close();
}

const res = await fetch(`${base}/admin/reset-player`, {
  method: 'POST',
  headers: { 'X-Mod-Protocol': '1', 'X-Admin-Key': key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ steamId }),
});
const body = await res.json().catch(() => ({}));
if (res.ok) {
  console.log(`Reset "${body.player.name}" (${body.player.id}). They can click Enable Guilds again now.`);
} else if (res.status === 404 && body.error?.code === 'not_found') {
  console.error('The server has no ADMIN_KEY set. Add it in Vercel (see server/README.md) and deploy again.');
  process.exit(1);
} else {
  console.error(`Failed (${res.status}): ${body.error?.message ?? 'unknown error'}`);
  process.exit(1);
}
