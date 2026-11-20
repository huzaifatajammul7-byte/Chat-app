import './style.css';
import { Store, api } from './common.js';

(function () {
  const $ = (s) => document.querySelector(s);
  const form = $('#form'), tabs = $('#tabs'), err = $('#error'), btn = $('#submit');
  let mode = 'login';

  const go = (user) => location.replace(user.role === 'admin' ? '/admin.html' : '/chat.html');
  const hideSplash = () => setTimeout(() => $('#splash').classList.add('out'), 250);

  // Already logged in? skip this page.
  (async () => {
    if (!Store.token) return hideSplash();
    try { go((await api('/me')).user); } catch { Store.token = null; hideSplash(); }
  })();

  function setMode(m) {
    mode = m;
    form.classList.toggle('login-mode', m === 'login');
    tabs.classList.toggle('signup', m === 'signup');
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('#title').textContent = m === 'login' ? 'Welcome back' : 'Create your account';
    $('#sub').textContent = m === 'login' ? 'Log in to continue your chats.' : 'Join in a few seconds and start chatting.';
    $('#btnText').textContent = m === 'login' ? 'Log in' : 'Create account';
    $('#password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
    err.textContent = '';
  }
  tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
  $('#eye').onclick = () => {
    const p = $('#password'); const show = p.type === 'password';
    p.type = show ? 'text' : 'password'; $('#eye').textContent = show ? 'Hide' : 'Show';
  };

  function fail(msg) {
    err.textContent = msg;
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const body = { email: $('#email').value.trim(), password: $('#password').value };
    if (mode === 'signup') body.name = $('#name').value.trim();
    if (mode === 'signup' && body.name.length < 2) return fail('Enter your name.');
    if (!body.email || !body.password) return fail('Enter your email and password.');

    btn.disabled = true;
    const label = $('#btnText').textContent;
    btn.innerHTML = '<div class="spinner"></div><span>Please wait…</span>';
    try {
      const { token, user } = await api(mode === 'login' ? '/login' : '/signup', { method: 'POST', body });
      Store.token = token;
      go(user);
    } catch (ex) {
      fail(ex.message);
      btn.disabled = false;
      btn.innerHTML = `<span id="btnText">${label}</span>`;
    }
  });
})();
