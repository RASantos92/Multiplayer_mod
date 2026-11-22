// Web-standard Request -> Response adapter around app.handle().
import { PROTOCOL } from './app.js';

export const MAX_BODY_BYTES = 4096;
export const MAX_PROFILE_BODY_BYTES = 16 * 1024;
/** Profile uploads are the one route with a larger body cap. */
const bodyLimit = (method, path) => (method === 'PUT' && path === 'me/profile' ? MAX_PROFILE_BODY_BYTES : MAX_BODY_BYTES);

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const error = (status, code, message) => json(status, { error: { code, message } });

/** Reads at most `limit` bytes; returns null when the body is larger. */
async function readBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) return null;
  if (!request.body) return '';
  const chunks = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {() => Promise<{handle: Function, ping?: Function}>} getApp resolves the app (connects to the database on first use)
 */
export function createFetchHandler(getApp) {
  return async function handler(request) {
    try {
      const url = new URL(request.url);
      // vercel.json rewrites everything to /api?__path=<original path>. Depending on the
      // platform the function may see either the original URL or the rewritten one, so
      // accept both.
      const raw = url.searchParams.get('__path') ?? url.pathname;
      const segs = raw.split('/').filter(Boolean);
      if (segs[0] === 'api') segs.shift();
      const path = segs.join('/');
      const method = request.method.toUpperCase();

      if (method === 'GET' && (path === '' || path === 'health')) {
        const out = { ok: true, service: 'melvor2-guild-api', protocol: PROTOCOL };
        if (url.searchParams.get('db') === '1') {
          try {
            await (await getApp()).ping();
            out.db = true;
          } catch (e) {
            console.error('db check failed:', e?.name, e?.message);
            return error(503, 'database_unavailable', 'Cannot reach MongoDB. Check MONGODB_URI in Vercel and Network Access in Atlas.');
          }
        }
        return json(200, out);
      }

      let body = {};
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        const limit = bodyLimit(method, path);
        const text = await readBody(request, limit);
        if (text === null) return error(413, 'body_too_large', `Request body must be at most ${limit} bytes`);
        if (text.trim() !== '') {
          try {
            body = JSON.parse(text);
          } catch {
            return error(400, 'invalid_json', 'Request body is not valid JSON');
          }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return error(400, 'invalid_json', 'Request body must be a JSON object');
          }
        }
      }

      let app;
      try {
        app = await getApp();
      } catch (e) {
        console.error('database unavailable:', e?.name, e?.message);
        return error(503, 'database_unavailable', 'The guild server cannot reach its database right now');
      }

      const res = await app.handle({
        method,
        path,
        query: url.searchParams,
        headers: Object.fromEntries(request.headers),
        body,
        ip: (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim(),
      });
      return json(res.status, res.body);
    } catch (e) {
      console.error('unhandled:', e?.name, e?.message);
      return error(500, 'internal', 'Internal server error');
    }
  };
}
