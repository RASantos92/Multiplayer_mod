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

Every request and response body is JSON. Bodies are capped at 4 KB.

Every request except `/health` must send `X-Mod-Protocol: 1`. A missing or lower value gets `426`.

Every request except `/health` and `/register` must send `Authorization: Bearer <steamId>:<key>`.

Errors always look like this, with a suitable HTTP status:

```json
{ "error": { "code": "guild_full", "message": "This guild already has 50 members" } }
```

| Status | Codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_steam_id`, `invalid_key`, `invalid_name`, `invalid_guild_name`, `invalid_description`, `invalid_message`, `invalid_status`, `invalid_cursor`, `invalid_rank`, `invalid_target`, `invalid_body`, `invalid_query`, `nothing_to_update` |
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

The server cannot verify Steam logins. On first use the mod generates a random key (32 to 128 characters from `A-Z a-z 0-9 _ - + / =`), stores it locally and registers it. The server keeps only the SHA-256 hash. The first key registered for a Steam ID wins; there is no recovery if the key is lost, other than asking the server owner to delete the player document.

## Endpoints

### Account

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /health` | | `{ok, service, protocol}`. Add `?db=1` to also ping the database. No headers needed. |
| `POST /register` | `{steamId, name, key}` | `201 {player: {id, name}, created: true}` for a new Steam ID. `200` with `created: false` if the same key is presented again (also updates the name). `409 steam_id_claimed` for a different key. |
| `GET /me` | | `{player, guilds: [{id, name, description, ownerId, createdAt, rank}], invites: [{guildId, guildName, by, byName, at}], requests: [{guildId, guildName, at}], limits: {maxGuilds, maxMembers}}` |
| `DELETE /me` | | Deletes my player record, memberships, requests, invites I sent and messages. `409 owns_guild` while I own a guild. The Steam ID can be registered again afterwards. |
| `POST /sync` | `{since?, status?, name?}` | See below. |

### `POST /sync`

Meant to be polled every 3 to 20 seconds. It sets my `lastSeen`, optionally my status and name, and returns everything the client needs to refresh.

Request:

- `since`: the `cursor` string from the previous response. Leave it out on the first call to get the latest 100 messages across my guilds.
- `status`: `{skill, level}` to set what I am doing (skill up to 40 characters, level an integer from 0 to 1000000), `null` to clear it, or leave it out to keep it.
- `name`: optional, updates my display name.

Response:

```json
{
  "now": 1795400000000,
  "cursor": "1795399999000-6b02...",
  "guilds": [
    { "id": "...", "name": "...", "rank": "member",
      "members": [ { "id": "7656...", "name": "...", "rank": "owner", "joinedAt": 0, "lastSeen": 0, "status": { "skill": "Woodcutting", "level": 42, "at": 0 } } ] }
  ],
  "messages": [ { "id": "...", "guildId": "...", "playerId": "7656...", "name": "...", "body": "...", "at": 0 } ],
  "invites": [ { "guildId": "...", "guildName": "...", "by": "7656...", "byName": "...", "at": 0 } ]
}
```

Treat the cursor as opaque and send it back unchanged. Messages arrive oldest first, at most 200 per call; if there are more, the next call continues. The server does not repeat a message for the same cursor chain, but a message you posted yourself is returned both by the `POST` and by the next sync, so drop messages whose `id` you already have. Compare `lastSeen` with `now` to decide who is online. After joining a guild, load its backlog with `GET /guilds/:id/messages`.

### Guilds

| Method and path | Who | Body | Result |
| --- | --- | --- | --- |
| `POST /guilds` | anyone | `{name, description?}` | `201 {guild}`. The caller becomes owner. |
| `GET /guilds/search?q=` | anyone | | `{guilds: [{..., memberCount}]}`, up to 20, name contains `q` (case-insensitive). An empty `q` lists the first 20. |
| `GET /guilds/:id` | anyone | | `{guild: {..., memberCount, myRank, myPending}, members: [{id, name, rank, joinedAt, lastSeen, status}]}`. Non-members do not get `lastSeen` and `status`. Officers and the owner also get `requests` and `invites`: `[{playerId, name, by, at}]`. |
| `PATCH /guilds/:id` | owner | `{name?, description?}` | `{guild}` |
| `DELETE /guilds/:id` | owner | | Disbands: removes the guild, members, requests, invites and messages. |
| `GET /guilds/:id/messages` | members | | `{messages}`: the latest 50, oldest first. |
| `POST /guilds/:id/messages` | members | `{body}` | `201 {message}` |

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
- At most 10 pending join requests per player, 20 pending invites per player and 100 pending requests and invites per guild.
- Rate limits, counted in MongoDB: 60 writes per minute and 10 messages per 10 seconds per player, 60 syncs per minute per player, 120 reads per minute per player, 30 registrations per hour per IP address.
- Messages are deleted automatically after 14 days.

## Data

Database `melvor2guilds` (or `MONGODB_DB`). Indexes are created on the first request after each cold start.

| Collection | Fields | Indexes |
| --- | --- | --- |
| `players` | `_id` (Steam ID), `name`, `keyHash`, `createdAt`, `lastSeen`, `status {skill, level, at}` | |
| `guilds` | `name`, `nameLower`, `description`, `ownerId`, `createdAt` | unique `nameLower`; `ownerId` |
| `members` | `guildId`, `playerId`, `rank`, `joinedAt` | unique `guildId + playerId`; `playerId` |
| `requests` | `guildId`, `playerId`, `kind` (`request` or `invite`), `by`, `at` | unique `guildId + playerId`; `playerId + kind` |
| `messages` | `guildId`, `playerId`, `name`, `body`, `at` | `guildId + at`; `playerId`; `at` expiring after 14 days |
| `ratelimits` | `_id` (bucket, player, window), `n`, `expireAt` | `expireAt` expiring |

`guilds.ownerId` decides who the owner is. No multi-document transactions are used; operations are ordered so that an interrupted one can be repeated.
