import './style.css';
import { Store, api, TAB_ID, esc, avatar, toast, timeStr, dayLabel, shortTime, lastSeenText, tickSvg } from './common.js';
import { createRT } from './rt.js';
import { applyTheme, getTheme, pad } from './common.js';
import { Calls } from './call.js';

(async function () {
  'use strict';
  if (!Store.token) { location.replace('/'); return; }

  const $ = (s) => document.querySelector(s);
  const el = {
    app: $('.app'), list: $('#list'), search: $('#search'), empty: $('#empty'), conv: $('#conv'),
    msgs: $('#msgs'), form: $('#composer'), text: $('#text'), peerAv: $('#peerAv'), peerName: $('#peerName'),
    peerStatus: $('#peerStatus'), meAv: $('#meAv'), meName: $('#meName'), net: $('#net'),
    menu: $('#msgMenu'), editBar: $('#editBar'), lightbox: $('#lightbox'), confirm: $('#confirmModal'),
    profile: $('#profileModal'), replyBar: $('#replyBar'), emojiPop: $('#emojiPop'), recBar: $('#recBar'),
  };
  const users = new Map();   // id -> { ...user, lastMessage, unread }
  const typers = new Map();  // id -> timeout
  let me, rt, cfg, fileToken = '', active = null, messages = [], firstConnect = true;
  let editing = null, deleting = null, replying = null;

  /* ---------- boot ---------- */
  async function loadFileToken() { fileToken = (await api('/file-token')).token; }
  try {
    me = (await api('/me')).user;
    if (me.role === 'admin') { location.replace('/admin.html'); return; }
    (await api('/users')).users.forEach((u) => users.set(u.id, u));
    cfg = await api('/config');
    await loadFileToken();
  } catch (e) {
    if (!Store.token) return;
    // Show the real reason and let the user retry (no endless auto-reload loop).
    $('#splash .spinner').style.display = 'none';
    $('#splash .s-msg').innerHTML = esc(e.message || 'Connection problem.') + '<br><button class="btn" id="retry" type="button" style="margin-top:16px">Try again</button>';
    $('#retry').onclick = () => location.reload();
    return;
  }
  setInterval(() => loadFileToken().catch(() => {}), 6 * 60 * 60 * 1000);
  renderMe();
  renderList();
  connect();
  setTimeout(() => $('#splash').classList.add('out'), 350);

  /* ---------- helpers ---------- */
  const fileUrl = (a, dl) => `/api/files/${a.id}?t=${encodeURIComponent(fileToken)}${dl ? '&dl=1' : ''}`;
  const isTmp = (m) => String(m.id).startsWith('tmp');
  const sizeText = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const kindOfMime = (t) =>
    /^image\/(png|jpeg|gif|webp)$/.test(t) ? 'image' : /^video\/(mp4|webm|quicktime|ogg)$/.test(t) ? 'video' : /^audio\/(mpeg|ogg|wav|webm|mp4|aac|x-m4a)$/.test(t) ? 'audio' : 'file';

  const isVoice = (a) => a.kind === 'audio' && String(a.name || '').startsWith('voice-');
  // Short snapshot of a message, used for replies.
  const snap = (m) => ({ id: m.id, from: m.from, text: (m.text || '').slice(0, 120), kind: m.attachment ? m.attachment.kind : 'text', name: m.attachment ? m.attachment.name : '' });
  const quoteText = (r) => (r.kind === 'image' ? '📷 Photo' : r.kind === 'video' ? '🎥 Video' : r.kind === 'audio' ? (String(r.name).startsWith('voice-') ? '🎤 Voice message' : '🎵 Audio') : r.kind === 'file' ? '📎 ' + r.name : r.text);

  function previewText(m) {
    if (m.deleted) return '🚫 This message was deleted';
    const a = m.attachment;
    if (!a) return m.text;
    const base = a.kind === 'image' ? '📷 Photo' : a.kind === 'video' ? '🎥 Video' : a.kind === 'audio' ? (isVoice(a) ? '🎤 Voice message' : '🎵 Audio') : '📎 ' + a.name;
    return m.text ? base + ' ' + m.text : base;
  }

  /* ---------- rendering ---------- */
  function renderMe() {
    el.meAv.innerHTML = avatar(me, 42);
    el.meName.textContent = me.name;
  }

  function sortedUsers() {
    const q = el.search.value.trim().toLowerCase();
    return [...users.values()]
      .filter((u) => !q || u.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const ta = a.lastMessage ? +new Date(a.lastMessage.createdAt) : 0;
        const tb = b.lastMessage ? +new Date(b.lastMessage.createdAt) : 0;
        return tb - ta || a.name.localeCompare(b.name);
      });
  }

  function renderList() {
    const arr = sortedUsers();
    if (!arr.length) {
      el.list.innerHTML = `<div class="list-empty">${users.size ? 'No one matches your search.' : 'No one else has joined yet.<br>Invite a friend to sign up.'}</div>`;
    } else {
      el.list.innerHTML = arr.map((u) => {
        const lm = u.lastMessage;
        const preview = typers.has(u.id)
          ? '<span class="typing-txt">typing…</span>'
          : lm
            ? (lm.from === me.id && !lm.deleted ? `<span class="tick ${lm.status}">${tickSvg(lm.status)}</span>` : '') + `<span class="ci-txt">${esc(previewText(lm))}</span>`
            : `<span class="ci-txt">${esc(u.about || '')}</span>`;
        return `<div class="chat-item ${u.id === active ? 'active' : ''}" data-id="${u.id}">
          ${avatar(u, 50, true)}
          <div class="ci-body">
            <div class="ci-top"><span class="ci-name">${esc(u.name)}</span><span class="ci-time ${u.unread ? 'unread' : ''}">${lm ? shortTime(lm.createdAt) : ''}</span></div>
            <div class="ci-bottom"><span class="ci-last">${preview}</span>${u.unread ? `<span class="badge">${u.unread > 99 ? '99+' : u.unread}</span>` : ''}</div>
          </div></div>`;
      }).join('');
    }
    const total = [...users.values()].reduce((n, u) => n + (u.unread || 0), 0);
    document.title = (total ? `(${total}) ` : '') + 'Chat';
  }

  function renderHeader() {
    const u = users.get(active);
    if (!u) return;
    el.peerAv.innerHTML = avatar(u, 42, true);
    el.peerName.textContent = u.name;
    const t = typers.has(u.id);
    el.peerStatus.textContent = t ? 'typing…' : u.online ? 'online' : lastSeenText(u.lastSeen);
    el.peerStatus.className = 'status' + (t || u.online ? ' on' : '');
  }

  const scrollDown = (smooth) => el.msgs.scrollTo({ top: el.msgs.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });

  const FILE_ICON = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm0 7V3.5L19.5 9H14z"/></svg>';
  const CHEVRON = '<svg viewBox="0 0 24 24"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>';

  function attHTML(m) {
    const a = m.attachment;
    if (!a) return '';
    const src = esc(a.local || fileUrl(a));
    const up = a.uploading ? '<div class="up"><div class="up-bar"><i style="width:0%"></i></div></div>' : '';
    if (a.kind === 'image') return `<div class="att">${`<img class="att-img" src="${src}" alt="${esc(a.name)}" loading="lazy">`}${up}</div>`;
    if (a.kind === 'video') return `<div class="att"><video class="att-video" src="${src}" controls preload="metadata" playsinline></video>${up}</div>`;
    if (a.kind === 'audio') return `<div class="att">${isVoice(a) ? '<div class="voice-label">🎤 Voice message</div>' : ''}<audio class="att-audio" src="${src}" controls preload="metadata"></audio>${up}</div>`;
    const inner = `<span class="fic">${FILE_ICON}</span><span class="fi"><b>${esc(a.name)}</b><span>${sizeText(a.size)}</span></span>`;
    return a.uploading
      ? `<div class="att"><div class="att-file">${inner}</div>${up}</div>`
      : `<div class="att"><a class="att-file" href="${esc(fileUrl(a, true))}" download="${esc(a.name)}">${inner}</a></div>`;
  }

  function reactsHTML(m) {
    if (m.deleted || !m.reactions || !m.reactions.length) return '';
    const counts = new Map();
    m.reactions.forEach((r) => counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1));
    const mineEmoji = (m.reactions.find((r) => r.user === me.id) || {}).emoji;
    return `<div class="reacts">${[...counts].map(([e, n]) => `<button type="button" class="chip ${e === mineEmoji ? 'mine' : ''}" data-emoji="${e}">${e}${n > 1 ? `<b>${n}</b>` : ''}</button>`).join('')}</div>`;
  }

  function quoteHTML(m) {
    if (!m.reply) return '';
    const who = m.reply.from === me.id ? 'You' : esc((users.get(m.reply.from) || {}).name || '');
    return `<div class="quote" data-qid="${m.reply.id}"><b>${who}</b><span>${esc(quoteText(m.reply))}</span></div>`;
  }

  function msgHTML(m, pop) {
    const mineMsg = m.from === me.id;
    const body = m.deleted
      ? '<span class="txt deleted">🚫 This message was deleted</span>'
      : quoteHTML(m) + attHTML(m) + (m.text ? `<span class="txt">${esc(m.text)}</span>` : '');
    const canMenu = !m.deleted && !isTmp(m);
    const meta = `<span class="meta">${m.edited && !m.deleted ? '<i class="edited">edited</i>' : ''}<time>${timeStr(m.createdAt)}</time>${mineMsg && !m.deleted ? `<span class="tick ${m.status}">${tickSvg(m.status)}</span>` : ''}</span>`;
    return `<div class="msg ${mineMsg ? 'out' : 'in'} ${pop ? 'pop' : ''} ${m.reactions && m.reactions.length && !m.deleted ? 'has-reacts' : ''}" data-mid="${m.id}"><div class="col"><div class="bubble ${m.attachment && !m.deleted ? 'has-att' : ''}">${canMenu ? `<button class="m-menu" type="button" aria-label="Message options">${CHEVRON}</button>` : ''}${body}${meta}</div>${reactsHTML(m)}</div></div>`;
  }

  function renderMessages() {
    if (!messages.length) { el.msgs.innerHTML = '<div class="no-msgs">No messages yet.<br>Say hi 👋</div>'; return; }
    let html = '', day = '';
    for (const m of messages) {
      const d = dayLabel(m.createdAt);
      if (d !== day) { day = d; html += `<div class="day"><span>${d}</span></div>`; }
      html += msgHTML(m, false);
    }
    el.msgs.innerHTML = html;
    scrollDown(false);
  }

  function appendMessage(m) {
    const prev = messages[messages.length - 1];
    messages.push(m);
    const nb = el.msgs.querySelector('.no-msgs'); if (nb) nb.remove();
    let html = '';
    if (!prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt)) html += `<div class="day"><span>${dayLabel(m.createdAt)}</span></div>`;
    html += msgHTML(m, true);
    el.msgs.insertAdjacentHTML('beforeend', html);
    scrollDown(true);
  }

  const nodeOf = (id) => el.msgs.querySelector(`.msg[data-mid="${id}"]`);

  function setStatus(m, status) {
    m.status = status;
    const t = nodeOf(m.id)?.querySelector('.tick');
    if (t) { t.className = 'tick ' + status; t.innerHTML = tickSvg(status); }
  }

  /* ---------- open / close chat ---------- */
  async function openChat(id) {
    const u = users.get(id);
    if (!u) return;
    stopTyping(); cancelEdit(); cancelReply(); cancelRec(); closeEmoji(); closeMenu();
    active = id; u.unread = 0; messages = [];
    el.app.classList.add('chat-open');
    el.empty.classList.add('hidden');
    el.conv.classList.remove('hidden');
    renderHeader(); renderList();
    el.msgs.innerHTML = '<div class="msgs-loader"><div class="spinner big"></div></div>';
    try {
      const { messages: list } = await api('/messages/' + id);
      if (active !== id) return;
      messages = list;
      renderMessages();
      if (list.length) u.lastMessage = list[list.length - 1];
      renderList();
      if (matchMedia('(min-width:761px)').matches) el.text.focus();
    } catch (e) {
      if (active === id) { el.msgs.innerHTML = ''; toast(e.message, { type: 'error' }); }
    }
  }

  function closeChat() {
    stopTyping(); cancelEdit(); cancelReply(); cancelRec(); closeEmoji(); closeMenu();
    active = null; messages = [];
    el.conv.classList.add('hidden');
    el.empty.classList.remove('hidden');
    el.app.classList.remove('chat-open');
    renderList();
  }

  el.list.addEventListener('click', (e) => { const it = e.target.closest('.chat-item'); if (it) openChat(it.dataset.id); });
  el.search.addEventListener('input', renderList);
  $('#backBtn').onclick = closeChat;
  $('#callVoice').onclick = () => active && Calls.start(active, false);
  $('#callVideo').onclick = () => active && Calls.start(active, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.lightbox.classList.contains('hidden')) return closeLightbox();
    if (!el.menu.classList.contains('hidden')) return closeMenu();
    if (!el.confirm.classList.contains('hidden')) return el.confirm.classList.add('hidden');
    if (rec) return cancelRec();
    if (!el.emojiPop.classList.contains('hidden')) return closeEmoji();
    if (replying) return cancelReply();
    if (editing) return cancelEdit();
    if (!el.profile.classList.contains('hidden')) return;
    if (active) closeChat();
  });

  /* ---------- sending text / editing ---------- */
  el.form.addEventListener('submit', (e) => { e.preventDefault(); editing ? submitEdit() : send(); });

  function newTmp(to, extra) {
    return { id: 'tmp' + Date.now() + Math.random().toString(36).slice(2), from: me.id, to, text: '', status: 'pending', createdAt: new Date().toISOString(), edited: false, deleted: false, reactions: [], attachment: null, reply: null, ...extra };
  }

  // Replace a temporary (optimistic) message with the one the server confirmed.
  function confirmTmp(tmp, real) {
    const node = nodeOf(tmp.id);
    const i = messages.indexOf(tmp);
    if (i >= 0) messages[i] = real;
    const u = users.get(real.to);
    if (u && u.lastMessage === tmp) u.lastMessage = real;
    if (node) node.outerHTML = msgHTML(real, false);
    renderList();
  }
  function dropTmp(tmp) {
    nodeOf(tmp.id)?.remove();
    messages = messages.filter((m) => m !== tmp);
    const u = users.get(tmp.to);
    if (u && u.lastMessage === tmp) u.lastMessage = active === tmp.to ? messages[messages.length - 1] || null : null;
    if (!messages.length && active === tmp.to) renderMessages();
    renderList();
  }

  function send() {
    const text = el.text.value.trim();
    if (!text || !active) return;
    el.text.value = '';
    stopTyping();
    const to = active;
    const rep = replying;
    const tmp = newTmp(to, { text, reply: rep ? snap(rep) : null });
    cancelReply();
    appendMessage(tmp);
    users.get(to).lastMessage = tmp; renderList();
    api('/messages', { method: 'POST', body: { to, text, replyTo: rep ? rep.id : undefined } })
      .then((res) => confirmTmp(tmp, res.message))
      .catch((e) => {
        dropTmp(tmp);
        if (active === to && !el.text.value) el.text.value = text;
        toast(e.message, { type: 'error' });
      });
  }

  function startEdit(m) {
    cancelReply();
    editing = m;
    $('#editText').textContent = m.text;
    el.editBar.classList.remove('hidden');
    el.text.value = m.text;
    el.text.focus();
  }
  function cancelEdit() {
    if (!editing) return;
    editing = null;
    el.editBar.classList.add('hidden');
    el.text.value = '';
  }
  $('#editCancel').onclick = cancelEdit;
  function submitEdit() {
    const text = el.text.value.trim();
    const m = editing;
    if (!text) return toast('A message cannot be empty.', { type: 'error' });
    if (text === m.text) return cancelEdit();
    cancelEdit();
    api('/messages/' + m.id, { method: 'PATCH', body: { text } }).catch((e) => toast(e.message, { type: 'error' }));
  }

  /* typing indicator (sent to the other person) */
  let typingOn = false, typingTo = null, typingTimer;
  el.text.addEventListener('input', () => {
    if (!active || editing) return;
    if (!typingOn) { typingOn = true; typingTo = active; rt.send(active, 'typing', { typing: true }).catch(() => {}); }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 1500);
  });
  function stopTyping() {
    clearTimeout(typingTimer);
    if (typingOn) { typingOn = false; rt && rt.send(typingTo, 'typing', { typing: false }).catch(() => {}); }
  }

  /* ---------- files: photo / video / any file ---------- */
  $('#attachBtn').onclick = () => active && $('#fileInput').click();
  $('#fileInput').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; files.forEach(sendFile); };
  el.text.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); files.forEach(sendFile); }
  });

  function sendFile(file) {
    if (!active) return;
    if (!file.size) return toast(`"${file.name}" is empty.`, { type: 'error' });
    if (file.size > cfg.maxUploadMB * 1048576) return toast(`"${file.name}" is too large. The limit is ${cfg.maxUploadMB} MB.`, { type: 'error' });
    const to = active;
    const rep = replying;
    if (rep) cancelReply();
    const local = URL.createObjectURL(file);
    const tmp = newTmp(to, { reply: rep ? snap(rep) : null, attachment: { local, name: file.name, mime: file.type, size: file.size, kind: kindOfMime(file.type), uploading: true } });
    appendMessage(tmp);
    users.get(to).lastMessage = tmp; renderList();

    const fail = (msg) => { URL.revokeObjectURL(local); dropTmp(tmp); toast(msg, { type: 'error' }); };
    const setProgress = (p) => { const bar = nodeOf(tmp.id)?.querySelector('.up-bar i'); if (bar) bar.style.width = Math.round(p * 100) + '%'; };

    // Send one chunk with progress (XMLHttpRequest is used because fetch can't report upload progress).
    const putChunk = (id, n, blob, onProgress) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/files/${id}/parts/${n}`);
      xhr.setRequestHeader('Authorization', 'Bearer ' + Store.token);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
      xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
      xhr.onload = () => {
        if (xhr.status === 200) return resolve();
        let msg = 'Upload failed.';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        reject(new Error(msg));
      };
      xhr.send(blob);
    });

    (async () => {
      try {
        const init = await api('/files', { method: 'POST', body: { name: file.name, mime: file.type || 'application/octet-stream', size: file.size } });
        let done = 0;
        for (let n = 0; n < init.chunks; n++) {
          const blob = file.slice(n * init.chunkSize, (n + 1) * init.chunkSize);
          for (let attempt = 1; ; attempt++) {
            try { await putChunk(init.id, n, blob, (loaded) => setProgress((done + loaded) / file.size)); break; }
            catch (e) { if (attempt >= 2) throw e; } // one automatic retry per chunk
          }
          done += blob.size;
          setProgress(done / file.size);
        }
        await api(`/files/${init.id}/complete`, { method: 'POST' });
        const res = await api('/messages', { method: 'POST', body: { to, attachment: { id: init.id }, replyTo: rep ? rep.id : undefined } });
        URL.revokeObjectURL(local);
        confirmTmp(tmp, res.message);
      } catch (e) { fail(e.message); }
    })();
  }

  /* ---------- message menu: react / copy / edit / delete ---------- */
  let menuOpenedAt = 0;
  const findMsg = (node) => { const id = node?.closest('.msg')?.dataset.mid; return messages.find((m) => m.id === id); };

  function openMenu(m, anchor) {
    if (!m || m.deleted || isTmp(m)) return;
    const mineMsg = m.from === me.id;
    const myReact = (m.reactions.find((r) => r.user === me.id) || {}).emoji;
    el.menu.innerHTML =
      `<div class="react-row">${cfg.reactions.map((e) => `<button type="button" data-react="${e}" class="${e === myReact ? 'sel' : ''}">${e}</button>`).join('')}</div>` +
      '<button type="button" data-act="reply">Reply</button>' +
      (m.text ? '<button type="button" data-act="copy">Copy text</button>' : '') +
      (mineMsg && !m.attachment ? '<button type="button" data-act="edit">Edit</button>' : '') +
      (mineMsg ? '<button type="button" data-act="delete" class="danger">Delete for everyone</button>' : '');
    el.menu.dataset.mid = m.id;
    el.menu.classList.remove('hidden');
    const r = anchor.getBoundingClientRect(), w = el.menu.offsetWidth, h = el.menu.offsetHeight;
    let left = mineMsg ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    el.menu.style.left = left + 'px';
    el.menu.style.top = top + 'px';
    menuOpenedAt = Date.now();
  }
  function closeMenu() { el.menu.classList.add('hidden'); el.menu.dataset.mid = ''; }

  el.msgs.addEventListener('click', (e) => {
    const mb = e.target.closest('.m-menu');
    if (mb) return openMenu(findMsg(mb), mb.closest('.bubble'));
    const q = e.target.closest('.quote');
    if (q) {
      const n = nodeOf(q.dataset.qid);
      if (!n) return toast('That message is not loaded.', { ms: 2000 });
      n.scrollIntoView({ behavior: 'smooth', block: 'center' });
      n.classList.add('flash');
      return void setTimeout(() => n.classList.remove('flash'), 1300);
    }
    const chip = e.target.closest('.chip');
    if (chip) return react(chip.closest('.msg').dataset.mid, chip.dataset.emoji);
    const img = e.target.closest('.att-img');
    if (img) return openLightbox(img, findMsg(img));
  });
  el.msgs.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.bubble');
    if (!b) return;
    e.preventDefault();
    openMenu(findMsg(b), b);
  });
  let pressTimer;
  el.msgs.addEventListener('touchstart', (e) => {
    const b = e.target.closest('.bubble');
    if (!b || e.target.closest('video,audio,a')) return;
    pressTimer = setTimeout(() => openMenu(findMsg(b), b), 450);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach((ev) => el.msgs.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));
  el.msgs.addEventListener('scroll', closeMenu, { passive: true });
  window.addEventListener('resize', closeMenu);
  document.addEventListener('click', (e) => {
    if (Date.now() - menuOpenedAt < 350) return;
    if (!el.menu.contains(e.target) && !e.target.closest('.m-menu')) closeMenu();
  });

  el.menu.addEventListener('click', (e) => {
    const m = messages.find((x) => x.id === el.menu.dataset.mid);
    const rb = e.target.closest('[data-react]');
    const ab = e.target.closest('[data-act]');
    closeMenu();
    if (!m) return;
    if (rb) return react(m.id, rb.dataset.react);
    if (!ab) return;
    if (ab.dataset.act === 'copy') navigator.clipboard?.writeText(m.text).then(() => toast('Copied.', { type: 'success', ms: 1500 }), () => {});
    if (ab.dataset.act === 'reply') startReply(m);
    if (ab.dataset.act === 'edit') startEdit(m);
    if (ab.dataset.act === 'delete') { deleting = m; el.confirm.classList.remove('hidden'); }
  });

  function react(id, emoji) {
    api(`/messages/${id}/react`, { method: 'POST', body: { emoji } }).catch((e) => toast(e.message, { type: 'error' }));
  }

  $('#delNo').onclick = () => { deleting = null; el.confirm.classList.add('hidden'); };
  el.confirm.addEventListener('click', (e) => { if (e.target === el.confirm) $('#delNo').click(); });
  $('#delYes').onclick = () => {
    const m = deleting; deleting = null;
    el.confirm.classList.add('hidden');
    if (!m) return;
    api('/messages/' + m.id, { method: 'DELETE' }).catch((e) => toast(e.message, { type: 'error' }));
  };

  /* ---------- image viewer ---------- */
  function openLightbox(img, m) {
    $('#lbImg').src = img.src;
    const dl = $('#lbDl');
    if (m && m.attachment && m.attachment.id) { dl.href = fileUrl(m.attachment, true); dl.download = m.attachment.name; dl.classList.remove('hidden'); }
    else dl.classList.add('hidden');
    el.lightbox.classList.remove('hidden');
  }
  function closeLightbox() { el.lightbox.classList.add('hidden'); $('#lbImg').removeAttribute('src'); }
  $('#lbClose').onclick = closeLightbox;
  el.lightbox.addEventListener('click', (e) => { if (e.target === el.lightbox || e.target.id === 'lbImg') closeLightbox(); });

  /* ---------- realtime ---------- */
  function connect() {
    rt = createRT({ token: Store.token });
    Calls.init({ rt, me, getUser: (id) => users.get(id), iceServers: cfg.iceServers });

    let netTimer;
    rt.on('connected', () => {
      clearTimeout(netTimer);
      el.net.classList.add('hidden');
      api('/delivered', { method: 'POST' }).catch(() => {}); // I'm online: my pending messages count as delivered
      if (!firstConnect) resync();
      firstConnect = false;
    });
    // Only show the banner if the connection stays down for a few seconds.
    rt.on('disconnected', () => {
      clearTimeout(netTimer);
      netTimer = setTimeout(() => {
        $('#netText').textContent = 'Connection lost. Retrying…';
        el.net.classList.remove('hidden');
      }, 2500);
    });

    rt.on('message:new', ({ message: m, origin }) => {
      if (origin && origin === TAB_ID) return; // I sent it from this tab; already shown
      const mineMsg = m.from === me.id;
      const pid = mineMsg ? m.to : m.from;
      const u = users.get(pid);
      if (!u) return;
      if (u.lastMessage && u.lastMessage.id === m.id) return; // already loaded from the server
      if (messages.some((x) => x.id === m.id)) return; // already on screen
      u.lastMessage = m;
      if (mineMsg) {
        if (active === pid) appendMessage(m);
      } else {
        clearTimeout(typers.get(pid)); typers.delete(pid);
        if (active === pid && document.visibilityState === 'visible') {
          m.status = 'read';
          appendMessage(m);
          api('/read', { method: 'POST', body: { from: pid } }).catch(() => {});
        } else {
          u.unread = (u.unread || 0) + 1;
          if (active === pid) appendMessage(m);
          notify(u, m);
        }
      }
      renderList();
      if (active === pid) renderHeader();
    });

    // Edit, delete or reaction on an existing message.
    rt.on('message:update', ({ message: m }) => {
      const pid = m.from === me.id ? m.to : m.from;
      const u = users.get(pid);
      if (!u) return;
      if (u.lastMessage && u.lastMessage.id === m.id) u.lastMessage = m;
      if (active === pid) {
        const i = messages.findIndex((x) => x.id === m.id);
        if (i >= 0) {
          const old = messages[i];
          messages[i] = m;
          const node = nodeOf(m.id);
          if (node) {
            const onlyReactions = old.text === m.text && old.deleted === m.deleted && old.edited === m.edited;
            if (onlyReactions) {
              // Patch only the reaction chips so a playing video isn't restarted.
              node.querySelector('.reacts')?.remove();
              node.classList.toggle('has-reacts', m.reactions.length > 0);
              node.querySelector('.col').insertAdjacentHTML('beforeend', reactsHTML(m));
            } else node.outerHTML = msgHTML(m, false);
          }
        }
      }
      if (editing && editing.id === m.id && m.deleted) cancelEdit();
      if (el.menu.dataset.mid === m.id) closeMenu();
      renderList();
    });

    rt.on('messages:delivered', ({ to }) => {
      if (active === to) messages.forEach((m) => { if (m.from === me.id && m.status === 'sent') setStatus(m, 'delivered'); });
      const u = users.get(to);
      if (u && u.lastMessage && u.lastMessage.from === me.id && u.lastMessage.status === 'sent') u.lastMessage.status = 'delivered';
      renderList();
    });

    rt.on('messages:read', ({ by }) => {
      if (active === by) messages.forEach((m) => { if (m.from === me.id && m.status !== 'read') setStatus(m, 'read'); });
      const u = users.get(by);
      if (u && u.lastMessage && u.lastMessage.from === me.id) u.lastMessage.status = 'read';
      renderList();
    });

    rt.on('presence', (p) => {
      const u = users.get(p.id); if (!u) return;
      u.online = p.online;
      if (p.lastSeen) u.lastSeen = p.lastSeen;
      if (!p.online) { clearTimeout(typers.get(p.id)); typers.delete(p.id); }
      renderList();
      if (active === p.id) renderHeader();
    });

    rt.on('typing', ({ from, typing: on }) => {
      if (!users.has(from)) return;
      clearTimeout(typers.get(from));
      if (on) typers.set(from, setTimeout(() => { typers.delete(from); renderList(); if (active === from) renderHeader(); }, 4000));
      else typers.delete(from);
      renderList();
      if (active === from) renderHeader();
    });

    rt.on('user:new', (u) => { if (u.id !== me.id) { users.set(u.id, { ...u, unread: 0, lastMessage: null }); renderList(); } });
    rt.on('user:update', (u) => {
      if (u.id === me.id) { Object.assign(me, u); renderMe(); return; }
      const cur = users.get(u.id); if (cur) Object.assign(cur, u, { online: cur.online });
      renderList(); if (active === u.id) renderHeader();
    });
    rt.on('user:removed', ({ id }) => {
      users.delete(id); typers.delete(id);
      if (active === id) { closeChat(); toast('This user was removed.', { type: 'error' }); }
      renderList();
    });
    rt.on('account:deleted', () => {
      Store.token = null;
      toast('Your account was removed by an admin.', { type: 'error', ms: 5000 });
      setTimeout(() => location.replace('/'), 2000);
    });
  }

  async function resync() {
    try {
      const { users: list } = await api('/users');
      users.clear(); typers.clear();
      list.forEach((u) => users.set(u.id, u));
      renderList();
      if (active && users.has(active)) {
        messages = (await api('/messages/' + active)).messages;
        renderMessages(); renderHeader();
      } else if (active) closeChat();
    } catch {}
  }

  /* mark as read when the user comes back to the tab */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !active) return;
    const u = users.get(active);
    if (u && u.unread) {
      u.unread = 0;
      messages.forEach((m) => { if (m.from === active && m.status !== 'read') setStatus(m, 'read'); });
      api('/read', { method: 'POST', body: { from: active } }).catch(() => {});
      renderList();
    }
  });

  /* ---------- notifications ---------- */
  let actx;
  function beep() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
      o.type = 'sine';
      o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(660, t + 0.12);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.26);
    } catch {}
  }
  function notify(u, m) {
    beep();
    toast(previewText(m), { title: u.name, user: u, onClick: () => openChat(u.id) });
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(u.name, { body: previewText(m), icon: u.avatar || undefined });
      n.onclick = () => { window.focus(); openChat(u.id); n.close(); };
    }
  }
  document.addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }, { once: true });

  /* ---------- reply ---------- */
  function startReply(m) {
    cancelEdit();
    replying = m;
    $('#replyWho').textContent = m.from === me.id ? 'You' : (users.get(m.from) || {}).name || '';
    $('#replyText').textContent = quoteText(snap(m));
    el.replyBar.classList.remove('hidden');
    el.text.focus();
  }
  function cancelReply() {
    if (!replying) return;
    replying = null;
    el.replyBar.classList.add('hidden');
  }
  $('#replyCancel').onclick = cancelReply;

  /* ---------- emoji picker ---------- */
  const EMOJIS = '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😗 😋 😛 😜 🤪 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 😶 😐 😑 😬 🙄 😯 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 👍 👎 👌 🤞 🤟 🤘 👏 🙌 🙏 💪 👋 🤝 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 🔥 ✨ 🎉 🎂 🎁 💯 ✅ ❌ 👀 🤷'.split(' ');
  el.emojiPop.innerHTML = EMOJIS.map((e) => `<button type="button">${e}</button>`).join('');
  function closeEmoji() { el.emojiPop.classList.add('hidden'); }
  $('#emojiBtn').onclick = () => el.emojiPop.classList.toggle('hidden');
  el.emojiPop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const i = el.text, s = b.textContent;
    const st = i.selectionStart ?? i.value.length, en = i.selectionEnd ?? st;
    if (i.maxLength > 0 && i.value.length - (en - st) + s.length > i.maxLength) return;
    i.value = i.value.slice(0, st) + s + i.value.slice(en);
    i.focus();
    i.setSelectionRange(st + s.length, st + s.length);
  });
  document.addEventListener('click', (e) => {
    if (!el.emojiPop.classList.contains('hidden') && !el.emojiPop.contains(e.target) && !e.target.closest('#emojiBtn')) closeEmoji();
  });

  /* ---------- voice messages ---------- */
  let rec = null;
  async function startRec() {
    if (!active || rec) return;
    if (Calls.busy) return toast('Finish your call first.', { type: 'error' });
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder)
      return toast('Voice messages need a secure (https) connection and a modern browser.', { type: 'error' });
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { return toast('Allow microphone access in your browser to record.', { type: 'error' }); }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const r = (rec = { mr, stream, chunks: [], t0: Date.now(), cancelled: false, timer: null });
    mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.onstop = () => {
      clearInterval(r.timer);
      r.stream.getTracks().forEach((t) => t.stop());
      if (rec === r) rec = null;
      el.recBar.classList.add('hidden');
      el.form.classList.remove('hidden');
      if (r.cancelled || !r.chunks.length) return;
      if (Date.now() - r.t0 < 1000) return toast('Record a little longer to send a voice message.', { ms: 2500 });
      const base = (mr.mimeType || mime || 'audio/webm').split(';')[0];
      const ext = base.includes('mp4') ? 'm4a' : base.includes('ogg') ? 'ogg' : 'webm';
      sendFile(new File(r.chunks, `voice-${Date.now()}.${ext}`, { type: base }));
    };
    mr.start(250);
    el.form.classList.add('hidden');
    el.recBar.classList.remove('hidden');
    $('#recTime').textContent = '0:00';
    r.timer = setInterval(() => {
      const s = Math.floor((Date.now() - r.t0) / 1000);
      $('#recTime').textContent = Math.floor(s / 60) + ':' + pad(s % 60);
      if (s >= 300) stopRec(false); // 5 minute limit
    }, 250);
  }
  function stopRec(cancel) {
    if (!rec) return;
    rec.cancelled = !!cancel;
    try { rec.mr.stop(); } catch {}
  }
  function cancelRec() { stopRec(true); }
  $('#micBtn').onclick = startRec;
  $('#recSend').onclick = () => stopRec(false);
  $('#recCancel').onclick = () => stopRec(true);

  /* ---------- theme ---------- */
  const SUN = '<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM2 13h2v-2H2v2zm18 0h2v-2h-2v2zM11 2v2h2V2h-2zm0 18v2h2v-2h-2zM5.6 5.6 4.2 7l1.4 1.4L7 7 5.6 5.6zm12.8 12.8L17 17l1.4 1.4 1.4-1.4-1.4-1.4zM17 7l1.4-1.4L17 4.2 15.6 5.6 17 7zM7 17l-1.4 1.4L7 19.8l1.4-1.4L7 17z"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9c0-.5 0-1-.1-1.5A5.5 5.5 0 0 1 13.5 3.1 9 9 0 0 0 12 3z"/></svg>';
  const paintTheme = () => {
    const light = getTheme() === 'light';
    $('#themeBtn').innerHTML = light ? MOON : SUN;
    $('#themeBtn').title = light ? 'Switch to dark mode' : 'Switch to light mode';
  };
  $('#themeBtn').onclick = () => { applyTheme(getTheme() === 'light' ? 'dark' : 'light'); paintTheme(); };
  paintTheme();

  /* ---------- profile ---------- */
  let newAvatar = '';
  const drawProfileAvatar = () => { $('#pAv').innerHTML = avatar({ name: $('#pName').value || me.name, avatar: newAvatar }, 120); };
  $('#meBtn').onclick = () => {
    $('#pName').value = me.name; $('#pAbout').value = me.about || ''; newAvatar = me.avatar || '';
    drawProfileAvatar();
    el.profile.classList.remove('hidden');
  };
  $('#pCancel').onclick = () => el.profile.classList.add('hidden');
  el.profile.addEventListener('click', (e) => { if (e.target === el.profile) el.profile.classList.add('hidden'); });
  $('#pName').addEventListener('input', drawProfileAvatar);
  $('#pPick').onclick = () => $('#pFile').click();
  $('#pRemove').onclick = () => { newAvatar = ''; drawProfileAvatar(); };
  $('#pFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { newAvatar = await resizeImage(f, 256); drawProfileAvatar(); }
    catch { toast('Could not read that image.', { type: 'error' }); }
  };
  function resizeImage(file, size) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = size;
        const s = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = url;
    });
  }
  $('#pSave').onclick = async () => {
    const btn = $('#pSave');
    btn.disabled = true; btn.innerHTML = '<div class="spinner"></div><span>Saving…</span>';
    try {
      const { user } = await api('/me', { method: 'PUT', body: { name: $('#pName').value, about: $('#pAbout').value, avatar: newAvatar } });
      Object.assign(me, user); renderMe();
      el.profile.classList.add('hidden');
      toast('Profile updated.', { type: 'success' });
    } catch (e) { toast(e.message, { type: 'error' }); }
    btn.disabled = false; btn.textContent = 'Save changes';
  };

  $('#logoutBtn').onclick = () => { Store.token = null; rt && rt.close(); location.replace('/'); };
})();
