// Production entry for Railway: one process = backend API + the built website (dist/) as static files.
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import app from './app.js';
import { connectDB } from './db.js';
import { attachSocket } from './realtime.js';

const NEED = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
const missing = NEED.filter((k) => !process.env[k]);
if (missing.length) console.warn('⚠  Missing environment variables: ' + missing.join(', '));
if (!fs.existsSync(fileURLToPath(new URL('../dist', import.meta.url)))) {
  console.warn('⚠  The website is not built yet (dist/ folder missing). The build command must run "npm run build".');
}

process.on('unhandledRejection', (e) => console.error('Unhandled error:', e));

const port = Number(process.env.PORT) || 3000;
const server = http.createServer(app);
attachSocket(server, ['*']); // Socket.io (same server, same port as the website)
server.listen(port, '0.0.0.0', () => console.log(`Chat running on port ${port} (website + API + Socket.io)`));

// Check the database right away so problems show up in the Railway logs.
connectDB()
  .then(() => console.log('✓ MongoDB connected'))
  .catch((e) => {
    console.error('✗ MongoDB connection failed: ' + e.message);
    if (/querySrv|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(e.message)) console.error('  The mongodb+srv address could not be resolved. Use the standard mongodb:// string from Atlas (Node.js 2.2.12 or later).');
    else if (/bad auth|authentication failed/i.test(e.message)) console.error('  Wrong MongoDB username/password in MONGODB_URI.');
    else console.error('  In Atlas -> Network Access, add 0.0.0.0/0 (Allow access from anywhere).');
  });

// Once an hour: remove abandoned (never sent) uploads.
setInterval(() => {
  const headers = process.env.CRON_SECRET ? { Authorization: 'Bearer ' + process.env.CRON_SECRET } : {};
  fetch(`http://127.0.0.1:${port}/api/cron/cleanup`, { headers }).catch(() => {});
}, 60 * 60 * 1000).unref();
