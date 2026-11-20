// Unique id of this browser tab: lets the app ignore its own echoed events.
export const TAB_ID = (crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2);

export const Store = {
  get token() { return localStorage.getItem('token'); },
  set token(v) { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); },
};

export async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Tab': TAB_ID, ...(Store.token ? { Authorization: 'Bearer ' + Store.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && Store.token) {
    Store.token = null;
    location.href = '/';
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

export function avatar(u, size = 46, dot = false) {
  const inner = u.avatar
    ? `<img class="av" src="${u.avatar}" alt="">`
    : `<span class="av" style="--h:${hue(u.name)}">${esc((u.name || '?').trim().charAt(0).toUpperCase())}</span>`;
  return `<span class="av-wrap ${dot && u.online ? 'online' : ''}" style="--s:${size}px">${inner}${dot ? '<i class="dot"></i>' : ''}</span>`;
}

export function toast(text, { title = '', type = 'info', user = null, onClick = null, ms = 4000 } = {}) {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = (user ? avatar(user, 38) : '') + `<div class="t-body">${title ? `<b>${esc(title)}</b>` : ''}<span>${esc(text)}</span></div>`;
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 250); };
  t.onclick = () => { onClick && onClick(); close(); };
  box.appendChild(t);
  setTimeout(close, ms);
}

/* time helpers */
export const pad = (n) => String(n).padStart(2, '0');
export const timeStr = (d) => { d = new Date(d); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
export const sameDay = (a, b) => a.toDateString() === b.toDateString();
export function dayLabel(d) {
  d = new Date(d); const n = new Date();
  if (sameDay(d, n)) return 'Today';
  const y = new Date(); y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function shortTime(d) {
  const l = dayLabel(d);
  return l === 'Today' ? timeStr(d) : l === 'Yesterday' ? l : new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: '2-digit' });
}
export function lastSeenText(d) {
  if (!d) return 'offline';
  const l = dayLabel(d);
  return 'last seen ' + (l === 'Today' ? 'today' : l === 'Yesterday' ? 'yesterday' : l) + ' at ' + timeStr(d);
}

/* tick icons: pending = clock, sent = 1 tick, delivered = 2 ticks, read = 2 blue ticks */
export function tickSvg(status) {
  const a = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (status === 'pending') return `<svg viewBox="0 0 20 18" width="16" height="15"><circle cx="10" cy="9" r="5.5" ${a}/><path d="M10 6.5V9l1.8 1.2" ${a}/></svg>`;
  if (status === 'sent') return `<svg viewBox="0 0 20 18" width="17" height="15"><path d="M5 9.5l3.5 3.5L15 5.5" ${a}/></svg>`;
  return `<svg viewBox="0 0 20 18" width="19" height="15"><path d="M2 9.5l3.5 3.5L12 5.5" ${a}/><path d="M7.5 9.5L11 13l6.5-7.5" ${a}/></svg>`;
}

/* ---------- theme (dark / light), remembered in this browser ---------- */
export const getTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch {}
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = t === 'light' ? '#f0f2f5' : '#1a2730';
}
try { const saved = localStorage.getItem('theme'); if (saved) document.documentElement.dataset.theme = saved; } catch {}
