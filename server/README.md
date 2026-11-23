# Guild API

A small HTTPS API that stores guilds for the Melvor Idle 2 multiplayer mod. It runs as one Vercel function in front of a MongoDB Atlas cluster.

- Node 24, plain ESM JavaScript, the official `mongodb` driver.
- `api/index.js` is the only function; `vercel.json` rewrites every path to it.
- `src/app.js` holds the router, validation and permission rules; `src/store.js` is the only file that talks to MongoDB; `src/http.js` turns a web `Request` into a call to the app.

## Deploy

You need a MongoDB Atlas cluster and its connection string (`mongodb+srv://...`). The connection string goes into Vercel's settings only. Never put it in a file in this repo.

1. Create a free account at <https://vercel.com/signup> (Hobby plan).
2. In a terminal, from this `server/` folder:

   ```powershell
   npx vercel login
   ```

   ```powershell
   npx vercel link
   ```

   Answer the prompts: set up a new project, any name (for example `melvor2-guilds`), code directory `./`. Do not connect it to the Git repository when asked; it is not needed.
3. Add the connection string yourself: open the project on <https://vercel.com>, go to **Settings**, then **Environment Variables**, and add
   - Key `MONGODB_URI`, value: your Atlas connection string with the real password in place of `<db_password>`. Tick **Production** (and Preview if you want preview deploys to work).
   - Optional: key `MONGODB_DB` to change the database name. The default is `melvor2guilds`.
   - Recommended: key `REGISTER_CODE`, a tester code you make up (letters, digits, dashes; upper and lower case are treated the same). While it is set, only people who type it into the mod can enable guilds for the first time. Hand it out privately, not in a public channel. Several codes can be given separated by commas; to retire a code, remove it and deploy again. Players who already enabled guilds are not affected. Without it, anyone can register.
   - Optional: key `MAX_PLAYERS`, a whole number such as `30`. Once that many players have registered (banned ones are not counted), nobody new can register, even with the code. Raise the number and deploy again to let more in.
   - Recommended: key `ADMIN_KEY`, a long random value (40 or more characters, from a password generator). It turns on the admin tool below. Treat it like a password and tick **Sensitive**.
4. In MongoDB Atlas, open **Network Access** (under Security), click **Add IP Address**, choose **Allow access from anywhere** (`0.0.0.0/0`) and confirm. Vercel functions have no fixed IP addresses, so the database password is what protects the cluster. Use a long generated one.
5. Deploy:

   ```powershell
   npx vercel deploy --prod
   ```

   The command prints the production URL, for example `https://melvor2-guilds.vercel.app`.
6. Check it. Open `https://<your-url>/health?db=1` in a browser. It should show `{"ok":true,...,"db":true}`. Then run the end-to-end check, which creates two throwaway players and a guild and deletes them again:

   ```powershell
   node scripts/smoke.mjs https://<your-url>
   ```

7. Put the URL into the mod (see the main README).

Environment variables are read at deploy time, so after changing `MONGODB_URI` run `npx vercel deploy --prod` again.

If `/health?db=1` reports `database_unavailable`: check the password in `MONGODB_URI` (special characters must be URL-encoded), check step 4, and look at the function log under the project's **Logs** tab.

If every path answers with the health JSON, or with 404, the rewrite in `vercel.json` is not passing the path through. This could not be tested before the first deploy; the smoke script will show it straight away.

### Admin tool

With `ADMIN_KEY` set, `scripts/admin.mjs` lets you deal with problems. It asks for the admin key each time, or reads it from the `MELVOR2_ADMIN_KEY` environment variable.

```powershell
node scripts/admin.mjs count
node scripts/admin.mjs find "part of a name"
node scripts/admin.mjs ban 7656119xxxxxxxxxx
node scripts/admin.mjs unban 7656119xxxxxxxxxx
node scripts/admin.mjs delete-guild "Guild name"
node scripts/admin.mjs reset 7656119xxxxxxxxxx
```

- **count** shows how many players have registered, how many were online in the last 5 minutes, day and week, and whether new players can still join (anyone, with the code, or closed because `MAX_PLAYERS` is reached).
- **find** shows matching players with their Steam ID, their guilds and whether they are banned. Use it to get the Steam ID for the other commands. It also accepts a Steam ID.
- **ban** locks that Steam account out of guilds. The player is removed from the guilds they are in, and their chat messages, marketplace listings, offers, requests and invites are removed. Guilds they own are left alone and listed so you can delete the ones that should go. Items they had listed wait for them and come back if you unban them. A ban does not stop the same person using a different Steam account.
- **delete-guild** removes a guild the same way its owner disbanding it would: listed items go back to their sellers. It cannot be undone.
- **reset** is for a player who reinstalled Windows or moved to a new PC and sees "This Steam account already enabled guilds on another PC". It forgets their old key; they click **Enable Guilds** again and keep their guilds and anything waiting on the marketplace. Only do this for someone you are sure owns that Steam account, because whoever enables guilds with that Steam ID next gets the account.

For lower latency, set the function region near the Atlas cluster in the Vercel project under **Settings**, **Functions**.

## Develop

```powershell
npm install
```

```powershell
npm test
```

The tests use `mongodb-memory-server`, which downloads a MongoDB binary on the first run. No Atlas or Vercel account is needed.

## Protocol

Every request and response body is JSON. Bodies are capped at 4 KB, except `PUT /me/profile`, which allows 16 KB.

Every request except `/health` must send `X-Mod-Protocol: 1`. A missing or lower value gets `426`.

Every request except `/health` and `/register` must send `Authorization: Bearer <steamId>:<key>`.

Errors always look like this, with a suitable HTTP status:

```json
{ "error": { "code": "guild_full", "message": "This guild already has 50 members" } }
```

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_steam_id`, `invalid_key`, `invalid_name`, `invalid_guild_name`, `invalid_description`, `invalid_message`, `invalid_status`, `invalid_profile`, `invalid_cursor`, `invalid_rank`, `invalid_target`, `invalid_body`, `invalid_query`, `nothing_to_update` |
| 401 | `unauthorized` (unknown Steam ID or wrong key; register, then retry) |
| 403 | `not_member`, `forbidden` |
| 404 | `not_found`, `guild_not_found`, `player_not_found`, `member_not_found`, `request_not_found`, `invite_not_found` |
| 405 | `method_not_allowed` |
| 409 | `steam_id_claimed`, `name_taken`, `already_member`, `guild_limit`, `guild_full`, `too_many_pending`, `owner_cannot_leave`, `owns_guild`, `not_a_join_request`, `conflict` |
| 413 | `body_too_large` |
| 426 | `upgrade_required` |
| 429 | `rate_limited` |
| 500, 503 | `internal`, `database_unavailable` |

Ids: a player id is the SteamID64 as a string. A guild id is a 24-character hex string. Times are milliseconds since the Unix epoch.

### Identity

The server cannot verify Steam logins. On first use the mod generates a random key (32 to 128 characters from `A-Z a-z 0-9 _ - + / =`), stores it locally and registers it. The server keeps only the SHA-256 hash. The first key registered for a Steam ID wins. If the key is lost, the server owner can reset it (see "Admin tool").

Because Steam logins cannot be verified, anyone who can register can also talk to the API with their own program instead of the game, and nothing a client reports about its own bank, damage or levels can be checked. Set `REGISTER_CODE` to limit registration to people you gave the code to.

Requests with a missing or wrong key are counted per IP address; after 30 in a minute that address gets `429` for the rest of the minute.

## Endpoints

### Account

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /health` | | `{ok, service, protocol}`. Add `?db=1` to also ping the database. No headers needed. |
| `POST /register` | `{steamId, name, key, code?}` | `201 {player: {id, name}, created: true}` for a new Steam ID. `200` with `created: false` if the same key is presented again (also updates the name), or when it sets a new key after an admin reset. `409 steam_id_claimed` for a different key. When the server has `REGISTER_CODE` set, a new Steam ID must send a matching `code`: `403 code_required` or `403 code_wrong` otherwise. With `MAX_PLAYERS` set and reached, a new Steam ID gets `403 server_full`. |
| `POST /admin/reset-player` | `{steamId}` | Needs the `X-Admin-Key` header (the server's `ADMIN_KEY`); `404` when no `ADMIN_KEY` is set. Forgets the player's key so their next register sets a new one. |
| `POST /admin/ban`, `POST /admin/unban` | `{steamId}` | Same header. A banned player gets `403 banned` on every call, including `/register` and `/sync`. Banning also removes their memberships (except in guilds they own), messages, listings, offers, requests and invites; the reply lists `ownedGuilds`. |
| `POST /admin/delete-guild` | `{name}` or `{id}` | Same header. Disbands the guild. |
| `POST /admin/stats` | `{}` | Same header. `{players, banned, online, day, week, guilds, maxPlayers, registration}`; `registration` is `open`, `code` or `full`. |
| `POST /admin/find-player` | `{q}` | Same header. `q` is 2 to 32 characters of a name, or a Steam ID. `{players: [{id, name, banned, lastSeen, guilds: [{id, name, rank}]}]}`, up to 20. |
| `GET /me` | | `{player, guilds: [{id, name, description, ownerId, createdAt, rank}], invites: [{guildId, guildName, by, byName, at}], requests: [{guildId, guildName, at}], limits: {maxGuilds, maxMembers}}` |
| `PUT /me/profile` | `{skills: [{id, level}], gear: [{slot, item, qty}]}` | `{ok: true, updatedAt}`. Replaces my whole profile. See Profiles below. |
| `GET /players/:id/profile` | | `{player: {id, name}, profile: {skills, gear, updatedAt} or null, status, lastSeen}`. Only for myself or a player I share a guild with; otherwise `403 forbidden`. Unknown player: `404 player_not_found`. |
| `DELETE /me` | | Deletes my player record (including status and profile), memberships, requests, invites I sent and messages. `409 owns_guild` while I own a guild. The Steam ID can be registered again afterwards. |
| `POST /sync` | `{since?, status?, name?}` | See below. |

### `POST /sync`

Meant to be polled every 3 to 60 seconds (the mod uses 3 s with a guild screen open, 8 to 15 s in a party, 60 s otherwise). It sets my `lastSeen`, optionally my status and name, and returns everything the client needs to refresh.

Request:

- `since`: the `cursor` string from the previous response. Leave it out on the first call to get the latest 100 messages across my guilds.
- `status`: `{skill, level}` to set what I am doing (skill up to 40 characters, level an integer from 0 to 1000000), `null` to clear it, or leave it out to keep it. It may carry an optional `action`, described below.
- `name`: optional, updates my display name.

Response:

```json
{
  "now": 1795400000000,
  "cursor": "1795399999000-6b02...",
  "guilds": [
    { "id": "...", "name": "...", "rank": "member",
      "members": [ { "id": "7656...", "name": "...", "rank": "owner", "joinedAt": 0, "lastSeen": 0, "status": { "skill": "Woodcutting", "level": 42, "at": 0, "action": { "entity": "Melvor:Woodcutting", "target": "Melvor:OakTree", "name": "Oak Tree" } } } ] }
  ],
  "messages": [ { "id": "...", "guildId": "...", "playerId": "7656...", "name": "...", "body": "...", "at": 0 } ],
  "invites": [ { "guildId": "...", "guildName": "...", "by": "7656...", "byName": "...", "at": 0 } ]
}
```

Treat the cursor as opaque and send it back unchanged. Messages arrive oldest first, at most 200 per call; if there are more, the next call continues. The server does not repeat a message for the same cursor chain, but a message you posted yourself is returned both by the `POST` and by the next sync, so drop messages whose `id` you already have. Compare `lastSeen` with `now` to decide who is online. After joining a guild, load its backlog with `GET /guilds/:id/messages`.

#### Current action (mod v0.3)

`status.action` says exactly what the player is doing: `{entity, target, area?, name}`.

- `entity`, `target` and the optional `area` are game ids (see below). Combat uses `area`.
- `name` is the text to display, 1 to 60 characters after control characters are removed.
- A status sent without `action` (or with `action: null`) clears the stored action. `status: null` clears the whole status. Leaving `status` out keeps both.
- A malformed action gets `400 invalid_status` and nothing is stored.
- The action is returned inside `status` wherever a status is returned: sync members, `GET /guilds/:id` members (for fellow members) and `GET /players/:id/profile`. The `action` key is absent when there is none. Unknown fields inside `action` are dropped.

A game id is `<Namespace>:<LocalId>`, where each part starts with an upper-case letter followed by letters and digits (`^[A-Z][A-Za-z0-9]*$`), at most 80 characters in total. Example: `Melvor:OakTree`. The server checks the shape only, not whether the id exists in the game.

### Profiles (mod v0.3)

`PUT /me/profile` stores a snapshot of my skills and equipped gear on my player record.

- `skills`: up to 60 entries of `{id, level}`; `id` is a game id, `level` an integer from 0 to 1000. Each skill id may appear once.
- `gear`: up to 40 entries of `{slot, item, qty}`; `slot` and `item` are game ids, `qty` an integer from 0 to 1000000000. Each slot may appear once; the same item may sit in several slots.
- The upload replaces the whole profile. A list that is left out is stored as empty. Unknown fields are dropped. Anything invalid gets `400 invalid_profile` and the stored profile stays as it was.
- The body may be up to 16 KB. Uploads count against the write rate limit, so send one when something changed, not on every poll.

`GET /players/:id/profile` returns the profile together with the player's name, status and `lastSeen`. `profile` is `null` until the player has uploaded one. Access is checked on every call: the caller must be that player or currently be a member of at least one guild the player is in. A pending join request or invite does not count, and access ends when either side leaves, is kicked, or the guild is disbanded.

### Guilds

| Method and path | Who | Body | Result |
| --- | --- | --- | --- |
| `POST /guilds` | anyone | `{name, description?}` | `201 {guild}`. The caller becomes owner. |
| `GET /guilds/search?q=` | anyone | | `{guilds: [{..., memberCount}]}`, up to 20, name contains `q` (case-insensitive). An empty `q` lists the first 20. `ownerId` is left out. |
| `GET /guilds/:id` | anyone | | `{guild: {..., memberCount, myRank, myPending}, members: [{id, name, rank, joinedAt, lastSeen, status}]}`. Non-members get an empty `members` list and no `ownerId`: who is in a guild is only shown to its members. Officers and the owner also get `requests` and `invites`: `[{playerId, name, by, at}]`. |
| `PATCH /guilds/:id` | owner | `{name?, description?}` | `{guild}` |
| `DELETE /guilds/:id` | owner | | Disbands: removes the guild, members, requests, invites and messages. |
| `GET /guilds/:id/messages` | members | | `{messages}`: the latest 50, oldest first. |
| `POST /guilds/:id/messages` | members | `{body}` | `201 {message}` |

### Guild Grounds (mod v0.6)

Shared guild tasks at locations. The content (locations, tasks, accepted items, bonuses) is in `src/groundsData.js`; change numbers there and deploy. Never rename or reuse a task id that has been live.

| Method and path | Who | Body | Result |
| --- | --- | --- | --- |
| `GET /guilds/:id/grounds` | members | | `{rev, unit, tiers: [{id, name, locations: [{id, name, bonus: {id, value, text}, done, tasks: [{id, kind, text, need, have, mine, top: [{id, name, amount}], items?: [{item, worth}], enemies?}]}]}]}`. Amounts are in units of `1/unit` (thousandths). `kind` is `donate` or a label for a counted task (`kill`, `make`, `hunt`, `course`, `thieve`, `burn`, `bury`, `do`); counted tasks also carry `stat` and usually `ids`. |
| `POST /guilds/:id/grounds/donate` | members | `{task, item, qty, nonce}` | `{accepted, qty}`. The donor's game has already removed the items; it puts back `qty - accepted`. The same `nonce` always gets the same answer. Progress never passes a task's `need`. |

Counts ride on `/sync`: the body may carry `grounds: {seq, counts: {counterId: {objectId: n}}}`, how much the game's own per-object counters grew (for example `MelvorBase:CombatEnemyKilled` per monster, `MelvorBase:SmithingItemGained` per item). A task names its counter in `stat` and, usually, the objects that count in `ids`. A batch is applied once per `seq` (numbers must go up), to every guild the player is in, and the reply carries `groundsAck: seq`. Each guild in the `/sync` reply has `groundsRev` (changes when progress does) and `bonuses: [{id, value}]` for its finished locations. Nothing is verified: the server cannot see anyone's game.

Leaving or being kicked keeps past contributions; deleting your data removes your name from them but not the guild's progress; disbanding deletes the grounds. Donated items are never returned.

### Tester chat (mod v0.6.1)

One chat channel shared by every player who opts in, for talking about the mod and reporting bugs. Its messages are stored like guild messages and reach players through `/sync` with `guildId: "testers"`. They expire after 14 days like all messages, and are removed when their author deletes their data or is banned.

| Method and path | Who | Body | Result |
| --- | --- | --- | --- |
| `POST /testers` | anyone | `{on}` | `{testers}`. `true` joins, `false` leaves. `/me` and `/sync` report the current state as `testers`. |
| `POST /testers/messages` | players who joined | `{body}` | `201 {message}`. Others get `403 not_tester`. Counts against the message rate limit. |

The admin `count` command shows how many players are in the tester chat. To remove someone's messages, `ban` them.

### Joining

| Method and path | Who | Body | Result |
| --- | --- | --- | --- |
| `POST /guilds/:id/join` | anyone | | `201 {joined: false, requested: true}`. If I already hold an invite to this guild, I join at once: `{joined: true}`. |
| `DELETE /guilds/:id/join` | requester | | Cancels my join request. |
| `POST /guilds/:id/invite` | officer, owner | `{steamId}` | `201 {joined: false, invited: true}`. The player must have registered. If they already asked to join, they join at once: `{joined: true}`. |
| `POST /guilds/:id/requests/:playerId` | officer, owner | `{accept}` | `true` accepts a join request. `false` declines a join request or cancels an invite. |
| `POST /invites/:guildId` | the invited player | `{accept}` | Accepts or declines my invite. |

### Members

| Method and path | Who | Body | Result |
| --- | --- | --- | --- |
| `POST /guilds/:id/leave` | officer, member | | The owner gets `409 owner_cannot_leave`: transfer or disband first. |
| `DELETE /guilds/:id/members/:playerId` | officer, owner | | Officers can kick members only. The owner can kick anyone but themself. |
| `POST /guilds/:id/members/:playerId/rank` | owner | `{rank}` | `rank` is `officer` or `member`. |
| `POST /guilds/:id/transfer` | owner | `{playerId}` | The target becomes owner, the old owner becomes officer. |

## Rules enforced on every write

- At most 3 guilds per player and 50 members per guild.
- Guild name: 3 to 24 characters from letters, digits, spaces, `-` and `_`; unique regardless of case.
- Description: up to 200 characters. Message: 1 to 300 characters. Player name: 1 to 32 characters. Control characters are removed from all three; tabs and line breaks become spaces.
- Status action: game ids up to 80 characters, display name 1 to 60 characters. Profile: up to 60 skills (level 0 to 1000) and 40 gear slots (quantity 0 to 1000000000), body up to 16 KB.
- At most 10 pending join requests per player, 20 pending invites per player and 100 pending requests and invites per guild.
- Rate limits, counted in MongoDB: 60 writes per minute and 10 messages per 10 seconds per player, 60 syncs per minute per player, 120 reads per minute per player, 30 registrations per hour per IP address.
- Messages are deleted automatically after 14 days.

## Data

Database `melvor2guilds` (or `MONGODB_DB`). Indexes are created on the first request after each cold start.

| Collection | Fields | Indexes |
| --- | --- | --- |
| `players` | `_id` (Steam ID), `name`, `keyHash`, `createdAt`, `lastSeen`, `status {skill, level, at, action? {entity, target, area?, name}}`, `profile? {skills [{id, level}], gear [{slot, item, qty}], updatedAt}` | |
| `guilds` | `name`, `nameLower`, `description`, `ownerId`, `createdAt` | unique `nameLower`; `ownerId` |
| `members` | `guildId`, `playerId`, `rank`, `joinedAt` | unique `guildId + playerId`; `playerId` |
| `requests` | `guildId`, `playerId`, `kind` (`request` or `invite`), `by`, `at` | unique `guildId + playerId`; `playerId + kind` |
| `messages` | `guildId`, `playerId`, `name`, `body`, `at` | `guildId + at`; `playerId`; `at` expiring after 14 days |
| `ratelimits` | `_id` (bucket, player, window), `n`, `expireAt` | `expireAt` expiring |

`guilds.ownerId` decides who the owner is. No multi-document transactions are used; operations are ordered so that an interrupted one can be repeated.
