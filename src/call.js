/* Voice / video calls (WebRTC). Signalling messages travel through the server (rt.send / rt.on). */
import { avatar, toast, pad } from './common.js';

export const Calls = (function () {
  const PHONE = '<svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.6 3.6a1 1 0 0 1-.25 1l-2.25 2.2z"/></svg>';
  const MIC = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z"/></svg>';
  const CAM = '<svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>';

  let rt, me, getUser, ice = [{ urls: 'stun:stun.l.google.com:19302' }];
  let state = 'idle'; // idle | calling | ringing | connecting | active
  let pc, local, peerId, wantVideo = false, offer = null, pendingIce = [];
  let ringTimer, noAnswerTimer, discTimer, clockTimer, startedAt = 0, built = false;
  const $ = (s) => document.querySelector(s);

  /* ---------- ringtone ---------- */
  let actx;
  function audioCtx() {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, dur, gain = 0.12, delay = 0) {
    try {
      const a = audioCtx(), o = a.createOscillator(), g = a.createGain(), t = a.currentTime + delay;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.03);
    } catch {}
  }
  function ringStart(kind) {
    ringStop();
    const play = () => { if (kind === 'in') { tone(880, 0.35); tone(660, 0.35, 0.12, 0.4); } else tone(440, 0.7, 0.07); };
    play();
    ringTimer = setInterval(play, kind === 'in' ? 2000 : 3000);
    if (kind === 'in' && navigator.vibrate) navigator.vibrate([300, 150, 300]);
  }
  function ringStop() { clearInterval(ringTimer); ringTimer = null; if (navigator.vibrate) navigator.vibrate(0); }
  document.addEventListener('click', () => { try { audioCtx(); } catch {} }, { once: true });

  /* ---------- UI ---------- */
  function build() {
    if (built) return;
    built = true;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="incoming hidden" id="incoming" role="alertdialog" aria-label="Incoming call">
        <span id="inAv"></span>
        <div class="in-info"><b id="inName"></b><span id="inType"></span></div>
        <button class="cbtn red" id="inDecline" type="button" aria-label="Decline">${PHONE}</button>
        <button class="cbtn green" id="inAccept" type="button" aria-label="Accept">${PHONE}</button>
      </div>
      <div class="call-ui hidden" id="callUI">
        <video id="remoteV" autoplay playsinline></video>
        <div class="call-id"><span id="cAv"></span><b id="cName"></b><span id="cStatus"></span></div>
        <video id="localV" autoplay muted playsinline></video>
        <div class="call-bar">
          <button class="cbtn" id="cMute" type="button" aria-label="Mute microphone">${MIC}</button>
          <button class="cbtn" id="cCam" type="button" aria-label="Turn camera off">${CAM}</button>
          <button class="cbtn red" id="cEnd" type="button" aria-label="End call">${PHONE}</button>
        </div>
      </div>`);
    $('#inAccept').onclick = accept;
    $('#inDecline').onclick = decline;
    $('#cEnd').onclick = () => end(true);
    $('#cMute').onclick = () => toggle('audio', '#cMute');
    $('#cCam').onclick = () => toggle('video', '#cCam');
  }
  const setStatus = (t) => { const e = $('#cStatus'); if (e) e.textContent = t; };
  function showCallUI(u, status) {
    build();
    $('#cAv').innerHTML = avatar(u, 110);
    $('#cName').textContent = u.name;
    $('#callUI').classList.toggle('video', wantVideo);
    $('#callUI').classList.remove('hidden');
    $('#cMute').classList.remove('off'); $('#cCam').classList.remove('off');
    setStatus(status);
  }
  function toggle(kind, sel) {
    if (!local) return;
    const tracks = kind === 'audio' ? local.getAudioTracks() : local.getVideoTracks();
    if (!tracks.length) return;
    const on = !tracks[0].enabled;
    tracks.forEach((t) => (t.enabled = on));
    $(sel).classList.toggle('off', !on);
  }

  /* ---------- media / peer connection ---------- */
  function mediaError(e) {
    if (!navigator.mediaDevices) return 'Calls need a secure (https) connection.';
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return 'Allow microphone / camera access in your browser to make calls.';
    if (e && e.name === 'NotFoundError') return 'No microphone or camera was found.';
    return 'Could not start the call.';
  }
  async function getMedia(video) {
    const audio = { echoCancellation: true, noiseSuppression: true };
    if (!video) return navigator.mediaDevices.getUserMedia({ audio, video: false });
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (e) {
      if (e && e.name === 'NotAllowedError') throw e;
      toast('Camera unavailable, continuing with audio only.');
      wantVideo = false;
      return navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
  }
  function showLocal() {
    const lv = $('#localV');
    lv.srcObject = local;
    const hasVideo = local.getVideoTracks().length > 0;
    $('#callUI').classList.toggle('video', wantVideo && hasVideo);
    $('#cCam').classList.toggle('hidden', !hasVideo);
  }
  function newPC() {
    const p = new RTCPeerConnection({ iceServers: ice });
    p.onicecandidate = (e) => { if (e.candidate && peerId) rt.send(peerId, 'call:ice', { candidate: e.candidate.toJSON() }).catch(() => {}); };
    p.ontrack = (e) => {
      const rv = $('#remoteV');
      if (rv.srcObject !== e.streams[0]) rv.srcObject = e.streams[0];
      if (e.track.kind === 'video') $('#callUI').classList.add('video');
    };
    p.onconnectionstatechange = () => {
      if (p !== pc) return;
      const st = p.connectionState;
      if (st === 'connected') { clearTimeout(discTimer); onConnected(); }
      else if (st === 'disconnected') {
        setStatus('Reconnecting…');
        clearTimeout(discTimer);
        discTimer = setTimeout(() => { if (pc === p && p.connectionState !== 'connected') end(true); }, 8000);
      } else if (st === 'failed') {
        toast('The call could not connect. Your network may be blocking calls.', { type: 'error' });
        end(true);
      }
    };
    return p;
  }
  function onConnected() {
    if (state === 'active') { updateClock(); return; }
    state = 'active';
    clearTimeout(noAnswerTimer);
    ringStop();
    startedAt = Date.now();
    updateClock();
    clockTimer = setInterval(updateClock, 1000);
  }
  function updateClock() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    setStatus(pad(Math.floor(s / 60)) + ':' + pad(s % 60));
  }
  async function flushIce() {
    for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
    pendingIce = [];
  }

  /* ---------- actions ---------- */
  async function start(id, video) {
    if (state !== 'idle') return toast('You are already in a call.', { type: 'error' });
    const u = getUser(id);
    if (!u) return;
    if (!u.online) return toast(u.name + ' is offline.', { type: 'error' });
    if (!navigator.mediaDevices || !window.RTCPeerConnection) return toast('Calls need a secure (https) connection and a modern browser.', { type: 'error' });
    peerId = id; wantVideo = !!video; state = 'calling'; rt.setFast(true);
    showCallUI(u, 'Starting…');
    try {
      local = await getMedia(wantVideo);
      showLocal();
      pc = newPC();
      local.getTracks().forEach((t) => pc.addTrack(t, local));
      await pc.setLocalDescription(await pc.createOffer());
    } catch (e) { cleanup(); return toast(mediaError(e), { type: 'error' }); }
    rt.send(id, 'call:offer', { video: wantVideo, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } })
      .then(() => {
        if (state !== 'calling') return;
        setStatus('Ringing…');
        ringStart('out');
        noAnswerTimer = setTimeout(() => { if (state === 'calling') { end(true); toast(u.name + ' did not answer.'); } }, 45000);
      })
      .catch(() => {
        if (state !== 'calling') return;
        cleanup();
        toast('Could not reach ' + u.name + '. Check your connection.', { type: 'error' });
      });
  }

  async function accept() {
    if (state !== 'ringing' || !offer) return;
    ringStop();
    $('#incoming').classList.add('hidden');
    state = 'connecting';
    const u = getUser(peerId) || { name: 'Caller' };
    showCallUI(u, 'Connecting…');
    try {
      local = await getMedia(wantVideo);
      showLocal();
      pc = newPC();
      local.getTracks().forEach((t) => pc.addTrack(t, local));
      await pc.setRemoteDescription(offer.sdp);
      await flushIce();
      await pc.setLocalDescription(await pc.createAnswer());
      rt.send(peerId, 'call:answer', { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }).catch(() => {});
      rt.send(me.id, 'call:handled', {}).catch(() => {}); // stop ringing in my other tabs
    } catch (e) {
      rt.send(peerId, 'call:reject', {}).catch(() => {});
      cleanup();
      toast(mediaError(e), { type: 'error' });
    }
  }

  function decline() {
    if (state !== 'ringing') return;
    rt.send(peerId, 'call:reject', {}).catch(() => {});
    rt.send(me.id, 'call:handled', {}).catch(() => {});
    cleanup();
  }

  function end(notify) {
    if (state === 'idle') return;
    const secs = state === 'active' ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    if (notify && peerId) rt.send(peerId, 'call:end', {}).catch(() => {});
    cleanup();
    if (secs) toast('Call ended · ' + pad(Math.floor(secs / 60)) + ':' + pad(secs % 60));
  }

  function cleanup() {
    ringStop();
    clearTimeout(noAnswerTimer); clearTimeout(discTimer); clearInterval(clockTimer);
    if (pc) { pc.onconnectionstatechange = null; pc.onicecandidate = null; pc.ontrack = null; try { pc.close(); } catch {} }
    if (local) local.getTracks().forEach((t) => t.stop());
    pc = null; local = null; offer = null; pendingIce = []; peerId = null; wantVideo = false; startedAt = 0;
    state = 'idle';
    if (rt) rt.setFast(false);
    if (built) {
      $('#callUI').classList.add('hidden');
      $('#incoming').classList.add('hidden');
      $('#remoteV').srcObject = null;
      $('#localV').srcObject = null;
    }
  }

  /* ---------- signalling events ---------- */
  function init(opts) {
    rt = opts.rt; me = opts.me; getUser = opts.getUser;
    if (opts.iceServers && opts.iceServers.length) ice = opts.iceServers;
    build();

    rt.on('call:offer', ({ from, video, sdp }) => {
      if (state !== 'idle') { rt.send(from, 'call:busy', {}).catch(() => {}); return; }
      const u = getUser(from) || { name: 'Someone' };
      offer = { sdp }; peerId = from; wantVideo = !!video; pendingIce = []; state = 'ringing'; rt.setFast(true);
      $('#inAv').innerHTML = avatar(u, 52);
      $('#inName').textContent = u.name;
      $('#inType').textContent = 'Incoming ' + (video ? 'video' : 'voice') + ' call…';
      $('#incoming').classList.remove('hidden');
      ringStart('in');
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(u.name, { body: 'Incoming ' + (video ? 'video' : 'voice') + ' call', icon: u.avatar || undefined, requireInteraction: true });
        n.onclick = () => { window.focus(); n.close(); };
      }
    });

    rt.on('call:answer', async ({ from, sdp }) => {
      if (state !== 'calling' || from !== peerId || !pc) return;
      clearTimeout(noAnswerTimer); ringStop();
      state = 'connecting';
      setStatus('Connecting…');
      try { await pc.setRemoteDescription(sdp); await flushIce(); } catch { end(true); }
    });

    rt.on('call:ice', async ({ from, candidate }) => {
      if (from !== peerId || !candidate) return;
      if (pc && pc.remoteDescription) { try { await pc.addIceCandidate(candidate); } catch {} }
      else pendingIce.push(candidate);
    });

    rt.on('call:reject', ({ from }) => {
      if (from !== peerId) return;
      const u = getUser(from);
      cleanup();
      toast((u ? u.name : 'The other person') + ' declined the call.');
    });

    rt.on('call:end', ({ from }) => {
      if (from !== peerId) return;
      const u = getUser(from);
      if (state === 'ringing') { cleanup(); toast('Missed call from ' + (u ? u.name : 'someone'), { type: 'error' }); }
      else end(false);
    });

    rt.on('call:busy', ({ from }) => {
      if (state !== 'calling' || from !== peerId) return;
      const u = getUser(from);
      cleanup();
      toast((u ? u.name : 'The other person') + ' is busy on another call.', { type: 'error' });
    });

    // Another tab of mine answered or declined this call.
    rt.on('call:handled', ({ from }) => { if (from === me.id && state === 'ringing') cleanup(); });
  }

  return { init, start, get busy() { return state !== 'idle'; } };
})();
