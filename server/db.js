import dns from 'node:dns';
import mongoose from 'mongoose';

// Public DNS so mongodb+srv works even on networks that block SRV lookups.
// Only on your own computer: hosting providers have working DNS and should not be overridden.
const e = process.env;
const HOSTED = !!(e.RAILWAY_ENVIRONMENT || e.RAILWAY_PROJECT_ID || e.VERCEL || e.NODE_ENV === 'production');
if (!HOSTED) { try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch {} }

// Serverless functions are reused between requests, so keep ONE cached connection.
const cache = globalThis.__mongo || (globalThis.__mongo = { conn: null, promise: null });

export async function connectDB() {
  if (cache.conn) return cache.conn;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
  if (!cache.promise) {
    cache.promise = mongoose
      .connect(process.env.MONGODB_URI, { bufferCommands: false, maxPoolSize: 5, serverSelectionTimeoutMS: 8000 })
      .catch((e) => {
        cache.promise = null;
        throw e;
      });
  }
  cache.conn = await cache.promise;
  return cache.conn;
}
