// Realtime with Socket.io: one persistent server process keeps every user's connection.
// REST routes (app.js) call publish() to push events; typing + call signalling are relayed here.
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { User } from './models.js';

let io;
const online = new Map(); // userId -> Set(socketId)
const room = (id) => 'u:' + id;
const SIGNALS = new Set(['typing', 'call:offer', 'call:answer', 'call:ice', 'call:end', 'call:reject', 'call:busy', 'call:handled']);

// channel: 'u:<userId>' (one user, all their tabs) or 'global' (everyone)
export async function publish(channel, name, data) {
  if (!io) return;
  (channel === 'global' ? io : io.to(channel)).emit(name, data);
}
export const isOnline = async (id) => (online.get(String(id))?.size || 0) > 0;
export const onlineSet = async () => new Set(online.keys());
export const disconnectUser = (id) => io && io.in(room(String(id))).disconnectSockets(true);

export function attachSocket(httpServer, origins) {
  io = new Server(httpServer, { cors: { origin: origins.includes('*') ? '*' : origins, methods: ['GET', 'POST'] } });

  io.use(async (socket, next) => {
    try {
      const p = jwt.verify(socket.handshake.auth?.token || '', process.env.JWT_SECRET);
      if (p.scope || p.admin) throw new Error('not a chat user');
      const user = await User.findById(p.id).select('_id');
      if (!user) throw new Error('no user');
      socket.uid = String(user._id);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const uid = socket.uid;
    socket.join(room(uid));
    const set = online.get(uid) || new Set();
    set.add(socket.id);
    online.set(uid, set);
    if (set.size === 1) io.emit('presence', { id: uid, online: true });

    // Typing + call signalling: relayed to the other user; "from" is set here so it can't be faked.
    socket.on('signal', (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const to = String(data?.to || '');
      const name = String(data?.name || '');
      const payload = data?.data && typeof data.data === 'object' ? data.data : {};
      if (!SIGNALS.has(name) || !mongoose.isValidObjectId(to) || (to === uid && name !== 'call:handled')) return reply({ error: 'Invalid signal.' });
      if (JSON.stringify(payload).length > 30000) return reply({ error: 'Signal too large.' });
      socket.to(room(to)).emit(name, { ...payload, from: uid });
      reply({ ok: true });
    });

    socket.on('disconnect', async () => {
      const s = online.get(uid);
      if (!s) return;
      s.delete(socket.id);
      if (s.size) return;
      online.delete(uid);
      const lastSeen = new Date();
      await User.updateOne({ _id: uid }, { lastSeen }).catch(() => {});
      io.emit('presence', { id: uid, online: false, lastSeen });
    });
  });
  return io;
}
