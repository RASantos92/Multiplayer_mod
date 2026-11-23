// Router and handlers. No HTTP or driver specifics in here: `handle()` takes a
// plain description of the request and a store (see store.js) and returns
// { status, body }.
import { createHash, timingSafeEqual } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { bonusesOf, createGrounds } from './grounds.js';
import { createMarket } from './market.js';

export const PROTOCOL = 1;

export const DEFAULT_LIMITS = {
  maxGuildsPerPlayer: 3,
  maxMembersPerGuild: 50,
  maxJoinRequestsPerPlayer: 10,
  maxInvitesPerPlayer: 20,
  maxPendingPerGuild: 100,
  searchResults: 20,
  historyMessages: 50,
  syncInitialMessages: 100,
  syncMaxMessages: 200,
  syncOverlapMs: 2000,
  // [max hits, window in ms]
  rate: {
    register: [30, 60 * 60_000], // per IP
    authFail: [30, 60_000], // per IP, requests with a missing or wrong key (counted in memory)
    admin: [120, 60 * 60_000], // per IP
    write: [60, 60_000], // per player, every non-GET except /sync
    message: [10, 10_000], // per player, on top of `write`
    sync: [60, 60_000], // per player
    read: [120, 60_000], // per player
  },
};

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (code, message) => new HttpError(400, code, message);
const forbidden = (message) => new HttpError(403, 'forbidden', message);
const notFound = (code, message) => new HttpError(404, code, message);
const conflict = (code, message) => new HttpError(409, code, message);

// ---------- validation ----------

const STEAM_MIN = 76561197960265728n; // SteamID64 of individual account id 0
const STEAM_MAX = STEAM_MIN + 0xffffffffn;

function vSteamId(v, field = 'steamId') {
  if (typeof v !== 'string' || !/^\d{17}$/.test(v)) throw bad('invalid_steam_id', `${field} must be a 17-digit SteamID64 string`);
  const n = BigInt(v);
  if (n <= STEAM_MIN || n > STEAM_MAX) throw bad('invalid_steam_id', `${field} is not a valid SteamID64`);
  return v;
}

function vKey(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_\-+/=]{32,128}$/.test(v)) {
    throw bad('invalid_key', 'key must be 32 to 128 characters of A-Z a-z 0-9 _ - + / =');
  }
  return v;
}

/** Tabs and line breaks become spaces; other control and bidi-override characters are removed. */
export function cleanText(s) {
  return s
    .replace(/[\t\n\r\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, '')
    .trim();
}
const len = (s) => [...s].length;

function vPlayerName(v) {
  if (typeof v !== 'string') throw bad('invalid_name', 'name must be a string');
  const s = cleanText(v);
  if (len(s) < 1 || len(s) > 32) throw bad('invalid_name', 'name must be 1 to 32 characters');
  return s;
}

function vGuildName(v) {
  if (typeof v !== 'string') throw bad('invalid_guild_name', 'name must be a string');
  const s = v.trim().replace(/ {2,}/g, ' ');
  if (!/^[A-Za-z0-9 _-]{3,24}$/.test(s)) {
    throw bad('invalid_guild_name', 'Guild name must be 3 to 24 characters: letters, digits, spaces, - and _');
  }
  return s;
}

function vDescription(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad('invalid_description', 'description must be a string');
  const s = cleanText(v);
  if (len(s) > 200) throw bad('invalid_description', 'description must be at most 200 characters');
  return s;
}

function vMessageBody(v) {
  if (typeof v !== 'string') throw bad('invalid_message', 'body must be a string');
  const s = cleanText(v);
  if (len(s) < 1 || len(s) > 300) throw bad('invalid_message', 'Message must be 1 to 300 characters');
  return s;
}

function vStatus(v, nowMs) {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('invalid_status', 'status must be an object or null');
  const skill = typeof v.skill === 'string' ? cleanText(v.skill) : '';
  if (len(skill) > 40) throw bad('invalid_status', 'status.skill must be at most 40 characters');
  const level = v.level ?? 0;
  if (!Number.isInteger(level) || level < 0 || level > 1_000_000) throw bad('invalid_status', 'status.level must be an integer from 0 to 1000000');
  const status = { skill, level, at: new Date(nowMs) };
  // Optional; a status sent without it clears the stored action.
  if (v.action !== undefined && v.action !== null) status.action = vAction(v.action);
  // Optional, sent while fighting; a status sent without it clears the stored combat state.
  if (v.combat !== undefined && v.combat !== null) status.combat = vCombat(v.combat);
  return status;
}

const GAME_ID_RE = /^[A-Z][A-Za-z0-9]*:[A-Z][A-Za-z0-9]*$/;
const isGameId = (v) => typeof v === 'string' && v.length <= 80 && GAME_ID_RE.test(v);
const isIntIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// What a player in a fight shares with guild mates: health, damage per second and combat level.
// The server cannot verify these; it only keeps them inside sane ranges.
function vCombat(c) {
  const fail = (m) => bad('invalid_status', `status.combat${m}`);
  if (!isObj(c)) throw fail(' must be an object');
  if (!isIntIn(c.maxHp, 1, 1e9)) throw fail('.maxHp must be an integer from 1 to 1000000000');
  if (!isIntIn(c.hp, 0, 1e9)) throw fail('.hp must be an integer from 0 to 1000000000');
  if (!isIntIn(c.dps, 0, 1e9)) throw fail('.dps must be an integer from 0 to 1000000000');
  if (!isIntIn(c.level, 0, 100000)) throw fail('.level must be an integer from 0 to 100000');
  const out = { hp: Math.min(c.hp, c.maxHp), maxHp: c.maxHp, dps: c.dps, level: c.level };
  // Optional: milliseconds between the player's attacks, so their damage can land in the same rhythm.
  if (c.interval !== undefined && c.interval !== null) {
    if (!isIntIn(c.interval, 250, 60000)) throw fail('.interval must be an integer from 250 to 60000');
    out.interval = c.interval;
  }
  // Optional: the player's chance to hit, in percent, so their hits on my enemy can miss as often as theirs do.
  if (c.hit !== undefined && c.hit !== null) {
    if (!isIntIn(c.hit, 1, 100)) throw fail('.hit must be an integer from 1 to 100');
    out.hit = c.hit;
  }
  // Optional: the player's smallest and largest hit, so their hits on my enemy can vary the way theirs do.
  if (c.max !== undefined && c.max !== null) {
    if (!isIntIn(c.max, 1, 1e9)) throw fail('.max must be an integer from 1 to 1000000000');
    if (!isIntIn(c.min ?? 0, 0, c.max)) throw fail('.min must be an integer from 0 to .max');
    out.min = c.min ?? 0;
    out.max = c.max;
  }
  return out;
}

function vAction(a) {
  const fail = (m) => bad('invalid_status', `status.action${m}`);
  if (!isObj(a)) throw fail(' must be an object');
  for (const f of ['entity', 'target']) {
    if (!isGameId(a[f])) throw fail(`.${f} must be a game id like "Namespace:LocalId" (at most 80 characters)`);
  }
  const out = { entity: a.entity, target: a.target };
  if (a.area !== undefined && a.area !== null) {
    if (!isGameId(a.area)) throw fail('.area must be a game id like "Namespace:LocalId" (at most 80 characters)');
    out.area = a.area;
  }
  const name = typeof a.name === 'string' ? cleanText(a.name) : '';
  if (len(name) < 1 || len(name) > 60) throw fail('.name must be 1 to 60 characters');
  out.name = name;
  return out;
}

export const PROFILE_LIMITS = { skills: 60, gear: 40, maxLevel: 1000, maxQty: 1_000_000_000 };

function vProfile(body) {
  const fail = (m) => bad('invalid_profile', m);
  const list = (field, max) => {
    const v = body[field] ?? [];
    if (!Array.isArray(v)) throw fail(`${field} must be an array`);
    if (v.length > max) throw fail(`${field} can have at most ${max} entries`);
    return v;
  };
  const seenSkills = new Set();
  const skills = list('skills', PROFILE_LIMITS.skills).map((s, i) => {
    if (!isObj(s) || !isGameId(s.id)) throw fail(`skills[${i}].id must be a game id like "Namespace:LocalId"`);
    if (!isIntIn(s.level, 0, PROFILE_LIMITS.maxLevel)) throw fail(`skills[${i}].level must be an integer from 0 to ${PROFILE_LIMITS.maxLevel}`);
    if (seenSkills.has(s.id)) throw fail(`skills lists ${s.id} more than once`);
    seenSkills.add(s.id);
    return { id: s.id, level: s.level };
  });
  const seenSlots = new Set();
  const gear = list('gear', PROFILE_LIMITS.gear).map((g, i) => {
    if (!isObj(g) || !isGameId(g.slot)) throw fail(`gear[${i}].slot must be a game id like "Namespace:LocalId"`);
    if (!isGameId(g.item)) throw fail(`gear[${i}].item must be a game id like "Namespace:LocalId"`);
    if (!isIntIn(g.qty, 0, PROFILE_LIMITS.maxQty)) throw fail(`gear[${i}].qty must be an integer from 0 to ${PROFILE_LIMITS.maxQty}`);
    if (seenSlots.has(g.slot)) throw fail(`gear lists slot ${g.slot} more than once`);
    seenSlots.add(g.slot);
    return { slot: g.slot, item: g.item, qty: g.qty };
  });
  return { skills, gear };
}

function vGuildId(v) {
  if (typeof v !== 'string' || !/^[0-9a-f]{24}$/.test(v)) throw notFound('guild_not_found', 'Guild not found');
  return new ObjectId(v);
}

const CURSOR_RE = /^(\d{1,15})(?:-([0-9a-f]{24}(?:\.[0-9a-f]{24}){0,49}))?$/;
function vCursor(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = typeof v === 'string' ? CURSOR_RE.exec(v) : null;
  if (!m) throw bad('invalid_cursor', 'since must be a cursor returned by /sync');
  return { t: Number(m[1]), ids: new Set(m[2] ? m[2].split('.') : []) };
}

// ---------- helpers ----------

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
function sameHash(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
const ms = (d) => (d instanceof Date ? d.getTime() : null);

/** guilds.ownerId is the single source of truth for ownership. */
function rankOf(guild, member) {
  if (guild.ownerId === member.playerId) return 'owner';
  return member.rank === 'owner' ? 'officer' : member.rank;
}

const guildOut = (g, extra = {}) => ({
  id: String(g._id),
  name: g.name,
  description: g.description,
  ownerId: g.ownerId,
  createdAt: ms(g.createdAt),
  ...extra,
});
const statusOut = (s) =>
  s ? { skill: s.skill, level: s.level, at: ms(s.at), ...(s.action ? { action: s.action } : {}), ...(s.combat ? { combat: s.combat } : {}) } : null;
const profileOut = (p) => (p ? { skills: p.skills, gear: p.gear, updatedAt: ms(p.updatedAt) } : null);
// The tester chat is one channel shared by every player who opted in. Its messages are stored like guild
// messages, under this fixed id, and reach players as `guildId: 'testers'`.
export const TESTERS_CHANNEL = 'testers';
const TESTERS_ID = new ObjectId('000000000000000000000001');
const messageOut = (m) => ({
  id: String(m._id),
  guildId: TESTERS_ID.equals(m.guildId) ? TESTERS_CHANNEL : String(m.guildId),
  playerId: m.playerId,
  name: m.name,
  body: m.body,
  at: ms(m.at),
});
const memberOut = (guild, m, withPresence) => ({
  id: m.playerId,
  name: m.name,
  rank: rankOf(guild, m),
  joinedAt: ms(m.joinedAt),
  ...(withPresence ? { lastSeen: ms(m.lastSeen), status: statusOut(m.status) } : {}),
});
const inviteOut = (r) => ({ guildId: String(r.guildId), guildName: r.guildName, by: r.by, byName: r.byName, at: ms(r.at) });
const RANK_ORDER = { owner: 0, officer: 1, member: 2 };
const sortMembers = (list) => list.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.name.localeCompare(b.name));

const reply = (status, body) => ({ status, body });

// ---------- app ----------

/** "a, b" -> ['a', 'b']: codes are compared without regard to case or surrounding spaces. */
const parseCodes = (v) => String(v ?? '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);

/**
 * @param {object} o
 * @param {{registerCode?: string, adminKey?: string, maxPlayers?: string|number}} [o.config]
 *   registerCode: when set, a new player must send one of these (comma separated) codes to register.
 *   maxPlayers: when set to a whole number above 0, no new player can register once that many
 *     (not counting banned ones) have.
 *   adminKey: when set, turns on the admin endpoints, which need it in the X-Admin-Key header.
 */
export function createApp({ store, limits = {}, now = () => Date.now(), config = {} }) {
  const L = { ...DEFAULT_LIMITS, ...limits, rate: { ...DEFAULT_LIMITS.rate, ...limits.rate } };
  const registerCodes = parseCodes(config.registerCode);
  const adminKeyHash = config.adminKey ? sha256(String(config.adminKey)) : null;
  const maxPlayers = /^\d{1,9}$/.test(String(config.maxPlayers ?? '').trim()) ? Number(config.maxPlayers) : 0;

  // Requests with a bad key cost a database read each, so an address that keeps sending them is cut off
  // before that read. Kept in memory: it only has to hold back a flood on a warm instance.
  const authFails = new Map();
  const failWindow = (ip) => {
    const [, windowMs] = L.rate.authFail;
    const f = authFails.get(ip);
    return f && now() - f.start < windowMs ? f : null;
  };
  function noteAuthFail(ip) {
    const f = failWindow(ip);
    if (f) f.n++;
    else {
      if (authFails.size > 5000) authFails.clear();
      authFails.set(ip, { start: now(), n: 1 });
    }
  }

  function checkRegisterCode(code) {
    if (!registerCodes.length) return;
    if (typeof code !== 'string' || !code.trim()) {
      throw new HttpError(403, 'code_required', 'This server is in closed testing. Enter the tester code you were given.');
    }
    const sent = sha256(code.trim().toLowerCase());
    if (!registerCodes.some((c) => sameHash(sha256(c), sent))) {
      throw new HttpError(403, 'code_wrong', 'That tester code is not right. Check it and try again.');
    }
  }

  async function rate(key, bucket) {
    const [max, windowMs] = L.rate[bucket];
    if (!(await store.hit(`${bucket}:${key}`, max, windowMs, now()))) {
      throw new HttpError(429, 'rate_limited', `Too many requests (${bucket}). Slow down and try again shortly.`);
    }
  }

  function parseAuth(headers) {
    const m = /^Bearer (\d{17}):([A-Za-z0-9_\-+/=]{32,128})$/.exec(headers.authorization ?? '');
    if (!m) throw new HttpError(401, 'unauthorized', 'Send "Authorization: Bearer <steamId>:<key>"');
    return { steamId: m[1], keyHash: sha256(m[2]) };
  }
  const unknownCaller = () => new HttpError(401, 'unauthorized', 'Unknown Steam ID or wrong key. Register first with POST /register.');

  /** Guild + my membership + my effective rank (null when I am not a member). */
  async function guildCtx(idParam, me) {
    const gid = vGuildId(idParam);
    const [guild, member] = await Promise.all([store.getGuild(gid), store.getMember(gid, me)]);
    if (!guild) throw notFound('guild_not_found', 'Guild not found');
    const rank = guild.ownerId === me ? 'owner' : member ? rankOf(guild, member) : null;
    return { gid, guild, member, rank };
  }
  function requireRank(ctx, ...allowed) {
    if (!ctx.rank) throw new HttpError(403, 'not_member', 'You are not a member of this guild');
    if (!allowed.includes(ctx.rank)) throw forbidden(`Only the guild ${allowed.join(' or ')} can do this`);
  }

  /** Insert a membership, then enforce both caps (undoing the insert if either is exceeded). */
  async function addMember(gid, playerId, rank) {
    if (!(await store.insertMember({ guildId: gid, playerId, rank, joinedAt: new Date(now()) }))) {
      throw conflict('already_member', 'That player is already a member of this guild');
    }
    const [mine, total] = await Promise.all([store.countGuildsOf(playerId), store.countMembers(gid)]);
    if (mine > L.maxGuildsPerPlayer || total > L.maxMembersPerGuild) {
      await store.deleteMember(gid, playerId);
      if (total > L.maxMembersPerGuild) throw conflict('guild_full', `This guild already has ${L.maxMembersPerGuild} members`);
      throw conflict('guild_limit', `A player can be in at most ${L.maxGuildsPerPlayer} guilds`);
    }
  }

  async function targetMember(ctx, playerIdParam, me, selfMessage) {
    const target = vSteamId(playerIdParam, 'playerId');
    if (target === me) throw bad('invalid_target', selfMessage);
    const member = await store.getMember(ctx.gid, target);
    if (!member) throw notFound('member_not_found', 'That player is not a member of this guild');
    return { target, member, rank: rankOf(ctx.guild, member) };
  }

  async function adminAuth({ headers, ip }) {
    if (!adminKeyHash) throw notFound('not_found', 'No such endpoint');
    await rate(ip, 'admin');
    if (!sameHash(sha256(String(headers['x-admin-key'] ?? '')), adminKeyHash)) {
      throw new HttpError(401, 'unauthorized', 'Wrong admin key');
    }
  }
  async function adminPlayer(ctx) {
    await adminAuth(ctx);
    const steamId = vSteamId(ctx.body.steamId);
    const player = await store.getPlayer(steamId);
    if (!player) throw notFound('player_not_found', 'No such player');
    return { steamId, player };
  }
  const banned = () => new HttpError(403, 'banned', 'This account has been banned from this guild server.');

  const market = createMarket({ store, now, guildCtx, requireRank, limits: limits.market });
  const grounds = createGrounds({ store, now, guildCtx, requireRank, limits: limits.grounds });

  // ----- handlers: (ctx) => body | reply(status, body) -----
  // ctx = { me, player, params, query, body, headers, ip }

  const h = {
    async register({ body, ip }) {
      await rate(ip, 'register');
      const steamId = vSteamId(body.steamId);
      const name = vPlayerName(body.name);
      const keyHash = sha256(vKey(body.key));
      const out = (created) => reply(created ? 201 : 200, { player: { id: steamId, name }, created });

      let existing = await store.getPlayer(steamId);
      if (!existing) {
        checkRegisterCode(body.code);
        if (maxPlayers > 0 && (await store.countPlayers({ banned: { $ne: true } })) >= maxPlayers) {
          throw new HttpError(403, 'server_full', 'This test is full: no new players are being added right now.');
        }
        const t = new Date(now());
        if (await store.insertPlayer({ _id: steamId, name, keyHash, createdAt: t, lastSeen: t, status: null })) return out(true);
        existing = await store.getPlayer(steamId); // lost a race with another register
      }
      // An admin reset this player's key (they lost their key file): the next register sets a new one.
      if (existing && existing.keyHash === null && (await store.claimPlayer(steamId, keyHash, name))) return out(false);
      if (existing?.banned) throw banned();
      if (!existing || !sameHash(existing.keyHash, keyHash)) {
        throw conflict('steam_id_claimed', 'This Steam ID is already registered with a different key');
      }
      if (existing.name !== name) await store.setPlayerName(steamId, name);
      return out(false);
    },

    async me({ me, player }) {
      const [memberships, reqs] = await Promise.all([store.membershipsOf(me), store.requestsOf(me)]);
      return {
        player: { id: me, name: player.name },
        testers: player.testers === true,
        guilds: memberships.map(({ member, guild }) => guildOut(guild, { rank: rankOf(guild, member) })),
        invites: reqs.filter((r) => r.kind === 'invite').map(inviteOut),
        requests: reqs.filter((r) => r.kind === 'request').map((r) => ({ guildId: String(r.guildId), guildName: r.guildName, at: ms(r.at) })),
        limits: { maxGuilds: L.maxGuildsPerPlayer, maxMembers: L.maxMembersPerGuild },
      };
    },

    async deleteMe({ me }) {
      if (await store.countOwned(me)) {
        throw conflict('owns_guild', 'Transfer or disband the guilds you own before deleting your data');
      }
      // Items and gold only exist on the server while they wait: deleting now would lose them.
      if (await market.hasUnfinished(me)) {
        throw conflict('market_pending', 'Cancel your marketplace listings and let the game collect what is waiting for you first');
      }
      await store.purgePlayerChildren(me);
      await store.deletePlayer(me);
      return { ok: true };
    },

    // Replaces my whole profile (skill levels and equipped gear).
    async putProfile({ me, body }) {
      const updatedAt = new Date(now());
      await store.setProfile(me, { ...vProfile(body), updatedAt });
      return { ok: true, updatedAt: ms(updatedAt) };
    },

    // Visible to the player themself and to anyone who shares a guild with them.
    async getProfile({ me, player, params }) {
      const id = vSteamId(params.id, 'player id');
      let target = player;
      if (id !== me) {
        const [found, shared] = await Promise.all([store.getPlayer(id), store.shareGuild(me, id)]);
        if (!found) throw notFound('player_not_found', 'No such player');
        if (!shared) throw forbidden('You can only view players you share a guild with');
        target = found;
      }
      return {
        player: { id, name: target.name },
        profile: profileOut(target.profile),
        status: statusOut(target.status),
        lastSeen: ms(target.lastSeen),
      };
    },

    // Authenticates itself so the lastSeen/status update and the key check share one query.
    async sync({ headers, body }) {
      const { steamId: me, keyHash } = parseAuth(headers);
      const t = now();
      const since = vCursor(body.since);
      const set = { lastSeen: new Date(t) };
      if (body.status !== undefined) set.status = vStatus(body.status, t);
      if (body.name !== undefined) set.name = vPlayerName(body.name);

      const self = await store.touchPlayer(me, keyHash, set);
      if (!self) {
        const who = await store.getPlayer(me);
        throw who?.banned && sameHash(who.keyHash, keyHash) ? banned() : unknownCaller();
      }
      const [, memberships] = await Promise.all([rate(me, 'sync'), store.membershipsOf(me)]);
      const gids = memberships.map((m) => m.guild._id);

      // Guild Grounds counts (kills, laps, thieving) ride along; each numbered batch is applied once.
      // Progress and bonuses are the player's own, and only apply while they are in a guild.
      let groundsAck = null;
      let mine = self;
      if (body.grounds !== undefined) {
        const counted = await grounds.applyCounts(self, body.grounds);
        groundsAck = counted.ack;
        mine = counted.player;
      } else if (gids.length && !self.groundsSeeded) {
        mine = await grounds.ready(self);
      }
      const myBonuses = bonusesOf(mine);

      // Chat comes from the player's guilds and, if they opted in, the tester chat.
      const channels = self.testers ? [...gids, TESTERS_ID] : gids;
      const [roster, fetched, reqs] = await Promise.all([
        store.rosters(gids),
        since
          ? store.messagesSince(channels, new Date(since.t - L.syncOverlapMs), L.syncMaxMessages + since.ids.size)
          : store.latestMessages(channels, L.syncInitialMessages),
        store.requestsOf(me),
      ]);
      await market.sweep();
      const claims = await market.pendingClaims(me);

      // The cursor is "<newest timestamp seen>-<ids seen inside the overlap window>". Each
      // poll re-reads the last couple of seconds so a message whose insert landed slightly
      // out of order is not skipped, and the id list stops those from being sent twice.
      const fresh = [];
      const seen = [];
      for (const m of fetched) {
        if (since?.ids.has(String(m._id))) {
          seen.push(m);
        } else if (fresh.length < L.syncMaxMessages) {
          fresh.push(m);
          seen.push(m);
        } else break;
      }
      const lastAt = seen.length ? ms(seen[seen.length - 1].at) : 0;
      const cursorT = Math.max(since?.t ?? 0, lastAt) || t;
      const ids = seen.filter((m) => ms(m.at) > cursorT - L.syncOverlapMs).map((m) => String(m._id)).slice(-50);
      const cursor = ids.length ? `${cursorT}-${ids.join('.')}` : String(cursorT);

      const byGuild = new Map(gids.map((g) => [String(g), []]));
      const guildById = new Map(memberships.map((m) => [String(m.guild._id), m.guild]));
      for (const m of roster) byGuild.get(String(m.guildId))?.push(memberOut(guildById.get(String(m.guildId)), m, true));

      return {
        now: t,
        cursor,
        guilds: memberships.map(({ member, guild }) => ({
          id: String(guild._id),
          name: guild.name,
          rank: rankOf(guild, member),
          marketRev: guild.marketRev ?? 0,
          // The same in every guild: the game takes the largest of each bonus, so nothing counts twice.
          groundsRev: mine.groundsRev ?? 0,
          bonuses: myBonuses,
          members: sortMembers(byGuild.get(String(guild._id))),
        })),
        claims,
        testers: self.testers === true,
        ...(groundsAck == null ? {} : { groundsAck }),
        messages: fresh.map(messageOut),
        invites: reqs.filter((r) => r.kind === 'invite').map(inviteOut),
      };
    },

    async createGuild({ me, body }) {
      const name = vGuildName(body.name);
      const description = vDescription(body.description);
      if ((await store.countGuildsOf(me)) >= L.maxGuildsPerPlayer) {
        throw conflict('guild_limit', `You can be in at most ${L.maxGuildsPerPlayer} guilds`);
      }
      const doc = { name, nameLower: name.toLowerCase(), description, ownerId: me, createdAt: new Date(now()) };
      const gid = await store.insertGuild(doc);
      if (!gid) throw conflict('name_taken', 'A guild with that name already exists');
      try {
        await addMember(gid, me, 'owner');
      } catch (e) {
        await store.deleteGuild(gid);
        throw e;
      }
      return reply(201, { guild: guildOut({ ...doc, _id: gid }, { rank: 'owner', memberCount: 1 }) });
    },

    // ----- admin (server owner only; off unless ADMIN_KEY is set) -----

    // Lets a player who lost their key file enable guilds again: their next register sets a new key.
    // Guild memberships and anything waiting on the marketplace are kept.
    async adminResetPlayer(ctx) {
      const { steamId, player } = await adminPlayer(ctx);
      await store.resetPlayerKey(steamId);
      return { ok: true, player: { id: steamId, name: player.name } };
    },

    // Locks a player out and removes what others can see of them: guild memberships, chat messages,
    // marketplace listings and offers, requests and invites. Guilds they own are left for delete-guild.
    async adminBan(ctx) {
      const { steamId, player } = await adminPlayer(ctx);
      await store.setBanned(steamId, true);
      await market.closeListings({ sellerId: steamId }, 'cancelled');
      const owned = (await store.membershipsOf(steamId)).filter((m) => m.guild.ownerId === steamId).map((m) => m.guild);
      await store.purgePlayerChildren(steamId);
      // Keep them on the roster of guilds they own, so those guilds stay consistent until they are dealt with.
      for (const g of owned) await store.insertMember({ guildId: g._id, playerId: steamId, rank: 'owner', joinedAt: new Date(now()) });
      return { ok: true, player: { id: steamId, name: player.name }, ownedGuilds: owned.map((g) => ({ id: String(g._id), name: g.name })) };
    },

    async adminUnban(ctx) {
      const { steamId, player } = await adminPlayer(ctx);
      await store.setBanned(steamId, false);
      return { ok: true, player: { id: steamId, name: player.name } };
    },

    // Removes a guild by exact name (any capitalisation) or id, the same way its owner disbanding it would:
    // listed items go back to their sellers.
    async adminDeleteGuild(ctx) {
      await adminAuth(ctx);
      const { name, id } = ctx.body;
      const guild = typeof id === 'string' ? await store.getGuild(vGuildId(id))
        : typeof name === 'string' ? await store.getGuildByName(name.trim().toLowerCase())
        : null;
      if (!guild) throw notFound('guild_not_found', 'Guild not found');
      await market.closeListings({ guildId: guild._id }, 'guild_disbanded');
      await store.purgeGuildChildren(guild._id);
      await store.deleteGuild(guild._id);
      await store.purgeGuildChildren(guild._id, { withMessages: false });
      return { ok: true, guild: { id: String(guild._id), name: guild.name, ownerId: guild.ownerId } };
    },

    // How many players there are and how recently they were seen, and whether new ones can still register.
    async adminStats(ctx) {
      await adminAuth(ctx);
      const t = now();
      const since = (msAgo) => store.countPlayers({ banned: { $ne: true }, lastSeen: { $gte: new Date(t - msAgo) } });
      const [testers, players, banned, online, day, week, guilds] = await Promise.all([
        store.countPlayers({ banned: { $ne: true }, testers: true }),
        store.countPlayers({ banned: { $ne: true } }),
        store.countPlayers({ banned: true }),
        since(5 * 60_000),
        since(24 * 60 * 60_000),
        since(7 * 24 * 60 * 60_000),
        store.countGuilds(),
      ]);
      const registration = maxPlayers > 0 && players >= maxPlayers ? 'full' : registerCodes.length ? 'code' : 'open';
      return { players, banned, online, day, week, guilds, testers, maxPlayers: maxPlayers || null, registration };
    },

    // Finds players by part of their name, or one player by Steam ID, with the guilds they are in.
    async adminFindPlayer(ctx) {
      await adminAuth(ctx);
      const q = typeof ctx.body.q === 'string' ? ctx.body.q.trim() : '';
      if (len(q) < 2 || len(q) > 32) throw bad('invalid_query', 'q must be 2 to 32 characters');
      const found = /^\d{17}$/.test(q) ? [await store.getPlayer(q)].filter(Boolean) : await store.findPlayersByName(q, 20);
      const players = [];
      for (const p of found) {
        const guilds = (await store.membershipsOf(p._id)).map(({ member, guild }) => ({ id: String(guild._id), name: guild.name, rank: rankOf(guild, member) }));
        players.push({ id: p._id, name: p.name, banned: p.banned === true, lastSeen: ms(p.lastSeen), guilds });
      }
      return { players };
    },

    async searchGuilds({ query }) {
      const q = (query.get('q') ?? '').trim().toLowerCase();
      if (len(q) > 24) throw bad('invalid_query', 'q must be at most 24 characters');
      const found = await store.searchGuilds(q, L.searchResults);
      return { guilds: found.map(({ guild, memberCount }) => ({ ...guildOut(guild, { memberCount }), ownerId: undefined })) };
    },

    async getGuild({ me, params }) {
      const ctx = await guildCtx(params.id, me);
      const staff = ctx.rank === 'owner' || ctx.rank === 'officer';
      const [roster, pending, mine] = await Promise.all([
        ctx.rank ? store.rosters([ctx.gid]) : null,
        staff ? store.listRequests(ctx.gid) : null,
        ctx.rank ? null : store.getRequest(ctx.gid, me),
      ]);
      const out = {
        guild: guildOut(ctx.guild, {
          memberCount: roster ? roster.length : await store.countMembers(ctx.gid),
          myRank: ctx.rank,
          myPending: mine?.kind ?? null,
        }),
        // Who is in a guild (names and Steam IDs) is only shown to its members.
        members: roster ? sortMembers(roster.map((m) => memberOut(ctx.guild, m, true))) : [],
      };
      // The owner's Steam ID is not for outsiders either.
      if (!ctx.rank) delete out.guild.ownerId;
      if (pending) {
        const row = (r) => ({ playerId: r.playerId, name: r.name, by: r.by, at: ms(r.at) });
        out.requests = pending.filter((r) => r.kind === 'request').map(row);
        out.invites = pending.filter((r) => r.kind === 'invite').map(row);
      }
      return out;
    },

    async patchGuild({ me, params, body }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner');
      const set = {};
      if (body.name !== undefined) {
        set.name = vGuildName(body.name);
        set.nameLower = set.name.toLowerCase();
      }
      if (body.description !== undefined) set.description = vDescription(body.description);
      if (!Object.keys(set).length) throw bad('nothing_to_update', 'Send name and/or description');
      const r = await store.updateGuild(ctx.gid, set);
      if (r === 'dup') throw conflict('name_taken', 'A guild with that name already exists');
      if (r === 'missing') throw notFound('guild_not_found', 'Guild not found');
      return { guild: guildOut({ ...ctx.guild, ...set }, { rank: 'owner' }) };
    },

    async disband({ me, params }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner');
      await market.closeListings({ guildId: ctx.gid }, 'guild_disbanded');
      // Children first so a failure part-way leaves a guild the owner can disband again;
      // the second sweep catches a join that slipped in while we were deleting.
      await store.purgeGuildChildren(ctx.gid);
      await store.deleteGuild(ctx.gid);
      await store.purgeGuildChildren(ctx.gid, { withMessages: false });
      return { ok: true };
    },

    async join({ me, params }) {
      const ctx = await guildCtx(params.id, me);
      if (ctx.member) throw conflict('already_member', 'You are already a member of this guild');
      const existing = await store.getRequest(ctx.gid, me);
      if (existing?.kind === 'invite') {
        // Both sides agree: an invite plus a join is a join.
        await addMember(ctx.gid, me, 'member');
        await store.deleteRequest(ctx.gid, me);
        return { joined: true, requested: false };
      }
      if (existing) return { joined: false, requested: true };

      const [mine, total, myPending, guildPending] = await Promise.all([
        store.countGuildsOf(me),
        store.countMembers(ctx.gid),
        store.countRequestsOf(me, 'request'),
        store.countRequestsFor(ctx.gid),
      ]);
      if (mine >= L.maxGuildsPerPlayer) throw conflict('guild_limit', `You can be in at most ${L.maxGuildsPerPlayer} guilds`);
      if (total >= L.maxMembersPerGuild) throw conflict('guild_full', `This guild already has ${L.maxMembersPerGuild} members`);
      if (myPending >= L.maxJoinRequestsPerPlayer) throw conflict('too_many_pending', 'You have too many pending join requests');
      if (guildPending >= L.maxPendingPerGuild) throw conflict('too_many_pending', 'This guild has too many pending requests');
      await store.insertRequest({ guildId: ctx.gid, playerId: me, kind: 'request', by: me, at: new Date(now()) });
      return reply(201, { joined: false, requested: true });
    },

    async cancelJoin({ me, params }) {
      await store.deleteRequest(vGuildId(params.id), me, 'request');
      return { ok: true };
    },

    async invite({ me, params, body }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner', 'officer');
      const target = vSteamId(body.steamId);
      if (target === me) throw bad('invalid_target', 'You cannot invite yourself');
      const [player, member, existing] = await Promise.all([
        store.getPlayer(target),
        store.getMember(ctx.gid, target),
        store.getRequest(ctx.gid, target),
      ]);
      if (!player) throw notFound('player_not_found', 'That player has not used the guild mod yet');
      if (member) throw conflict('already_member', 'That player is already a member of this guild');
      if (existing?.kind === 'request') {
        await addMember(ctx.gid, target, 'member');
        await store.deleteRequest(ctx.gid, target);
        return { joined: true, invited: false };
      }
      if (existing) return { joined: false, invited: true };

      const [total, theirInvites, guildPending] = await Promise.all([
        store.countMembers(ctx.gid),
        store.countRequestsOf(target, 'invite'),
        store.countRequestsFor(ctx.gid),
      ]);
      if (total >= L.maxMembersPerGuild) throw conflict('guild_full', `This guild already has ${L.maxMembersPerGuild} members`);
      if (theirInvites >= L.maxInvitesPerPlayer) throw conflict('too_many_pending', 'That player has too many pending invites');
      if (guildPending >= L.maxPendingPerGuild) throw conflict('too_many_pending', 'This guild has too many pending requests');
      await store.insertRequest({ guildId: ctx.gid, playerId: target, kind: 'invite', by: me, at: new Date(now()) });
      return reply(201, { joined: false, invited: true });
    },

    // Officer/owner answers a join request; accept=false also cancels an outstanding invite.
    async answerRequest({ me, params, body }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner', 'officer');
      if (typeof body.accept !== 'boolean') throw bad('invalid_body', 'accept must be true or false');
      const target = vSteamId(params.playerId, 'playerId');
      const req = await store.getRequest(ctx.gid, target);
      if (!req) throw notFound('request_not_found', 'No pending request for that player');
      if (body.accept) {
        if (req.kind !== 'request') throw conflict('not_a_join_request', 'Only the invited player can accept an invite');
        await addMember(ctx.gid, target, 'member');
      }
      await store.deleteRequest(ctx.gid, target);
      return { ok: true, joined: body.accept };
    },

    async answerInvite({ me, params, body }) {
      if (typeof body.accept !== 'boolean') throw bad('invalid_body', 'accept must be true or false');
      const gid = vGuildId(params.guildId);
      const [req, guild] = await Promise.all([store.getRequest(gid, me), store.getGuild(gid)]);
      if (!req || req.kind !== 'invite' || !guild) {
        if (req && !guild) await store.deleteRequest(gid, me);
        throw notFound('invite_not_found', 'You have no invite from that guild');
      }
      if (body.accept) await addMember(gid, me, 'member');
      await store.deleteRequest(gid, me);
      return { ok: true, joined: body.accept };
    },

    async leave({ me, params }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner', 'officer', 'member');
      if (ctx.rank === 'owner') throw conflict('owner_cannot_leave', 'Transfer ownership or disband the guild first');
      await store.deleteMember(ctx.gid, me);
      await market.closeListings({ guildId: ctx.gid, sellerId: me }, 'left_guild');
      await store.deleteOffers({ guildId: ctx.gid, buyerId: me });
      return { ok: true };
    },

    async kick({ me, params }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner', 'officer');
      const t = await targetMember(ctx, params.playerId, me, 'Use leave to remove yourself');
      if (t.rank === 'owner') throw forbidden('The owner cannot be kicked');
      if (ctx.rank === 'officer' && t.rank !== 'member') throw forbidden('Officers can only kick members');
      await store.deleteMember(ctx.gid, t.target);
      await market.closeListings({ guildId: ctx.gid, sellerId: t.target }, 'left_guild');
      await store.deleteOffers({ guildId: ctx.gid, buyerId: t.target });
      return { ok: true };
    },

    async setRank({ me, params, body }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner');
      if (body.rank !== 'officer' && body.rank !== 'member') throw bad('invalid_rank', 'rank must be "officer" or "member"');
      const t = await targetMember(ctx, params.playerId, me, 'Use transfer to change your own rank');
      await store.setRank(ctx.gid, t.target, body.rank);
      return { ok: true, playerId: t.target, rank: body.rank };
    },

    async transfer({ me, params, body }) {
      const ctx = await guildCtx(params.id, me);
      requireRank(ctx, 'owner');
      const t = await targetMember(ctx, body.playerId, me, 'You already own this guild');
      // The ownerId swap is the transfer; the rank fields are then brought in line.
      if (!(await store.setOwner(ctx.gid, me, t.target))) throw conflict('conflict', 'Ownership changed, try again');
      await Promise.all([store.setRank(ctx.gid, t.target, 'owner'), store.setRank(ctx.gid, me, 'officer')]);
      return { ok: true, ownerId: t.target };
    },

    async postMessage({ me, player, params, body }) {
      const ctx = await guildCtx(params.id, me);
      if (!ctx.member) throw new HttpError(403, 'not_member', 'You are not a member of this guild');
      const text = vMessageBody(body.body);
      await rate(me, 'message');
      const doc = { guildId: ctx.gid, playerId: me, name: player.name, body: text, at: new Date(now()) };
      const id = await store.insertMessage(doc);
      return reply(201, { message: messageOut({ ...doc, _id: id }) });
    },

    // Opt in to, or out of, the tester chat: one channel for everyone who wants to talk about the mod.
    async setTesters({ me, body }) {
      if (typeof body.on !== 'boolean') throw bad('invalid_body', '"on" must be true or false');
      await store.setTesters(me, body.on);
      return { testers: body.on };
    },

    async postTesterMessage({ me, player, body }) {
      if (player.testers !== true) throw new HttpError(403, 'not_tester', 'Join the tester chat first');
      const text = vMessageBody(body.body);
      await rate(me, 'message');
      const doc = { guildId: TESTERS_ID, playerId: me, name: player.name, body: text, at: new Date(now()) };
      const id = await store.insertMessage(doc);
      return reply(201, { message: messageOut({ ...doc, _id: id }) });
    },

    async history({ me, params }) {
      const ctx = await guildCtx(params.id, me);
      if (!ctx.member) throw new HttpError(403, 'not_member', 'You are not a member of this guild');
      const rows = await store.latestMessages([ctx.gid], L.historyMessages);
      return { messages: rows.map(messageOut) };
    },
  };

  // ----- routes -----
  const routes = [
    ['POST', 'register', h.register, { auth: false }],
    ['POST', 'sync', h.sync, { auth: false }], // does its own auth + rate limit
    // These check X-Admin-Key themselves.
    ['POST', 'admin/reset-player', h.adminResetPlayer, { auth: false }],
    ['POST', 'admin/ban', h.adminBan, { auth: false }],
    ['POST', 'admin/unban', h.adminUnban, { auth: false }],
    ['POST', 'admin/delete-guild', h.adminDeleteGuild, { auth: false }],
    ['POST', 'admin/find-player', h.adminFindPlayer, { auth: false }],
    ['POST', 'admin/stats', h.adminStats, { auth: false }],
    ['GET', 'me', h.me],
    ['POST', 'testers', h.setTesters],
    ['POST', 'testers/messages', h.postTesterMessage],
    ['DELETE', 'me', h.deleteMe],
    ['PUT', 'me/profile', h.putProfile],
    ['GET', 'players/:id/profile', h.getProfile],
    ['POST', 'guilds', h.createGuild],
    ['GET', 'guilds/search', h.searchGuilds],
    ['GET', 'guilds/:id', h.getGuild],
    ['PATCH', 'guilds/:id', h.patchGuild],
    ['DELETE', 'guilds/:id', h.disband],
    ['POST', 'guilds/:id/join', h.join],
    ['DELETE', 'guilds/:id/join', h.cancelJoin],
    ['POST', 'guilds/:id/invite', h.invite],
    ['POST', 'guilds/:id/requests/:playerId', h.answerRequest],
    ['POST', 'invites/:guildId', h.answerInvite],
    ['POST', 'guilds/:id/leave', h.leave],
    ['DELETE', 'guilds/:id/members/:playerId', h.kick],
    ['POST', 'guilds/:id/members/:playerId/rank', h.setRank],
    ['POST', 'guilds/:id/transfer', h.transfer],
    ['POST', 'guilds/:id/messages', h.postMessage],
    ['GET', 'guilds/:id/messages', h.history],
    ...market.routes,
    ...grounds.routes,
  ].map(([method, pattern, fn, opts]) => ({ method, parts: pattern.split('/'), fn, auth: opts?.auth !== false }));

  function match(method, segs) {
    let pathMatched = false;
    for (const r of routes) {
      if (r.parts.length !== segs.length) continue;
      const params = {};
      if (!r.parts.every((p, i) => (p[0] === ':' ? ((params[p.slice(1)] = segs[i]), true) : p === segs[i]))) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params };
    }
    throw pathMatched
      ? new HttpError(405, 'method_not_allowed', `${method} is not supported on this path`)
      : notFound('not_found', 'No such endpoint');
  }

  /**
   * @param {{method: string, path: string, query?: URLSearchParams, headers?: Record<string,string>, body?: object, ip?: string}} req
   *   headers must use lower-case names.
   * @returns {Promise<{status: number, body: object}>}
   */
  async function handle(req) {
    const ip = req.ip || 'unknown';
    try {
      const headers = req.headers ?? {};
      if ((failWindow(ip)?.n ?? 0) >= L.rate.authFail[0]) {
        throw new HttpError(429, 'rate_limited', 'Too many requests with a wrong key. Wait a minute and try again.');
      }
      const proto = headers['x-mod-protocol'];
      if (!/^\d{1,6}$/.test(proto ?? '') || Number(proto) < PROTOCOL) {
        throw new HttpError(426, 'upgrade_required', `This server needs mod protocol ${PROTOCOL} or newer (header X-Mod-Protocol). Update the mod.`);
      }
      const segs = req.path.split('/').filter(Boolean);
      const { route, params } = match(req.method, segs);
      const ctx = {
        params,
        headers,
        query: req.query ?? new URLSearchParams(),
        body: req.body ?? {},
        ip,
      };
      if (route.auth) {
        const { steamId, keyHash } = parseAuth(headers);
        const player = await store.getPlayer(steamId);
        if (!player || !sameHash(player.keyHash, keyHash)) throw unknownCaller();
        if (player.banned) throw banned();
        ctx.me = steamId;
        ctx.player = player;
        await rate(steamId, req.method === 'GET' ? 'read' : 'write');
      }
      const out = await route.fn(ctx);
      return out && typeof out.status === 'number' && out.body ? out : { status: 200, body: out };
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 401) noteAuthFail(ip);
        return { status: e.status, body: { error: { code: e.code, message: e.message } } };
      }
      throw e;
    }
  }

  return { handle };
}
