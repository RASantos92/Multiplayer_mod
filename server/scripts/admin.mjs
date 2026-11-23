// Admin tool for the person running the guild server.
//
//   node scripts/admin.mjs count                              how many players there are, and if new ones can join
//   node scripts/admin.mjs find <part of a name | Steam ID>   look a player up: Steam ID, guilds, banned or not
//   node scripts/admin.mjs ban <steamId>                      lock a player out (see below)
//   node scripts/admin.mjs unban <steamId>
//   node scripts/admin.mjs delete-guild "<guild name>"        remove a guild, whoever owns it
//   node scripts/admin.mjs reset <steamId>                    let a player who lost their key file back in
//
// ban:    the player can no longer use guilds with that Steam account. They are removed from the guilds they
//         are in, and their chat messages, marketplace listings, offers, requests and invites are removed.
//         Guilds they OWN are left alone and listed, so you can delete-guild the ones that should go.
//         Items they had listed wait for them and come back if you unban them.
//         A ban is by Steam ID: it does not stop the same person using a different Steam account.
// delete-guild: the same as the owner disbanding it. Listed items go back to their sellers. Cannot be undone.
// reset:  for "This Steam account already enabled guilds on another PC". Forgets the old key; the next time
//         they click Enable Guilds their game sets a new one. Guilds and marketplace items are kept.
//         Only do this for someone you are sure owns that Steam account: whoever enables guilds with that
//         Steam ID next gets the account.
//
// The admin key is the ADMIN_KEY value you set in Vercel. It is read from the MELVOR2_ADMIN_KEY environment
// variable, or asked for if that is not set. It is never written anywhere.
//
// Options: --url <base url> (default https://melvor2-guilds.vercel.app)

import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const urlAt = args.indexOf('--url');
const base = (urlAt >= 0 ? args.splice(urlAt, 2)[1] : 'https://melvor2-guilds.vercel.app').replace(/\/$/, '');
const [command, ...rest] = args;
const value = rest.join(' ').trim();
const isSteamId = /^\d{17}$/.test(value);

const commands = {
  count: { path: 'stats', body: {}, ok: true },
  find: { path: 'find-player', body: { q: value }, ok: value.length >= 2 },
  ban: { path: 'ban', body: { steamId: value }, ok: isSteamId },
  unban: { path: 'unban', body: { steamId: value }, ok: isSteamId },
  reset: { path: 'reset-player', body: { steamId: value }, ok: isSteamId },
  'delete-guild': { path: 'delete-guild', body: { name: value }, ok: value.length >= 3 },
};
const chosen = commands[command];
if (!chosen?.ok) {
  console.error([
    'Usage:',
    '  node scripts/admin.mjs count',
    '  node scripts/admin.mjs find <part of a name | Steam ID>',
    '  node scripts/admin.mjs ban <17-digit Steam ID>',
    '  node scripts/admin.mjs unban <17-digit Steam ID>',
    '  node scripts/admin.mjs delete-guild "<guild name>"',
    '  node scripts/admin.mjs reset <17-digit Steam ID>',
  ].join('\n'));
  process.exit(1);
}

let key = process.env.MELVOR2_ADMIN_KEY;
if (!key) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  key = (await rl.question('Admin key: ')).trim();
  rl.close();
}

const res = await fetch(`${base}/admin/${chosen.path}`, {
  method: 'POST',
  headers: { 'X-Mod-Protocol': '1', 'X-Admin-Key': key, 'Content-Type': 'application/json' },
  body: JSON.stringify(chosen.body),
});
const body = await res.json().catch(() => ({}));

if (!res.ok) {
  if (res.status === 404 && body.error?.code === 'not_found') {
    console.error('The server has no ADMIN_KEY set. Add it in Vercel (see server/README.md) and deploy again.');
  } else {
    console.error(`Failed (${res.status}): ${body.error?.message ?? 'unknown error'}`);
  }
  process.exit(1);
}

const who = body.player ? `"${body.player.name}" (${body.player.id})` : '';
switch (command) {
  case 'count': {
    const cap = body.maxPlayers ? ` of ${body.maxPlayers}` : '';
    console.log(`Players: ${body.players}${cap}${body.banned ? ` (plus ${body.banned} banned)` : ''}, in ${body.guilds} guilds`);
    console.log(`Online in the last 5 minutes: ${body.online}.  Played in the last day: ${body.day}.  In the last week: ${body.week}.`);
    if (body.testers !== undefined) console.log(`In the tester chat: ${body.testers}.`);
    console.log({
      full: 'New players: CLOSED. The player limit (MAX_PLAYERS) is reached.',
      code: body.maxPlayers
        ? `New players: need the tester code, until ${body.maxPlayers} have joined.`
        : 'New players: need the tester code. There is no player limit (MAX_PLAYERS is not set).',
      open: 'New players: ANYONE can join. No tester code (REGISTER_CODE) is set.',
    }[body.registration]);
    break;
  }
  case 'find':
    if (!body.players.length) console.log('No players found.');
    for (const p of body.players) {
      const seen = p.lastSeen ? new Date(p.lastSeen).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never';
      console.log(`${p.id}  ${p.name}${p.banned ? '  [BANNED]' : ''}  last seen ${seen}`);
      for (const g of p.guilds) console.log(`    ${g.rank.padEnd(7)} ${g.name}`);
    }
    break;
  case 'ban':
    console.log(`Banned ${who}.`);
    if (body.ownedGuilds.length) {
      console.log('They still own these guilds. Delete the ones that should go:');
      for (const g of body.ownedGuilds) console.log(`    node scripts/admin.mjs delete-guild "${g.name}"`);
    }
    break;
  case 'unban':
    console.log(`Unbanned ${who}. They are no longer in any guild they did not own.`);
    break;
  case 'reset':
    console.log(`Reset ${who}. They can click Enable Guilds again now.`);
    break;
  case 'delete-guild':
    console.log(`Deleted guild "${body.guild.name}" (owner ${body.guild.ownerId}).`);
    break;
}
