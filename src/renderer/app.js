/* global Peer */
'use strict';

// ---------------------------------------------------------------------------
// How a room works
// A room has up to MAX_SLOTS seats. Each seat is a PeerJS id: "<room>-1",
// "<room>-2", ... A newcomer takes the first free seat, then dials every other
// seat. Whoever answers is in the room. Every pair of people gets its own
// direct (peer-to-peer) link: a data channel for names/mute/share state and a
// media call for voice. The PeerJS signaling server only introduces people;
// voice and video never pass through it.
// ---------------------------------------------------------------------------

const ROOM_PREFIX = 'communicator-v2-';
const MAX_SLOTS = 8;
const OPEN_TIMEOUT_MS = 12000;
const REDIAL_EVERY_MS = 3000;
const SESSION = Math.random().toString(36).slice(2, 10); // tells a restart apart from a duplicate

const $ = (id) => document.getElementById(id);

const settings = loadSettings();

const state = {
  peer: null,
  slot: null,          // my seat number once claimed
  leaving: true,
  localStream: null,
  muted: false,
  members: new Map(),  // slot -> member
  redial: new Map(),   // slot -> give-up time, for people whose link dropped
  redialTimer: null,
  statsTimer: null,
  retryTimer: null,
  audioCtx: null,
  localMeter: null,
  myScreen: null,      // { stream, smooth, calls: Map(slot -> call) }
  watching: null,      // slot whose screen is shown
  info: {},
  testShared: false,
};

// ---------------------------------------------------------------- settings --

function loadSettings() {
  const defaults = {
    room: '', name: '', inputId: '', outputId: '', echo: true, noise: true,
    shareMode: 'motion', volumes: {},
  };
  // Saved in %APPDATA%\Communicator\settings.json by the main process.
  let saved = null;
  try { saved = window.communicator.loadSettings(); } catch { /* use defaults */ }
  if (!saved) {
    // First run after the move to settings.json: carry over the old browser-storage copy.
    try {
      saved = JSON.parse(localStorage.getItem('settings') || 'null');
      if (saved) window.communicator.saveSettings({ ...defaults, ...saved });
    } catch { saved = null; }
  }
  return { ...defaults, ...(saved || {}) };
}

function saveSettings() {
  try {
    window.communicator.saveSettings(settings);
  } catch (err) {
    console.error('[settings] save failed', err);
  }
}

function cleanRoom(text) {
  return String(text || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

function cleanName(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function slotId(n) {
  return `${ROOM_PREFIX}${settings.room}-${n}`;
}

function slotFromId(id) {
  const m = /-(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : null;
}

// --------------------------------------------------------------------- UI --

function setStatus(kind, title, pill = title) {
  $('statusPill').dataset.kind = kind;
  $('statusText').textContent = pill;
  $('callTitle').textContent = title;
  if (document.body.dataset.status !== kind || $('callTitle').dataset.last !== title) {
    console.log(`[status] ${kind}: ${title}`);
    $('callTitle').dataset.last = title;
  }
  document.body.dataset.status = kind;
}

function showView(name) {
  $('setupView').hidden = name !== 'setup';
  $('callView').hidden = name !== 'call';
}

function liveMembers() {
  return [...state.members.values()].filter((m) => m.voiceUp);
}

function updateRoomStatus() {
  if (state.leaving || state.slot == null) return;
  const live = liveMembers().length;
  if (live === 0) {
    const pending = [...state.members.values()].some((m) => !m.voiceUp);
    setStatus('waiting', pending ? 'Connecting…' : 'Waiting for others…', pending ? 'Connecting' : 'Waiting');
  } else {
    setStatus('connected', live === 1 ? 'Talking with 1 person' : `Talking with ${live} people`, `Connected · ${live + 1}`);
  }
  renderShare();
}

function renderMute() {
  const btn = $('muteBtn');
  btn.classList.toggle('muted', state.muted);
  btn.setAttribute('aria-pressed', String(state.muted));
  $('muteLabel').textContent = state.muted ? 'Unmute' : 'Mute';
}

function hueFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function makeAvatar(name) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.textContent = (name || '?').charAt(0).toUpperCase();
  el.style.setProperty('--hue', hueFor(name || '?'));
  return el;
}

function badge(text, cls) {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

// Rebuild the people list. Fast-changing bits (speaking glow, ping) are
// updated in place by drawMeters() and the stats timer.
function renderPeople() {
  const list = $('peopleList');
  list.innerHTML = '';

  // Me first.
  const me = document.createElement('li');
  me.className = 'person me';
  const myAvatar = makeAvatar(settings.name);
  state.myAvatar = myAvatar;
  const meInfo = document.createElement('div');
  meInfo.className = 'pinfo';
  const meName = document.createElement('div');
  meName.className = 'pname';
  meName.append(document.createTextNode(settings.name), badge('you', 'you'));
  if (state.muted) meName.append(badge('Muted', 'muted'));
  if (state.myScreen) meName.append(badge('Sharing', 'live'));
  const meMeta = document.createElement('div');
  meMeta.className = 'pmeta';
  meMeta.textContent = state.slot ? `Seat ${state.slot}` : 'Joining…';
  meInfo.append(meName, meMeta);
  me.append(myAvatar, meInfo);
  list.appendChild(me);

  const others = [...state.members.values()].sort((a, b) => a.slot - b.slot);
  for (const m of others) {
    const li = document.createElement('li');
    li.className = 'person';
    const avatar = makeAvatar(m.name || '?');
    const info = document.createElement('div');
    info.className = 'pinfo';
    const name = document.createElement('div');
    name.className = 'pname';
    name.append(document.createTextNode(m.name || 'Joining…'));
    if (m.muted) name.append(badge('Muted', 'muted'));
    if (m.screenStream) {
      const live = badge(state.watching === m.slot ? 'Watching' : 'Live', 'live clickable');
      live.title = 'Watch their screen';
      live.onclick = () => watch(m.slot);
      name.append(live);
    } else if (m.sharing) {
      name.append(badge('Live', 'live'));
    }
    const meta = document.createElement('div');
    meta.className = 'pmeta';
    meta.textContent = m.voiceUp ? (m.metaText || 'Connected') : 'Connecting…';
    if (m.metaTitle) meta.title = m.metaTitle;
    info.append(name, meta);

    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.className = 'pvol';
    vol.title = `${m.name || 'Their'} volume`;
    vol.value = String(Math.round(m.volume * 100));
    vol.disabled = !m.voiceUp;
    vol.oninput = () => {
      m.volume = Number(vol.value) / 100;
      if (m.audio) m.audio.volume = m.volume;
      if (m.name) {
        settings.volumes[m.name] = m.volume;
        saveSettings();
      }
    };

    li.append(avatar, info, vol);
    list.appendChild(li);
    m.avatarEl = avatar;
    m.metaEl = meta;
  }

  $('peopleCount').textContent = `${others.length + 1} / ${MAX_SLOTS}`;
}

// -------------------------------------------------------------- mic / audio --

function micConstraints(useDevice = true) {
  return {
    audio: {
      deviceId: useDevice && settings.inputId ? { exact: settings.inputId } : undefined,
      echoCancellation: settings.echo,
      noiseSuppression: settings.noise,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
      latency: 0,
    },
    video: false,
  };
}

async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(true));
  } catch (err) {
    if (settings.inputId) {
      // Saved device was unplugged: fall back to the default microphone.
      settings.inputId = '';
      saveSettings();
      return navigator.mediaDevices.getUserMedia(micConstraints(false));
    }
    throw err;
  }
}

async function startMic() {
  const stream = await getMic();
  const old = state.localStream;
  state.localStream = stream;
  stream.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });

  // Swap the track in every running call without reconnecting.
  const track = stream.getAudioTracks()[0];
  for (const m of state.members.values()) {
    const pc = m.call && m.call.peerConnection;
    if (!pc) continue;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    if (sender) await sender.replaceTrack(track).catch(() => {});
  }
  if (old) old.getTracks().forEach((t) => t.stop());
  if (state.localMeter) state.localMeter.source.disconnect();
  state.localMeter = makeMeter(stream);
  await refreshDevices();
}

function ensureAudioCtx() {
  if (!state.audioCtx) state.audioCtx = new AudioContext({ latencyHint: 'interactive' });
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  return state.audioCtx;
}

function makeMeter(stream) {
  const ctx = ensureAudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  return { analyser, data: new Uint8Array(analyser.fftSize), source };
}

function meterLevel(meter) {
  meter.analyser.getByteTimeDomainData(meter.data);
  let peak = 0;
  for (let i = 0; i < meter.data.length; i++) peak = Math.max(peak, Math.abs(meter.data[i] - 128));
  return Math.min(1, peak / 64);
}

// Light up the avatar of whoever is talking.
function drawMeters() {
  if (state.localMeter && state.myAvatar) {
    const level = state.muted ? 0 : meterLevel(state.localMeter);
    state.myAvatar.classList.toggle('speaking', level > 0.12);
  }
  for (const m of state.members.values()) {
    if (m.meter && m.avatarEl) m.avatarEl.classList.toggle('speaking', !m.muted && meterLevel(m.meter) > 0.12);
  }
  requestAnimationFrame(drawMeters);
}

async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect($('inputSelect'), devices.filter((d) => d.kind === 'audioinput'), settings.inputId);
  fillSelect($('outputSelect'), devices.filter((d) => d.kind === 'audiooutput'), settings.outputId);
}

function fillSelect(select, devices, selected) {
  select.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'System default';
  select.appendChild(def);
  for (const d of devices) {
    if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || 'Unnamed device';
    select.appendChild(opt);
  }
  select.value = [...select.options].some((o) => o.value === selected) ? selected : '';
}

async function applyOutputDevice(audio) {
  if (!audio || typeof audio.setSinkId !== 'function') return;
  try {
    await audio.setSinkId(settings.outputId || '');
  } catch {
    settings.outputId = '';
    saveSettings();
  }
}

// Tune the Opus codec for low delay: 10 ms frames, no silence gaps,
// forward error correction so a lost packet doesn't cause a hiccup.
function tuneOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000[^\r\n]*\r\n/i);
  if (!m) return sdp;
  const pt = m[1];
  const wanted = { minptime: '10', useinbandfec: '1', usedtx: '0', stereo: '0', maxaveragebitrate: '64000' };
  const fmtpRe = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);

  if (fmtpRe.test(sdp)) {
    sdp = sdp.replace(fmtpRe, (_line, params) => {
      const map = new Map();
      for (const part of params.split(';')) {
        const p = part.trim();
        if (!p) continue;
        const i = p.indexOf('=');
        map.set(i === -1 ? p : p.slice(0, i), i === -1 ? '' : p.slice(i + 1));
      }
      for (const [k, v] of Object.entries(wanted)) map.set(k, v);
      return `a=fmtp:${pt} ${[...map].map(([k, v]) => `${k}=${v}`).join(';')}`;
    });
  }
  if (!/a=ptime:/i.test(sdp)) {
    sdp = sdp.replace(m[0], `${m[0]}a=ptime:10\r\n`);
  }
  return sdp;
}

// WebRTC normally starts video at ~0.3 Mbps and ramps up slowly. On fiber we
// can start high so a screen share is sharp within a second or two.
function tuneVideoSdp(sdp) {
  const extra = 'x-google-start-bitrate=6000;x-google-min-bitrate=2000;x-google-max-bitrate=10000';
  const lines = sdp.split('\r\n');
  const out = [];
  let inVideo = false;
  const videoPts = new Set();
  const hasFmtp = new Set();

  for (const line of lines) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    if (!inVideo) continue;
    const rtp = line.match(/^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i);
    if (rtp) videoPts.add(rtp[1]);
    const f = line.match(/^a=fmtp:(\d+) /);
    if (f) hasFmtp.add(f[1]);
  }

  inVideo = false;
  for (const line of lines) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    const f = inVideo && line.match(/^a=fmtp:(\d+) (.*)$/);
    if (f && videoPts.has(f[1]) && !f[2].includes('x-google-start-bitrate')) {
      out.push(`${line};${extra}`);
      continue;
    }
    out.push(line);
    const rtp = inVideo && line.match(/^a=rtpmap:(\d+) /);
    if (rtp && videoPts.has(rtp[1]) && !hasFmtp.has(rtp[1])) {
      out.push(`a=fmtp:${rtp[1]} ${extra}`);
    }
  }
  return out.join('\r\n');
}

function lowLatencyReceivers(pc) {
  for (const r of pc.getReceivers()) {
    try {
      if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
      if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
    } catch { /* not supported */ }
  }
}

// ---------------------------------------------------------------- members --

function newMember(slot) {
  const m = {
    slot,
    id: slotId(slot),
    name: '',
    session: null,
    dc: null,
    dcOpen: false,
    call: null,
    voiceUp: false,
    stream: null,
    audio: null,
    meter: null,
    muted: false,
    sharing: false,
    screenCall: null,
    screenStream: null,
    volume: 1,
    openTimer: null,
    discTimer: null,
    lastInbound: null,
    metaText: '',
    metaTitle: '',
    closed: false,
  };
  state.members.set(slot, m);
  return m;
}

function setMemberName(m, name) {
  m.name = cleanName(name) || 'Guest';
  const saved = settings.volumes[m.name];
  if (typeof saved === 'number') m.volume = saved;
  if (m.audio) m.audio.volume = m.volume;
}

function send(m, msg) {
  if (!m.dcOpen || !m.dc) return;
  try { m.dc.send(msg); } catch { /* channel closing */ }
}

function broadcast(msg) {
  for (const m of state.members.values()) send(m, msg);
}

function myState() {
  return { type: 'state', muted: state.muted, sharing: Boolean(state.myScreen) };
}

function sendHello(m) {
  send(m, { type: 'hello', name: settings.name, session: SESSION, muted: state.muted, sharing: Boolean(state.myScreen) });
}

// Data channel: names, mute and share state.
function bindData(m, dc) {
  dc.on('open', () => {
    if (m.closed || m.dc !== dc) return;
    m.dcOpen = true;
    clearTimeout(m.openTimer);
    sendHello(m);
    // The side that dialled starts the voice call.
    if (m.initiator) {
      const call = state.peer.call(m.id, state.localStream, {
        sdpTransform: tuneOpus,
        metadata: { kind: 'voice', slot: state.slot, session: SESSION },
      });
      if (call) attachVoice(m, call);
    }
  });

  dc.on('data', (msg) => {
    if (m.closed || m.dc !== dc || !msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      setMemberName(m, msg.name);
      m.session = msg.session || m.session;
      m.muted = Boolean(msg.muted);
      m.sharing = Boolean(msg.sharing);
      renderPeople();
    } else if (msg.type === 'state') {
      m.muted = Boolean(msg.muted);
      m.sharing = Boolean(msg.sharing);
      if (!m.sharing) closeScreenFrom(m);
      renderPeople();
    } else if (msg.type === 'bye') {
      console.log(`[member] ${m.name} left`);
      dropMember(m);
    }
  });

  dc.on('close', () => lost(m, dc));
  dc.on('error', () => lost(m, dc));
}

function attachVoice(m, call) {
  if (m.call && m.call !== call) {
    try { m.call.close(); } catch { /* ignore */ }
  }
  m.call = call;

  call.on('stream', (stream) => {
    if (m.closed || m.call !== call || m.voiceUp) return;
    m.voiceUp = true;
    m.stream = stream;
    state.redial.delete(m.slot);

    const audio = new Audio();
    audio.autoplay = true;
    audio.srcObject = stream;
    audio.volume = m.volume;
    $('audioHost').appendChild(audio);
    m.audio = audio;
    applyOutputDevice(audio).then(() => audio.play().catch(() => {}));

    if (call.peerConnection) lowLatencyReceivers(call.peerConnection);
    m.meter = makeMeter(stream);
    console.log(`[member] ${m.name || '?'} connected (seat ${m.slot})`);
    renderPeople();
    updateRoomStatus();
    if (state.myScreen) sendScreenTo(m);
    maybeTestShare();
  });
  call.on('close', () => lost(m, call));
  call.on('error', () => lost(m, call));

  const pc = call.peerConnection;
  if (pc) {
    pc.addEventListener('iceconnectionstatechange', () => {
      if (m.closed || m.call !== call) return;
      const s = pc.iceConnectionState;
      clearTimeout(m.discTimer);
      if (s === 'failed') {
        lost(m, call);
      } else if (s === 'disconnected') {
        m.discTimer = setTimeout(() => {
          const now = pc.iceConnectionState;
          if (m.call === call && now !== 'connected' && now !== 'completed') lost(m, call);
        }, 5000);
      }
    });
  }
}

// A link to someone dropped unexpectedly: clean up and keep trying to reach
// them for a minute (both sides do this; duplicates are resolved on arrival).
function lost(m, source) {
  if (m.closed || state.members.get(m.slot) !== m) return;
  if (source && source !== m.dc && source !== m.call) return;
  const wasUp = m.dcOpen || m.voiceUp;
  console.log(`[member] lost link to ${m.name || `seat ${m.slot}`}`);
  dropMember(m);
  if (wasUp && !state.leaving) state.redial.set(m.slot, Date.now() + 60000);
}

function dropMember(m) {
  if (m.closed) return;
  m.closed = true;
  if (state.members.get(m.slot) === m) state.members.delete(m.slot);
  clearTimeout(m.openTimer);
  clearTimeout(m.discTimer);

  if (state.myScreen) {
    const out = state.myScreen.calls.get(m.slot);
    state.myScreen.calls.delete(m.slot);
    if (out) try { out.close(); } catch { /* ignore */ }
  }
  for (const c of [m.call, m.dc, m.screenCall]) {
    if (c) try { c.close(); } catch { /* ignore */ }
  }
  if (m.audio) {
    m.audio.pause();
    m.audio.srcObject = null;
    m.audio.remove();
  }
  if (m.meter) m.meter.source.disconnect();
  m.screenStream = null;
  if (state.watching === m.slot) pickWatch();

  renderPeople();
  updateRoomStatus();
}

// ------------------------------------------------------------- connection --

async function join() {
  const name = cleanName($('nameInput').value || settings.name);
  const room = cleanRoom($('roomInput').value || settings.room);
  if (!name) { $('nameInput').focus(); return; }
  if (!room) { $('roomInput').focus(); return; }
  settings.name = name;
  settings.room = room;
  saveSettings();

  $('roomName').textContent = settings.room;
  state.leaving = false;
  showView('call');
  renderPeople();
  setStatus('connecting', 'Starting microphone…', 'Starting');
  ensureAudioCtx();

  try {
    if (!state.localStream) await startMic();
  } catch (err) {
    setStatus('error', 'No microphone access', 'No mic');
    console.error(err);
    scheduleRetry(5000);
    return;
  }
  connect();
}

function connect() {
  clearTimeout(state.retryTimer);
  if (state.leaving) return;
  destroyAll();
  setStatus('connecting', 'Connecting…', 'Connecting');
  claimSlot(1);
}

function claimSlot(n) {
  if (state.leaving) return;
  if (n > MAX_SLOTS) {
    setStatus('error', `Room is full (${MAX_SLOTS} people)`, 'Room full');
    scheduleRetry(8000);
    return;
  }

  const peer = new Peer(slotId(n), { debug: 0 });
  state.peer = peer;

  peer.on('open', () => {
    if (state.peer !== peer) return;
    if (state.slot == null) {
      state.slot = n;
      console.log(`[room] joined "${settings.room}" in seat ${n}`);
      renderPeople();
      updateRoomStatus();
      // Say hello to every other seat; whoever answers is in the room.
      for (let s = 1; s <= MAX_SLOTS; s++) if (s !== n) dial(s);
      clearInterval(state.redialTimer);
      state.redialTimer = setInterval(redialLost, REDIAL_EVERY_MS);
      clearInterval(state.statsTimer);
      state.statsTimer = setInterval(readAllStats, 1500);
    }
  });

  peer.on('connection', (dc) => { if (state.peer === peer) onIncomingData(dc); });
  peer.on('call', (call) => { if (state.peer === peer) onIncomingCall(call); });

  peer.on('disconnected', () => {
    // Lost the signaling server. Existing calls keep working; reconnect quietly.
    setTimeout(() => {
      if (state.peer === peer && !peer.destroyed && peer.disconnected) {
        try { peer.reconnect(); } catch { /* error handler retries */ }
      }
    }, 1000);
  });

  peer.on('error', (err) => {
    if (state.peer !== peer) return;
    if (err.type === 'peer-unavailable') {
      // Nobody in that seat. Forget the attempt (a dropped person stays on the redial list).
      const m = state.members.get(slotFromId(String(err.message).split(' ').pop()));
      if (m && !m.dcOpen) dropMember(m);
      return;
    }
    if (err.type === 'unavailable-id') {
      if (state.slot == null) {
        peer.destroy();
        claimSlot(n + 1); // seat taken, try the next one
      } else {
        scheduleRetry(1000); // lost our seat while reconnecting: rejoin from scratch
      }
      return;
    }
    console.warn('peer error:', err.type, err.message);
    if (state.slot == null) {
      setStatus('connecting', 'Can’t reach the server, retrying…', 'Retrying');
      scheduleRetry(3000);
    } else if (peer.disconnected && !peer.destroyed) {
      setTimeout(() => {
        if (state.peer === peer && !peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); } catch { /* try again on next error */ }
        }
      }, 3000);
    }
  });
}

function dial(slot) {
  if (!state.peer || state.peer.disconnected || state.members.has(slot) || slot === state.slot) return;
  const dc = state.peer.connect(slotId(slot), {
    reliable: true,
    metadata: { slot: state.slot, name: settings.name, session: SESSION },
  });
  if (!dc) return;
  const m = newMember(slot);
  m.dc = dc;
  m.initiator = true;
  m.openTimer = setTimeout(() => {
    if (!m.dcOpen && !m.closed) {
      dropMember(m);
      if (!state.redial.has(slot)) state.redial.set(slot, Date.now() + 30000);
    }
  }, OPEN_TIMEOUT_MS);
  bindData(m, dc);
}

function redialLost() {
  const now = Date.now();
  for (const [slot, until] of state.redial) {
    if (now > until) state.redial.delete(slot);
    else if (!state.members.has(slot)) dial(slot);
  }
}

function onIncomingData(dc) {
  const meta = dc.metadata || {};
  const slot = Number(meta.slot);
  if (!slot || slot === state.slot || slot > MAX_SLOTS) {
    dc.close();
    return;
  }

  const existing = state.members.get(slot);
  if (existing) {
    const restarted = existing.session && meta.session && existing.session !== meta.session;
    // Both of us dialled at the same time: keep the link started by the lower seat.
    if (!restarted && state.slot < slot) {
      dc.close();
      return;
    }
    dropMember(existing);
  }

  const m = newMember(slot);
  m.dc = dc;
  m.initiator = false;
  m.session = meta.session || null;
  setMemberName(m, meta.name);
  m.openTimer = setTimeout(() => { if (!m.dcOpen && !m.closed) dropMember(m); }, OPEN_TIMEOUT_MS);
  bindData(m, dc);
  renderPeople();
}

function onIncomingCall(call) {
  const meta = call.metadata || {};
  const m = state.members.get(Number(meta.slot));
  if (!m || m.closed) {
    call.close();
    return;
  }
  if (meta.kind === 'screen') {
    acceptScreen(m, call);
    return;
  }
  call.answer(state.localStream, { sdpTransform: tuneOpus });
  attachVoice(m, call);
}

function scheduleRetry(ms) {
  clearTimeout(state.retryTimer);
  if (state.leaving) return;
  state.retryTimer = setTimeout(() => {
    if (state.localStream) connect();
    else join();
  }, ms);
}

function destroyAll() {
  clearInterval(state.redialTimer);
  clearInterval(state.statsTimer);
  state.redial.clear();
  for (const m of [...state.members.values()]) dropMember(m);
  if (state.peer) {
    const p = state.peer;
    state.peer = null;
    try { p.destroy(); } catch { /* ignore */ }
  }
  state.slot = null;
}

async function leave() {
  state.leaving = true;
  clearTimeout(state.retryTimer);
  broadcast({ type: 'bye' });
  stopShare();
  showView('setup');
  setStatus('idle', 'Not connected');
  await new Promise((r) => setTimeout(r, 150)); // let the goodbye go out
  destroyAll();
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  if (state.localMeter) {
    state.localMeter.source.disconnect();
    state.localMeter = null;
  }
}

// ----------------------------------------------------------- screen share --
// A screen share is a separate call to each person, next to the voice call,
// so starting or stopping it never interrupts the voice.

function renderShare() {
  const btn = $('shareBtn');
  const sharing = Boolean(state.myScreen);
  btn.disabled = !sharing && liveMembers().length === 0;
  btn.classList.toggle('active', sharing);
  $('shareLabel').textContent = sharing ? 'Stop sharing' : 'Share screen';
  $('sharingNote').hidden = !sharing;
}

function pickSource(sources) {
  return new Promise((resolve) => {
    const modal = $('picker');
    const grid = $('sourceGrid');
    grid.innerHTML = '';

    const finish = (id) => {
      modal.hidden = true;
      $('pickerCancel').onclick = null;
      modal.onclick = null;
      resolve(id);
    };

    const ordered = [...sources.filter((s) => s.isScreen), ...sources.filter((s) => !s.isScreen)];
    let screenNo = 0;
    for (const s of ordered) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'source';
      const img = document.createElement('div');
      img.className = 'thumb';
      if (s.thumb) img.style.backgroundImage = `url("${s.thumb}")`;
      const name = document.createElement('span');
      name.textContent = s.isScreen ? `Screen ${++screenNo}` : s.name;
      name.title = s.name;
      item.append(img, name);
      item.onclick = () => finish(s.id);
      grid.appendChild(item);
    }
    if (!ordered.length) grid.textContent = 'Nothing to share was found.';

    for (const radio of document.querySelectorAll('input[name="shareMode"]')) {
      radio.checked = radio.value === settings.shareMode;
      radio.onchange = () => { settings.shareMode = radio.value; saveSettings(); };
    }
    $('pickerCancel').onclick = () => finish(null);
    modal.onclick = (e) => { if (e.target === modal) finish(null); };
    modal.hidden = false;
  });
}

async function startShare(presetSourceId) {
  if (state.myScreen || !state.peer || liveMembers().length === 0) return;

  let sourceId = presetSourceId;
  if (!sourceId) {
    const sources = await window.communicator.getScreenSources();
    sourceId = await pickSource(sources);
    if (!sourceId) return;
  }
  await window.communicator.selectScreenSource(sourceId);

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
  } catch (err) {
    console.error('screen capture failed', err);
    return;
  }
  if (state.leaving || !state.peer) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  const smooth = settings.shareMode !== 'detail';
  const track = stream.getVideoTracks()[0];
  track.contentHint = smooth ? 'motion' : 'detail';
  track.addEventListener('ended', stopShare); // e.g. the shared window was closed

  state.myScreen = { stream, smooth, calls: new Map() };
  for (const m of liveMembers()) sendScreenTo(m);
  broadcast(myState());
  console.log(`[screen] sharing ${track.getSettings().width}x${track.getSettings().height} (${smooth ? 'smooth' : 'sharp'})`);
  renderShare();
  renderPeople();
}

function sendScreenTo(m) {
  const mine = state.myScreen;
  if (!mine || mine.calls.has(m.slot) || !state.peer) return;
  const c = state.peer.call(m.id, mine.stream, {
    metadata: { kind: 'screen', slot: state.slot, session: SESSION },
    sdpTransform: tuneVideoSdp,
  });
  if (!c) return;
  mine.calls.set(m.slot, c);
  const forget = () => {
    if (state.myScreen && state.myScreen.calls.get(m.slot) === c) state.myScreen.calls.delete(m.slot);
  };
  c.on('close', forget);
  c.on('error', forget);
  const pc = c.peerConnection;
  if (pc) {
    pc.addEventListener('iceconnectionstatechange', () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') tuneVideoSender(pc, mine.smooth);
    });
  }
}

async function tuneVideoSender(pc, smooth) {
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = smooth ? 8_000_000 : 6_000_000;
  params.encodings[0].maxFramerate = smooth ? 60 : 30;
  params.degradationPreference = smooth ? 'maintain-framerate' : 'maintain-resolution';
  try {
    await sender.setParameters(params);
  } catch (err) {
    console.warn('could not tune video sender', err);
  }
}

function stopShare() {
  const mine = state.myScreen;
  if (!mine) return;
  state.myScreen = null;
  mine.stream.getTracks().forEach((t) => t.stop());
  for (const c of mine.calls.values()) {
    try { c.close(); } catch { /* already closed */ }
  }
  broadcast(myState());
  renderShare();
  renderPeople();
}

function acceptScreen(m, call) {
  closeScreenFrom(m);
  m.screenCall = call;
  call.answer(undefined, { sdpTransform: tuneVideoSdp }); // receive only

  call.on('stream', (stream) => {
    if (m.closed || m.screenCall !== call) return;
    m.screenStream = stream;
    m.sharing = true;
    if (call.peerConnection) lowLatencyReceivers(call.peerConnection);
    if (state.watching == null || !state.members.get(state.watching)?.screenStream) watch(m.slot);
    else renderScreenPanel();
    renderPeople();
    if (state.info.testShare) logScreenStats(m, call);
  });
  call.on('close', () => closeScreenFrom(m, call));
  call.on('error', () => closeScreenFrom(m, call));
  if (call.peerConnection) {
    call.peerConnection.addEventListener('iceconnectionstatechange', () => {
      if (call.peerConnection.iceConnectionState === 'failed') closeScreenFrom(m, call);
    });
  }
}

function closeScreenFrom(m, call) {
  if (!m.screenCall || (call && m.screenCall !== call)) return;
  const c = m.screenCall;
  m.screenCall = null;
  m.screenStream = null;
  try { c.close(); } catch { /* already closed */ }
  if (state.watching === m.slot) pickWatch();
  renderPeople();
}

function pickWatch() {
  const next = [...state.members.values()].find((m) => m.screenStream && !m.closed);
  watch(next ? next.slot : null);
}

function watch(slot) {
  state.watching = slot;
  renderScreenPanel();
  renderPeople();
}

function renderScreenPanel() {
  const video = $('screenVideo');
  const m = state.watching != null ? state.members.get(state.watching) : null;
  if (!m || !m.screenStream) {
    state.watching = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    video.srcObject = null;
    $('screenPanel').hidden = true;
    document.body.classList.remove('watching');
    window.communicator.fitForVideo(false);
    return;
  }
  if (video.srcObject !== m.screenStream) {
    video.srcObject = m.screenStream;
    video.play().catch(() => {});
  }
  $('screenTitle').textContent = `${m.name || 'Someone'}’s screen`;

  // Buttons to switch to anyone else who is sharing.
  const switcher = $('screenSwitch');
  switcher.innerHTML = '';
  for (const other of state.members.values()) {
    if (other === m || !other.screenStream) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = other.name || 'Other';
    b.onclick = () => watch(other.slot);
    switcher.appendChild(b);
  }

  $('screenPanel').hidden = false;
  document.body.classList.add('watching');
  window.communicator.fitForVideo(true);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $('screenVideo').requestFullscreen().catch(() => {});
}

// ------------------------------------------------------------------ stats --

function readAllStats() {
  for (const m of state.members.values()) {
    if (m.voiceUp) readStats(m).catch(() => {});
  }
}

async function readStats(m) {
  const pc = m.call && m.call.peerConnection;
  if (!pc || m.closed) return;
  const report = await pc.getStats();
  let pair = null;
  let inbound = null;
  report.forEach((s) => {
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
    if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = s;
  });

  let pingMs = null;
  let route = '';
  if (pair && typeof pair.currentRoundTripTime === 'number') {
    pingMs = pair.currentRoundTripTime * 1000;
    const local = report.get(pair.localCandidateId);
    const remote = report.get(pair.remoteCandidateId);
    const relayed = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
    route = relayed ? 'Relayed' : 'Direct';
  }

  let bufferMs = null;
  let lossPct = 0;
  if (inbound) {
    const prev = m.lastInbound;
    if (prev && inbound.jitterBufferEmittedCount > prev.jitterBufferEmittedCount) {
      bufferMs = ((inbound.jitterBufferDelay - prev.jitterBufferDelay) /
        (inbound.jitterBufferEmittedCount - prev.jitterBufferEmittedCount)) * 1000;
    } else if (inbound.jitterBufferEmittedCount > 0) {
      bufferMs = (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000;
    }
    if (prev) {
      const lost = (inbound.packetsLost || 0) - (prev.packetsLost || 0);
      const got = (inbound.packetsReceived || 0) - (prev.packetsReceived || 0);
      lossPct = lost + got > 0 ? (Math.max(0, lost) / (lost + got)) * 100 : 0;
    }
    m.lastInbound = {
      jitterBufferDelay: inbound.jitterBufferDelay,
      jitterBufferEmittedCount: inbound.jitterBufferEmittedCount,
      packetsLost: inbound.packetsLost,
      packetsReceived: inbound.packetsReceived,
    };
  }

  if (pingMs === null) return;
  // One-way network + jitter buffer + ~30 ms for capture, encoding and playback.
  const est = pingMs / 2 + (bufferMs || 0) + 30;
  m.metaText = `≈ ${Math.round(est)} ms delay · ${route}`;
  m.metaTitle = `Ping ${Math.round(pingMs)} ms · Buffer ${Math.round(bufferMs || 0)} ms · Packet loss ${lossPct.toFixed(1)} %`;
  if (m.metaEl) {
    m.metaEl.textContent = m.metaText;
    m.metaEl.title = m.metaTitle;
  }
  if (!m.loggedStats && bufferMs !== null) {
    m.loggedStats = true;
    console.log(`[stats] ${m.name}: ping=${Math.round(pingMs)}ms buffer=${Math.round(bufferMs)}ms est=${Math.round(est)}ms route=${route}`);
  }
}

// --------------------------------------------------------- dev self-tests --

function maybeTestShare() {
  if (!state.info.testShare || state.testShared || state.slot !== 2) return;
  state.testShared = true;
  setTimeout(async () => {
    const sources = await window.communicator.getScreenSources();
    const screen = sources.find((s) => s.isScreen);
    if (screen) startShare(screen.id);
  }, 3000);
}

function logScreenStats(m, call) {
  setTimeout(async () => {
    const report = await call.peerConnection.getStats();
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        console.log(`[screen] watching ${m.name}: ${s.frameWidth}x${s.frameHeight} @ ${Math.round(s.framesPerSecond || 0)} fps`);
      }
    });
  }, 4000);
}

// ---------------------------------------------------------------- actions --

function toggleMute() {
  state.muted = !state.muted;
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
  }
  broadcast(myState());
  renderMute();
  renderPeople();
}

// A random code like "k7mq-x9pt-4zwe": 12 characters from a 31-letter alphabet
// (no 0/o, 1/l/i, so it can be read out loud), about 59 bits of randomness,
// which makes a room impossible to guess. Uses the OS crypto RNG, not Math.random.
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function generateRoom() {
  const bytes = new Uint8Array(12);
  const chars = [];
  while (chars.length < 12) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      // 248 = 8 * 31, so rejecting higher bytes keeps every letter equally likely.
      if (b < 248 && chars.length < 12) chars.push(ROOM_ALPHABET[b % ROOM_ALPHABET.length]);
    }
  }
  const code = chars.join('');
  $('roomInput').value = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

function bindUI() {
  $('nameInput').value = settings.name;
  $('roomInput').value = settings.room;
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    join();
  });
  $('generateBtn').addEventListener('click', generateRoom);
  $('copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(settings.room);
      $('copyBtn').textContent = 'Copied';
      setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 1500);
    } catch { /* ignore */ }
  });
  $('muteBtn').addEventListener('click', toggleMute);
  $('shareBtn').addEventListener('click', () => {
    if (state.myScreen) stopShare();
    else startShare().catch(console.error);
  });
  $('leaveBtn').addEventListener('click', () => { leave(); });
  $('fullscreenBtn').addEventListener('click', toggleFullscreen);
  $('screenVideo').addEventListener('dblclick', toggleFullscreen);

  $('inputSelect').addEventListener('change', async () => {
    settings.inputId = $('inputSelect').value;
    saveSettings();
    if (state.localStream) await startMic().catch(console.error);
  });
  $('outputSelect').addEventListener('change', async () => {
    settings.outputId = $('outputSelect').value;
    saveSettings();
    for (const m of state.members.values()) await applyOutputDevice(m.audio);
  });

  $('echoToggle').checked = settings.echo;
  $('noiseToggle').checked = settings.noise;
  $('echoToggle').addEventListener('change', async () => {
    settings.echo = $('echoToggle').checked;
    saveSettings();
    if (state.localStream) await startMic().catch(console.error);
  });
  $('noiseToggle').addEventListener('change', async () => {
    settings.noise = $('noiseToggle').checked;
    saveSettings();
    if (state.localStream) await startMic().catch(console.error);
  });

  $('openSettingsBtn').addEventListener('click', () => window.communicator.openSettingsFolder());

  navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices().catch(() => {}));
  window.communicator.onToggleMute(toggleMute);
  window.addEventListener('beforeunload', () => broadcast({ type: 'bye' }));
}

function bindUpdates() {
  const label = $('updateStatus');
  const banner = $('updateBanner');
  window.communicator.onUpdateStatus((s) => {
    switch (s.state) {
      case 'dev': label.textContent = 'Dev build'; break;
      case 'checking': label.textContent = 'Checking for updates…'; break;
      case 'latest': label.textContent = 'Up to date'; break;
      case 'downloading':
        label.textContent = s.percent != null ? `Downloading update ${s.percent}%` : 'Downloading update…';
        break;
      case 'ready':
        label.textContent = `Update ${s.version} ready`;
        $('updateVersion').textContent = s.version;
        banner.hidden = false;
        break;
      // Usually means no release is published on GitHub yet; not worth alarming anyone.
      case 'error': label.textContent = 'No updates found'; break;
      default: break;
    }
  });
  $('updateBtn').addEventListener('click', () => window.communicator.installUpdate());
}

async function init() {
  const info = await window.communicator.getInfo();
  state.info = info;
  if (info.room) settings.room = cleanRoom(info.room);
  if (info.name) settings.name = cleanName(info.name);

  bindUI();
  bindUpdates();
  renderMute();
  renderShare();
  requestAnimationFrame(drawMeters);
  $('version').textContent = `v${info.version}`;
  $('hotkey').textContent = info.muteHotkey;

  if (settings.room && settings.name) {
    join(); // Auto-connect on launch, like picking up a phone.
  } else {
    setStatus('idle', 'Not connected');
    showView('setup');
  }
}

init();
