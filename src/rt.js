// Realtime layer: Socket.io connection to the same server. Interface: on / send / close.
import { io } from 'socket.io-client';
import { Store } from './common.js';

export function createRT({ token }) {
  const handlers = new Map();
  const on = (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); };
  const emit = (name, data) => (handlers.get(name) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

  const socket = io({ auth: { token }, transports: ['websocket', 'polling'] });
  const offlineTimers = new Map();

  socket.on('connect', () => emit('connected'));
  socket.on('disconnect', (reason) => emit('disconnected', { state: 'disconnected', reason }));
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') { Store.token = null; location.replace('/'); return; }
    emit('disconnected', { state: 'disconnected', reason: err.message });
  });

  // Every server event is forwarded to whoever registered with on().
  socket.onAny((name, data) => {
    if (name === 'presence' && data && !data.online) {
      // Wait a few seconds before showing "offline": a page reload disconnects and reconnects straight away.
      clearTimeout(offlineTimers.get(data.id));
      offlineTimers.set(data.id, setTimeout(() => emit(name, data), 4000));
      return;
    }
    if (name === 'presence' && data) clearTimeout(offlineTimers.get(data.id));
    emit(name, data);
  });

  return {
    on,
    // Send typing / call signalling to another user. Returns a promise.
    send: (peerId, name, data = {}) =>
      new Promise((resolve, reject) => {
        socket.timeout(8000).emit('signal', { to: peerId, name, data }, (err, res) => {
          if (err || !res || res.error) reject(new Error((res && res.error) || 'Could not send.'));
          else resolve();
        });
      }),
    setFast() {}, // (not needed with Socket.io)
    close: () => socket.disconnect(),
  };
}
