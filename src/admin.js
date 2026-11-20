import './style.css';
import { Store, api, esc, avatar, toast } from './common.js';

(async function () {
  'use strict';
  if (!Store.token) { location.replace('/'); return; }
  const $ = (s) => document.querySelector(s);
  let all = [], pending = null;

  // Only the admin account may stay on this page.
  try {
    const { user } = await api('/me');
    if (user.role !== 'admin') { location.replace('/chat.html'); return; }
  } catch { return; }

  async function load(silent) {
    try {
      const { users, stats } = await api('/admin/users');
      all = users;
      $('#sUsers').textContent = stats.users;
      $('#sOnline').textContent = stats.online;
      $('#sMsgs').textContent = stats.messages;
      render();
    } catch (e) { if (!silent) toast(e.message, { type: 'error' }); }
  }

  function render() {
    const q = $('#q').value.trim().toLowerCase();
    const list = all.filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.includes(q));
    $('#rows').innerHTML = list.length
      ? list.map((u) => `<div class="u-row" data-id="${u.id}">
          ${avatar(u, 46, true)}
          <div class="u-info"><b>${esc(u.name)}</b><span>${esc(u.email)}</span></div>
          <div class="u-meta">Joined ${new Date(u.createdAt).toLocaleDateString()}<br>${u.messages} sent</div>
          <span class="pill ${u.online ? 'on' : ''}">${u.online ? 'Online' : 'Offline'}</span>
          <button class="del" data-id="${u.id}" type="button">Delete</button>
        </div>`).join('')
      : `<div class="u-empty">${all.length ? 'No users match your search.' : 'No users have signed up yet.'}</div>`;
  }

  $('#q').addEventListener('input', render);
  $('#refresh').onclick = () => load(false);
  $('#logout').onclick = () => { Store.token = null; location.replace('/'); };

  $('#rows').addEventListener('click', (e) => {
    const b = e.target.closest('.del'); if (!b) return;
    pending = all.find((u) => u.id === b.dataset.id);
    if (!pending) return;
    $('#cTitle').textContent = 'Delete ' + pending.name + '?';
    $('#cText').textContent = 'Their account and every message they sent or received will be permanently deleted. This cannot be undone.';
    $('#confirm').classList.remove('hidden');
  });

  const closeConfirm = () => { $('#confirm').classList.add('hidden'); pending = null; };
  $('#cNo').onclick = closeConfirm;
  $('#confirm').addEventListener('click', (e) => { if (e.target.id === 'confirm') closeConfirm(); });

  $('#cYes').onclick = async () => {
    if (!pending) return;
    const btn = $('#cYes'), u = pending;
    btn.disabled = true; btn.innerHTML = '<div class="spinner"></div><span>Deleting…</span>';
    try {
      await api('/admin/users/' + u.id, { method: 'DELETE' });
      closeConfirm();
      const row = document.querySelector(`.u-row[data-id="${u.id}"]`);
      if (row) { row.classList.add('gone'); await new Promise((r) => setTimeout(r, 300)); }
      toast(u.name + ' was deleted.', { type: 'success' });
      await load(true);
    } catch (e) { toast(e.message, { type: 'error' }); }
    btn.disabled = false; btn.textContent = 'Delete user';
  };

  await load(false);
  setTimeout(() => $('#splash').classList.add('out'), 250);
  setInterval(() => load(true), 10000); // keep online status fresh
})();
