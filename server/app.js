import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDB } from './db.js';
import { User, Message, FileDoc, FileChunk, Attempt } from './models.js';
import { publish, isOnline, onlineSet, disconnectUser } from './realtime.js';

const env = process.env;
// Locally we show the real error reason in the response; when hosted (Railway etc.) we never leak details.
// Set SHOW_ERRORS=1 temporarily to see the real reason online, then remove it.
const HOSTED = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.VERCEL || env.NODE_ENV === 'production');
const DEV = env.SHOW_ERRORS === '1' || !HOSTED;
const JWT_SECRET = env.JWT_SECRET;
const ADMIN_EMAIL = (env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
const MAX_UPLOAD_MB = Number(env.MAX_UPLOAD_MB) || 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const CHUNK = 3 * 1024 * 1024; // uploads are sent in 3 MB parts
const MAX_RANGE = 8 * 1024 * 1024; // max bytes per ranged download response
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
// Only these types are shown inline; everything else is forced to download (blocks HTML/SVG tricks).
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime|ogg)|audio\/(mpeg|ogg|wav|webm|mp4|aac|x-m4a))$/;
const kindOf = (mime) => (INLINE_MIME.test(mime) ? mime.split('/')[0] : 'file');
const isId = (s) => mongoose.isValidObjectId(s);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Static hosting: the built website (npm run build -> dist/) is served by this same server.
// It comes BEFORE the database check, so the pages open even if the database is down.
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
if (fs.existsSync(DIST)) {
  app.use('/assets', express.static(DIST + '/assets', { maxAge: '1y', immutable: true })); // hashed file names
  app.use(express.static(DIST, { extensions: ['html'] })); // /chat -> chat.html, /admin -> admin.html
}

/* ---------- helpers ---------- */
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const sign = (payload, exp = '30d') => jwt.sign(payload, JWT_SECRET, { expiresIn: exp });
const pub = (u, online = false) => ({
  id: String(u._id), name: u.name, avatar: u.avatar, about: u.about, lastSeen: u.lastSeen, online,
});
const mine = (u) => ({ ...pub(u), email: u.email, role: u.role === 'admin' ? 'admin' : 'user' });
const adminMe = () => ({ id: 'admin', name: 'Admin', email: ADMIN_EMAIL, avatar: '', about: '', online: false, role: 'admin' });
const msgOut = (m) => ({
  id: String(m._id),
  from: String(m.from),
  to: String(m.to),
  text: m.text || '',
  status: m.status,
  createdAt: m.createdAt,
  edited: !!m.edited,
  deleted: !!m.deleted,
  attachment:
    m.attachment && m.attachment.id
      ? { id: String(m.attachment.id), name: m.attachment.name, mime: m.attachment.mime, size: m.attachment.size, kind: m.attachment.kind }
      : null,
  reply: m.reply && m.reply.id ? { id: String(m.reply.id), from: String(m.reply.from), text: m.reply.text || '', kind: m.reply.kind || 'text', name: m.reply.name || '' } : null,
  reactions: (m.reactions || []).map((r) => ({ user: String(r.user), emoji: r.emoji })),
});
const cleanName = (s) => {
  let n = 'file';
  try { n = decodeURIComponent(String(s || 'file')); } catch { n = String(s || 'file'); }
  return n.replace(/[\\/\0]/g, '_').split('/').pop().slice(0, 120) || 'file';
};
const removeFiles = async (ids) => {
  if (!ids.length) return;
  await Promise.all([FileChunk.deleteMany({ file: { $in: ids } }), FileDoc.deleteMany({ _id: { $in: ids } })]);
};
const ice = () => {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (env.TURN_URLS) {
    list.push({
      urls: env.TURN_URLS.split(',').map((x) => x.trim()).filter(Boolean),
      username: env.TURN_USERNAME || '',
      credential: env.TURN_CREDENTIAL || '',
    });
  }
  return list;
};

const limiter = (max, minutes) => async (req, res, next) => {
  try {
    const key = req.ip + req.path;
    const since = new Date(Date.now() - minutes * 60000);
    if ((await Attempt.countDocuments({ key, createdAt: { $gt: since } })) >= max)
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    await Attempt.create({ key });
    next();
  } catch (e) {
    next(e);
  }
};

async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const p = jwt.verify(token, JWT_SECRET);
    if (p.scope) throw new Error('scoped token');
    if (p.admin) {
      req.admin = true;
      req.user = { _id: 'admin', role: 'admin', name: 'Admin', email: ADMIN_EMAIL };
      return next();
    }
    const user = await User.findById(p.id);
    if (!user) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
}
const userOnly = (req, res, next) => (req.admin ? res.status(403).json({ error: 'Not allowed' }) : next());
const adminOnly = (req, res, next) => (req.admin ? next() : res.status(403).json({ error: 'Not allowed' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- health (works even when config is missing) ---------- */
app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    config: {
      MONGODB_URI: !!env.MONGODB_URI,
      JWT_SECRET: !!env.JWT_SECRET,
      ADMIN_EMAIL: !!env.ADMIN_EMAIL,
      ADMIN_PASSWORD: !!env.ADMIN_PASSWORD,
    },
  })
);

app.use(async (req, res, next) => {
  if (!JWT_SECRET) return res.status(500).json({ error: 'Server is not configured: JWT_SECRET is missing.' });
  try {
    await connectDB();
    next();
  } catch (e) {
    console.error('DB connection failed:', e.message);
    res.status(500).json({ error: 'Could not connect to the database.' + (DEV ? ' (' + e.message + ')' : '') });
  }
});

/* ---------- auth ---------- */
app.post('/api/signup', limiter(10, 10), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Name must be 2–40 characters.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if ((ADMIN_EMAIL && email === ADMIN_EMAIL) || (await User.findOne({ email })))
    return res.status(409).json({ error: 'This email is already registered.' });
  const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 10) });
  await publish('global', 'user:new', pub(user));
  res.json({ token: sign({ id: String(user._id) }), user: mine(user) });
}));

app.post('/api/login', limiter(15, 10), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  // The hidden admin lives only in environment variables, never in the database.
  if (ADMIN_EMAIL && ADMIN_PASSWORD && email === ADMIN_EMAIL) {
    if (!safeEqual(password, ADMIN_PASSWORD)) return res.status(400).json({ error: 'Wrong email or password.' });
    return res.json({ token: sign({ admin: true }, '12h'), user: adminMe() });
  }
  const user = await User.findOne({ email });
  if (!user || user.role === 'admin' || !(await bcrypt.compare(password, user.passwordHash)))
    return res.status(400).json({ error: 'Wrong email or password.' });
  res.json({ token: sign({ id: String(user._id) }), user: mine(user) });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: req.admin ? adminMe() : mine(req.user) }));

app.put('/api/me', auth, userOnly, wrap(async (req, res) => {
  const u = req.user;
  const name = String(req.body.name ?? u.name).trim();
  const about = String(req.body.about ?? u.about).trim().slice(0, 120);
  const avatar = String(req.body.avatar ?? '');
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Name must be 2–40 characters.' });
  if (avatar && (avatar.length > 300000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)))
    return res.status(400).json({ error: 'Invalid or too large image.' });
  u.name = name; u.about = about; u.avatar = avatar;
  await u.save();
  await publish('global', 'user:update', pub(u, true));
  res.json({ user: mine(u) });
}));

app.get('/api/config', auth, userOnly, (req, res) =>
  res.json({ iceServers: ice(), maxUploadMB: MAX_UPLOAD_MB, reactions: REACTIONS, chunkSize: CHUNK, serverNow: Date.now() })
);

// Short-lived token that can ONLY open files (used in <img>/<video> URLs).
app.get('/api/file-token', auth, userOnly, (req, res) =>
  res.json({ token: sign({ id: String(req.user._id), scope: 'file' }, '12h') })
);

/* ---------- chat ---------- */
app.get('/api/users', auth, userOnly, wrap(async (req, res) => {
  const meId = req.user._id;
  const [users, summary, online] = await Promise.all([
    User.find({ _id: { $ne: meId }, role: { $ne: 'admin' } }),
    Message.aggregate([
      { $match: { $or: [{ from: meId }, { to: meId }] } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { $cond: [{ $eq: ['$from', meId] }, '$to', '$from'] },
          last: { $first: '$$ROOT' },
          unread: { $sum: { $cond: [{ $and: [{ $eq: ['$to', meId] }, { $ne: ['$status', 'read'] }] }, 1, 0] } },
        },
      },
    ]),
    onlineSet(),
  ]);
  const map = new Map(summary.map((s) => [String(s._id), s]));
  res.json({
    users: users.map((u) => {
      const s = map.get(String(u._id));
      return { ...pub(u, online.has(String(u._id))), lastMessage: s ? msgOut(s.last) : null, unread: s ? s.unread : 0 };
    }),
  });
}));

app.get('/api/messages/:id', auth, userOnly, wrap(async (req, res) => {
  const peer = req.params.id;
  if (!isId(peer)) return res.status(400).json({ error: 'Invalid user.' });
  const me = req.user._id;
  const r = await Message.updateMany({ from: peer, to: me, status: { $ne: 'read' } }, { status: 'read' });
  if (r.modifiedCount) await publish('u:' + peer, 'messages:read', { by: String(me) });
  const list = await Message.find({ $or: [{ from: me, to: peer }, { from: peer, to: me }] })
    .sort({ createdAt: -1 })
    .limit(500);
  res.json({ messages: list.reverse().map(msgOut) });
}));

app.post('/api/messages', auth, userOnly, wrap(async (req, res) => {
  const uid = String(req.user._id);
  const to = String(req.body.to || '');
  const text = String(req.body.text || '').trim().slice(0, 2000);
  const aid = req.body.attachment?.id ? String(req.body.attachment.id) : '';
  if (!isId(to) || to === uid || (!text && !aid)) return res.status(400).json({ error: 'Invalid message.' });
  const [peer, peerOnline] = await Promise.all([User.findOne({ _id: to, role: { $ne: 'admin' } }).select('_id'), isOnline(to)]);
  if (!peer) return res.status(404).json({ error: 'This user no longer exists.' });

  let attachment;
  if (aid) {
    if (!isId(aid)) return res.status(400).json({ error: 'Invalid file.' });
    // Claim the uploaded file (must be mine, fully uploaded, not already used).
    const f = await FileDoc.findOneAndUpdate({ _id: aid, owner: uid, ready: true, attached: false }, { attached: true });
    if (!f) return res.status(400).json({ error: 'File not found. Please upload it again.' });
    attachment = { id: f._id, name: f.name, mime: f.mime, size: f.size, kind: f.kind };
  }

  // Reply: store a small snapshot of the original (it must belong to this same conversation).
  let reply;
  const rid = String(req.body.replyTo || '');
  if (rid && isId(rid)) {
    const orig = await Message.findOne({ _id: rid, $or: [{ from: uid, to }, { from: to, to: uid }] });
    if (orig && !orig.deleted) {
      reply = { id: orig._id, from: orig.from, text: (orig.text || '').slice(0, 120), kind: orig.attachment?.kind || 'text', name: orig.attachment?.name || '' };
    }
  }

  const m = await Message.create({ from: uid, to, text, attachment, reply, status: peerOnline ? 'delivered' : 'sent' });
  const out = msgOut(m);
  await Promise.all([
    publish('u:' + to, 'message:new', { message: out }),
    publish('u:' + uid, 'message:new', { message: out, origin: req.headers['x-tab'] || '' }), // my other tabs
  ]);
  res.json({ message: out });
}));

const broadcastUpdate = (m) =>
  Promise.all([publish('u:' + m.from, 'message:update', { message: msgOut(m) }), publish('u:' + m.to, 'message:update', { message: msgOut(m) })]);

app.patch('/api/messages/:id', auth, userOnly, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid message.' });
  const m = await Message.findOne({ _id: req.params.id, from: req.user._id });
  if (!m || m.deleted) return res.status(404).json({ error: 'Message not found.' });
  if (!text && !m.attachment) return res.status(400).json({ error: 'A message cannot be empty.' });
  if (text !== m.text) {
    m.text = text; m.edited = true;
    await m.save();
    await broadcastUpdate(m);
  }
  res.json({ ok: true });
}));

app.delete('/api/messages/:id', auth, userOnly, wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid message.' });
  const m = await Message.findOne({ _id: req.params.id, from: req.user._id });
  if (!m || m.deleted) return res.status(404).json({ error: 'Message not found.' });
  const fileId = m.attachment?.id;
  m.deleted = true; m.text = ''; m.attachment = undefined; m.reactions = [];
  await m.save();
  if (fileId) await removeFiles([fileId]);
  await broadcastUpdate(m);
  res.json({ ok: true });
}));

app.post('/api/messages/:id/react', auth, userOnly, wrap(async (req, res) => {
  const emoji = String(req.body.emoji || '');
  const uid = String(req.user._id);
  if (!isId(req.params.id) || !REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction.' });
  const m = await Message.findOne({ _id: req.params.id, $or: [{ from: uid }, { to: uid }] });
  if (!m || m.deleted) return res.status(404).json({ error: 'Message not found.' });
  const i = m.reactions.findIndex((r) => String(r.user) === uid);
  if (i >= 0 && m.reactions[i].emoji === emoji) m.reactions.splice(i, 1); // same emoji again = remove
  else if (i >= 0) m.reactions[i].emoji = emoji;
  else m.reactions.push({ user: uid, emoji });
  await m.save();
  await broadcastUpdate(m);
  res.json({ ok: true });
}));

// I came online: everything sent to me while offline is now "delivered" (double tick).
app.post('/api/delivered', auth, userOnly, wrap(async (req, res) => {
  const me = req.user._id;
  const senders = await Message.distinct('from', { to: me, status: 'sent' });
  if (senders.length) {
    await Message.updateMany({ to: me, status: 'sent' }, { status: 'delivered' });
    await Promise.all(senders.map((s) => publish('u:' + s, 'messages:delivered', { to: String(me) })));
  }
  res.json({ ok: true });
}));

// I am looking at this chat: mark their messages as read (blue ticks).
app.post('/api/read', auth, userOnly, wrap(async (req, res) => {
  const from = String(req.body.from || '');
  if (!isId(from)) return res.status(400).json({ error: 'Invalid user.' });
  const r = await Message.updateMany({ from, to: req.user._id, status: { $ne: 'read' } }, { status: 'read' });
  if (r.modifiedCount) await publish('u:' + from, 'messages:read', { by: String(req.user._id) });
  res.json({ ok: true });
}));

/* ---------- files (chunked upload, ranged download) ---------- */
app.post('/api/files', auth, userOnly, wrap(async (req, res) => {
  const uid = String(req.user._id);
  const size = Number(req.body.size);
  let mime = String(req.body.mime || '').split(';')[0].trim().toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) mime = 'application/octet-stream';
  if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: 'The file is empty.' });
  if (size > MAX_UPLOAD_BYTES) return res.status(413).json({ error: `File is too large (max ${MAX_UPLOAD_MB} MB).` });

  // Housekeeping: drop abandoned uploads, limit how many I can have in flight.
  const stale = await FileDoc.find({ attached: false, createdAt: { $lt: new Date(Date.now() - 2 * 3600 * 1000) } }).limit(20).select('_id');
  await removeFiles(stale.map((f) => f._id));
  if ((await FileDoc.countDocuments({ owner: uid, attached: false })) >= 10)
    return res.status(429).json({ error: 'Too many unfinished uploads. Try again in a bit.' });

  const f = await FileDoc.create({ owner: uid, name: cleanName(req.body.name), mime, kind: kindOf(mime), size, chunks: Math.ceil(size / CHUNK) });
  res.json({ id: String(f._id), chunkSize: CHUNK, chunks: f.chunks });
}));

app.put('/api/files/:id/parts/:n', auth, userOnly, express.raw({ type: () => true, limit: '4mb' }), wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid file.' });
  const f = await FileDoc.findOne({ _id: req.params.id, owner: String(req.user._id), ready: false, attached: false });
  const n = Number(req.params.n);
  if (!f || !Number.isInteger(n) || n < 0 || n >= f.chunks) return res.status(404).json({ error: 'Upload not found.' });
  const expected = n < f.chunks - 1 ? CHUNK : f.size - (f.chunks - 1) * CHUNK;
  if (!Buffer.isBuffer(req.body) || req.body.length !== expected) return res.status(400).json({ error: 'Bad chunk size.' });
  await FileChunk.updateOne({ file: f._id, n }, { $set: { data: req.body } }, { upsert: true });
  res.json({ ok: true });
}));

app.post('/api/files/:id/complete', auth, userOnly, wrap(async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ error: 'Invalid file.' });
  const f = await FileDoc.findOne({ _id: req.params.id, owner: String(req.user._id), attached: false });
  if (!f) return res.status(404).json({ error: 'Upload not found.' });
  if ((await FileChunk.countDocuments({ file: f._id })) !== f.chunks) return res.status(400).json({ error: 'Upload is incomplete.' });
  f.ready = true;
  await f.save();
  res.json({ id: String(f._id), name: f.name, mime: f.mime, size: f.size, kind: f.kind });
}));

app.get('/api/files/:id', wrap(async (req, res) => {
  const raw = String(req.query.t || (req.headers.authorization || '').replace('Bearer ', ''));
  let payload;
  try { payload = jwt.verify(raw, JWT_SECRET); } catch { return res.status(401).end(); }
  const uid = String(payload.id || '');
  if (payload.admin || !isId(uid) || !isId(req.params.id)) return res.status(403).end();
  const f = await FileDoc.findById(req.params.id);
  if (!f || !f.ready) return res.status(404).end();
  const allowed = f.owner === uid || (await Message.exists({ 'attachment.id': f._id, $or: [{ from: uid }, { to: uid }] }));
  if (!allowed) return res.status(403).end();

  const size = f.size;
  const safeInline = INLINE_MIME.test(f.mime);
  const inline = safeInline && req.query.dl !== '1';
  let start = 0, end = size - 1, status = 200;
  const rm = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (rm && (rm[1] || rm[2])) {
    if (rm[1] === '') start = Math.max(0, size - Number(rm[2]));
    else { start = Number(rm[1]); if (rm[2]) end = Math.min(Number(rm[2]), size - 1); }
    if (start > end || start >= size) { res.status(416).set('Content-Range', `bytes */${size}`); return res.end(); }
    end = Math.min(end, start + MAX_RANGE - 1);
    status = 206;
  }
  res.status(status).set({
    'Content-Type': safeInline ? f.mime : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=86400',
  });
  if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${size}`);

  // Stream chunk by chunk (streamed responses are not subject to the 4.5 MB limit).
  let pos = start;
  while (pos <= end) {
    const n = Math.floor(pos / CHUNK);
    const chunk = await FileChunk.findOne({ file: f._id, n });
    if (!chunk) break;
    const stop = Math.min(chunk.data.length, end - n * CHUNK + 1);
    if (!res.write(chunk.data.subarray(pos - n * CHUNK, stop))) await once(res, 'drain');
    pos = n * CHUNK + stop;
  }
  res.end();
}));

/* ---------- admin ---------- */
app.get('/api/admin/users', auth, adminOnly, wrap(async (req, res) => {
  const [users, counts, total, online] = await Promise.all([
    User.find({ role: { $ne: 'admin' } }).sort({ createdAt: -1 }),
    Message.aggregate([{ $group: { _id: '$from', n: { $sum: 1 } } }]),
    Message.countDocuments(),
    onlineSet(),
  ]);
  const cm = new Map(counts.map((c) => [String(c._id), c.n]));
  const list = users.map((u) => ({
    ...pub(u, online.has(String(u._id))),
    email: u.email,
    createdAt: u.createdAt,
    messages: cm.get(String(u._id)) || 0,
  }));
  res.json({ users: list, stats: { users: list.length, online: list.filter((u) => u.online).length, messages: total } });
}));

app.delete('/api/admin/users/:id', auth, adminOnly, wrap(async (req, res) => {
  const id = req.params.id;
  if (!isId(id)) return res.status(400).json({ error: 'Invalid user.' });
  const user = await User.findOne({ _id: id, role: { $ne: 'admin' } });
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const withFiles = await Message.find({ $or: [{ from: id }, { to: id }], 'attachment.id': { $exists: true } }).select('attachment.id');
  const owned = await FileDoc.find({ owner: id }).select('_id');
  await removeFiles([...withFiles.map((m) => m.attachment.id), ...owned.map((f) => f._id)]);
  await Promise.all([User.deleteOne({ _id: id }), Message.deleteMany({ $or: [{ from: id }, { to: id }] })]);
  await Promise.all([publish('u:' + id, 'account:deleted', {}), publish('global', 'user:removed', { id })]);
  setTimeout(() => disconnectUser(id), 600); // let the "account deleted" message arrive first
  res.json({ ok: true });
}));

/* ---------- cleanup of abandoned uploads (start.js calls this every hour) ---------- */
app.get('/api/cron/cleanup', wrap(async (req, res) => {
  if (env.CRON_SECRET && req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) return res.status(401).json({ error: 'Not allowed' });
  const stale = await FileDoc.find({ attached: false, createdAt: { $lt: new Date(Date.now() - 3600 * 1000) } }).select('_id');
  await removeFiles(stale.map((f) => f._id));
  res.json({ removed: stale.length });
}));

/* ---------- fallbacks ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Something went wrong.' + (DEV ? ' (' + err.message + ')' : '') });
});

export default app;
