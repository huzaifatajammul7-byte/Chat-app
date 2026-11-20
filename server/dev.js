// Local API server (npm run dev). Online (Railway) server/start.js is used instead.
import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import app from './app.js';
import { connectDB } from './db.js';
import { attachSocket } from './realtime.js';

const NEED = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
const EXAMPLE = { MONGODB_URI: 'USER:PASSWORD', JWT_SECRET: 'change-this', ADMIN_EMAIL: 'your-admin@', ADMIN_PASSWORD: 'choose-a-strong' };

if (!fs.existsSync('.env')) {
  console.warn(`\n⚠  No .env file found in ${process.cwd()}\n   Copy .env.example to .env (same folder as package.json) and fill in your values.\n`);
}
const missing = NEED.filter((k) => !process.env[k]);
if (missing.length) console.warn('⚠  Missing in .env: ' + missing.join(', '));
for (const k of NEED) {
  if (process.env[k] && process.env[k].includes(EXAMPLE[k])) console.warn(`⚠  ${k} still has the example value. Put your real value there.`);
}

process.on('unhandledRejection', (e) => console.error('Unhandled error:', e));

// Always 3000 locally: the Vite dev server proxies /api to this port.
const port = Number(process.env.API_PORT) || 3000;
const server = http.createServer(app);
attachSocket(server, ['*']);
server.listen(port, () => {
  console.log(`API + Socket.io running on http://localhost:${port}`);
  checkDb();
});

async function checkDb() {
  if (!process.env.MONGODB_URI) return;
  try {
    await connectDB();
    console.log('✓ MongoDB connected');
  } catch (e) {
    console.error('✗ MongoDB connection failed: ' + e.message);
    if (/querySrv|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(e.message)) {
      console.error('  Your network blocks the mongodb+srv lookup. In Atlas: Database -> Connect -> Drivers, choose Node.js');
      console.error('  version "2.2.12 or later" and use that long mongodb://... string as MONGODB_URI (or try a mobile hotspot).');
    } else if (/bad auth|authentication failed/i.test(e.message)) {
      console.error('  Wrong MongoDB username/password in MONGODB_URI (special characters like @ # / in the password break it).');
    } else if (/timed out|selection|whitelist|not authorized to access/i.test(e.message)) {
      console.error('  In Atlas -> Network Access, add 0.0.0.0/0 (Allow access from anywhere).');
    }
  }
}
