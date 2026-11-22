// The single Vercel function. vercel.json rewrites every path here; routing
// happens in src/app.js.
import { createApp } from '../src/app.js';
import { getStore } from '../src/db.js';
import { createFetchHandler } from '../src/http.js';

const handler = createFetchHandler(async () => {
  const store = await getStore(); // cached per warm instance
  return { handle: createApp({ store }).handle, ping: store.ping };
});

export default { fetch: handler };
