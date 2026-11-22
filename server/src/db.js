// Cached MongoDB client, reused across invocations of a warm function instance.
// The connection string comes only from the environment; it is never logged.
import { MongoClient } from 'mongodb';
import { createStore } from './store.js';

let storePromise;

export function getStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('MONGODB_URI is not set');
      const client = new MongoClient(uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 8000,
        appName: 'melvor2-guild-api',
      });
      await client.connect();
      const store = createStore(client.db(process.env.MONGODB_DB || 'melvor2guilds'));
      await store.init();
      return store;
    })();
    // A failed connect must not poison the instance; retry on the next request.
    storePromise.catch(() => {
      storePromise = undefined;
    });
  }
  return storePromise;
}
