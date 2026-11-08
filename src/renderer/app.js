/* global Peer */
'use strict';

// ---------------------------------------------------------------------------
// How connecting works
// Both friends type the same room code. The first one to open the app takes
// the id "<room>-a" on the PeerJS signaling server and waits. The second one
// finds "-a" taken, takes "<room>-b" and calls "-a". The signaling server only
// introduces the two PCs; the voice itself goes directly between them (or via
// a TURN relay if a router blocks direct connections).
// ---------------------------------------------------------------------------

const ROOM_PREFIX = 'communicator-v1-';
const RETRY_MS = 2000;
const CONNECT_TIMEOUT_MS = 20000;

const $ = (id) => document.getElementById(id);

const settings = loadSettings();

const state = {
  peer: null,
  role: null,          // 'a' (waits) or 'b' (calls)
  call: null,
  connected: false,
  leaving: false,
  localStream: null,
  muted: false,
  retryTimer: null,
  connectTimer: null,
  disconnectTimer: null,
  statsTimer: null,
  lastInbound: null,
  audioCtx: null,
  localMeter: null,
  remoteMeter: null,
  myScreen: null,      // { call, stream } while I'm sharing
  theirScreen: null,   // incoming screen-share call from the friend
  info: {},
};

const remoteAudio = $('remoteAudio');

// ---------------------------------------------------------------- settings --

function loadSettings() {
  const defaults = { room: '', inputId: '', outputId: '', volume: 1, echo: true, noise: true, shareMode: 'motion' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('settings') || '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem('settings', JSON.stringify(settings));
  } catch { /* ignore */ }
}

function cleanRoom(text) {
  return String(text || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

function roomId(role) {
  return `${ROOM_PREFIX}${settings.room}-${role}`;
}

// --------------------------------------------------------------------- UI --

function setStatus(kind, text) {
  const pill = $('statusPill');
  pill.dataset.kind = kind;
  $('statusText').textContent = text;
  $('callTitle').textContent = text;
  if (document.body.dataset.status !== kind || $('statusText').dataset.last !== text) {
    console.log(`[status] ${kind}: ${text}`);
    $('statusText').dataset.last = text;
  }
  document.body.dataset.status = kind;
}

function showView(name) {
  $('setupView').hidden = name !== 'setup';
  $('callView').hidden = name !== 'call';
}

function renderMute() {
  const btn = $('muteBtn');
  btn.classList.toggle('muted', state.muted);
  btn.setAttribute('aria-pressed', String(state.muted));
  $('muteLabel').textContent = state.muted ? 'Unmute' : 'Mute';
}

function resetStats() {
  for (const id of ['statPing', 'statBuffer', 'statDelay', 'statRoute', 'statLoss']) {
    $(id).textContent = '–';
  }
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

  // Swap the track in a running call without reconnecting.
  const pc = state.call && state.call.peerConnection;
  if (pc) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    if (sender) await sender.replaceTrack(stream.getAudioTracks()[0]);
  }
  if (old) old.getTracks().forEach((t) => t.stop());

  state.localMeter = makeMeter(stream, $('localMeter'));
  await refreshDevices();
}

function ensureAudioCtx() {
  if (!state.audioCtx) state.audioCtx = new AudioContext({ latencyHint: 'interactive' });
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  return state.audioCtx;
}

function makeMeter(stream, barEl) {
  const ctx = ensureAudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  return { analyser, barEl, data: new Uint8Array(analyser.fftSize), source };
}

function drawMeters() {
  for (const meter of [state.localMeter, state.remoteMeter]) {
    if (!meter) continue;
    meter.analyser.getByteTimeDomainData(meter.data);
    let peak = 0;
    for (let i = 0; i < meter.data.length; i++) {
      peak = Math.max(peak, Math.abs(meter.data[i] - 128));
    }
    let level = Math.min(1, peak / 64);
    if (meter === state.localMeter && state.muted) level = 0;
    meter.barEl.style.transform = `scaleX(${level.toFixed(3)})`;
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

async function applyOutputDevice() {
  if (typeof remoteAudio.setSinkId !== 'function') return;
  try {
    await remoteAudio.setSinkId(settings.outputId || '');
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

// ------------------------------------------------------------- connection --

async function join() {
  settings.room = cleanRoom($('roomInput').value || settings.room);
  if (!settings.room) {
    $('roomInput').focus();
    return;
  }
  saveSettings();
  $('roomName').textContent = settings.room;
  state.leaving = false;
  showView('call');
  setStatus('connecting', 'Starting microphone…');
  ensureAudioCtx();

  try {
    if (!state.localStream) await startMic();
  } catch (err) {
    setStatus('error', 'No microphone access');
    console.error(err);
    scheduleRetry(5000);
    return;
  }
  connect();
}

function connect() {
  clearTimeout(state.retryTimer);
  if (state.leaving) return;
  destroyPeer();
  setStatus('connecting', 'Connecting…');
  tryRole('a');
}

function tryRole(role) {
  const peer = new Peer(roomId(role), { debug: 1 });
  state.peer = peer;
  state.role = null;

  peer.on('open', () => {
    if (state.peer !== peer) return;
    state.role = role;
    if (role === 'a') {
      setStatus('waiting', 'Waiting for your friend…');
    } else {
      callFriend();
    }
  });

  peer.on('call', (incoming) => {
    if (state.peer !== peer) return;
    if (incoming.metadata && incoming.metadata.kind === 'screen') {
      acceptScreen(incoming);
      return;
    }
    // Only two people use a room, so a new call is the friend (re)connecting.
    if (state.call) endCall(state.call, false);
    incoming.answer(state.localStream, { sdpTransform: tuneOpus });
    attachCall(incoming);
  });

  peer.on('disconnected', () => {
    // Lost the signaling server. An existing call keeps working; reconnect quietly.
    if (state.peer === peer && !peer.destroyed) {
      try { peer.reconnect(); } catch { /* handled by error */ }
    }
  });

  peer.on('error', (err) => {
    if (state.peer !== peer) return;
    console.warn('peer error:', err.type, err.message);
    switch (err.type) {
      case 'unavailable-id':
        if (role === 'a') {
          peer.destroy();
          tryRole('b');
        } else {
          // Both slots taken, usually an old session the server hasn't dropped yet.
          setStatus('connecting', 'Room busy, retrying…');
          scheduleRetry(4000);
        }
        break;
      case 'peer-unavailable':
        // We tried to call "-a" but it is gone; start over and take its place.
        scheduleRetry(300 + Math.random() * 700);
        break;
      default:
        if (!state.connected) {
          setStatus('connecting', 'Can’t reach the server, retrying…');
          scheduleRetry(RETRY_MS);
        }
    }
  });
}

function callFriend() {
  const c = state.peer.call(roomId('a'), state.localStream, { sdpTransform: tuneOpus });
  if (!c) {
    scheduleRetry(RETRY_MS);
    return;
  }
  setStatus('connecting', 'Calling your friend…');
  attachCall(c);
}

function attachCall(c) {
  state.call = c;
  state.connected = false;

  clearTimeout(state.connectTimer);
  state.connectTimer = setTimeout(() => {
    if (state.call === c && !state.connected) endCall(c, true);
  }, CONNECT_TIMEOUT_MS);

  c.on('stream', (remoteStream) => {
    if (state.call !== c || state.connected) return;
    onConnected(c, remoteStream);
  });
  c.on('close', () => endCall(c, true));
  c.on('error', () => endCall(c, true));

  const pc = c.peerConnection;
  if (pc) {
    pc.addEventListener('iceconnectionstatechange', () => {
      if (state.call !== c) return;
      const s = pc.iceConnectionState;
      clearTimeout(state.disconnectTimer);
      if (s === 'failed') {
        endCall(c, true);
      } else if (s === 'disconnected') {
        setStatus('connecting', 'Connection unstable…');
        state.disconnectTimer = setTimeout(() => {
          if (state.call === c && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
            endCall(c, true);
          }
        }, 5000);
      } else if ((s === 'connected' || s === 'completed') && state.connected) {
        setStatus('connected', 'Connected');
      }
    });
  }
}

async function onConnected(c, remoteStream) {
  state.connected = true;
  clearTimeout(state.connectTimer);
  remoteAudio.srcObject = remoteStream;
  remoteAudio.volume = settings.volume;
  await applyOutputDevice();
  remoteAudio.play().catch(() => {});

  if (c.peerConnection) lowLatencyReceivers(c.peerConnection);
  state.remoteMeter = makeMeter(remoteStream, $('remoteMeter'));
  setStatus('connected', 'Connected');
  startStats(c);
  renderShare();

  if (state.info.testShare && state.role === 'b') {
    // Dev-only self test: share the first screen automatically.
    setTimeout(async () => {
      const sources = await window.communicator.getScreenSources();
      const screen = sources.find((s) => s.isScreen);
      if (screen) startShare(screen.id);
    }, 1500);
  }
}

function endCall(c, reconnect) {
  if (state.call !== c) return;
  state.call = null;
  state.connected = false;
  clearTimeout(state.connectTimer);
  clearTimeout(state.disconnectTimer);
  stopStats();
  stopShare();
  closeTheirScreen();
  renderShare();
  try { c.close(); } catch { /* already closed */ }
  remoteAudio.srcObject = null;
  if (state.remoteMeter) {
    state.remoteMeter.source.disconnect();
    state.remoteMeter.barEl.style.transform = 'scaleX(0)';
    state.remoteMeter = null;
  }

  if (!reconnect || state.leaving) return;

  if (state.role === 'a' && state.peer && state.peer.open) {
    // We hold the waiting slot; just wait for the friend to call back.
    setStatus('waiting', 'Friend left. Waiting…');
  } else {
    setStatus('connecting', 'Reconnecting…');
    scheduleRetry(RETRY_MS);
  }
}

function scheduleRetry(ms) {
  clearTimeout(state.retryTimer);
  if (state.leaving) return;
  state.retryTimer = setTimeout(() => {
    if (state.localStream) connect();
    else join();
  }, ms);
}

function destroyPeer() {
  if (state.call) endCall(state.call, false);
  if (state.peer) {
    const p = state.peer;
    state.peer = null;
    try { p.destroy(); } catch { /* ignore */ }
  }
  state.role = null;
}

function leave() {
  state.leaving = true;
  clearTimeout(state.retryTimer);
  destroyPeer();
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  if (state.localMeter) {
    state.localMeter.source.disconnect();
    state.localMeter.barEl.style.transform = 'scaleX(0)';
    state.localMeter = null;
  }
  resetStats();
  setStatus('idle', 'Not connected');
  showView('setup');
}

// ----------------------------------------------------------- screen share --
// A screen share is a second, separate PeerJS call next to the voice call, so
// starting or stopping it never interrupts the voice.

function friendId() {
  return roomId(state.role === 'a' ? 'b' : 'a');
}

function renderShare() {
  const btn = $('shareBtn');
  const sharing = Boolean(state.myScreen);
  btn.disabled = !state.connected;
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
  if (!state.connected || state.myScreen || !state.peer) return;

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
  if (!state.connected || !state.peer) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  const smooth = settings.shareMode !== 'detail';
  const track = stream.getVideoTracks()[0];
  track.contentHint = smooth ? 'motion' : 'detail';
  track.addEventListener('ended', stopShare); // e.g. the shared window was closed

  const c = state.peer.call(friendId(), stream, { metadata: { kind: 'screen' }, sdpTransform: tuneVideoSdp });
  if (!c) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  state.myScreen = { call: c, stream };
  c.on('close', () => { if (state.myScreen && state.myScreen.call === c) stopShare(); });
  c.on('error', () => { if (state.myScreen && state.myScreen.call === c) stopShare(); });

  const pc = c.peerConnection;
  if (pc) {
    pc.addEventListener('iceconnectionstatechange', () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') tuneVideoSender(pc, smooth);
      if (s === 'failed' && state.myScreen && state.myScreen.call === c) stopShare();
    });
  }
  console.log(`[screen] sharing ${track.getSettings().width}x${track.getSettings().height} (${smooth ? 'smooth' : 'sharp'})`);
  renderShare();
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
  try { mine.call.close(); } catch { /* already closed */ }
  renderShare();
}

function acceptScreen(c) {
  closeTheirScreen();
  state.theirScreen = c;
  c.answer(undefined, { sdpTransform: tuneVideoSdp }); // receive only: we send nothing back

  c.on('stream', (stream) => {
    if (state.theirScreen !== c) return;
    const video = $('screenVideo');
    video.srcObject = stream;
    video.play().catch(() => {});
    if (c.peerConnection) lowLatencyReceivers(c.peerConnection);
    $('screenPanel').hidden = false;
    document.body.classList.add('watching');
    window.communicator.fitForVideo(true);

    if (state.info.testShare) {
      let n = 0;
      let lastBytes = 0;
      const t = setInterval(async () => {
        if (++n > 8 || state.theirScreen !== c) { clearInterval(t); return; }
        const report = await c.peerConnection.getStats();
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            const mbps = ((s.bytesReceived - lastBytes) * 8 / 2e6).toFixed(1);
            lastBytes = s.bytesReceived;
            console.log(`[screen] t=${n * 2}s ${s.frameWidth}x${s.frameHeight} @ ${Math.round(s.framesPerSecond || 0)} fps, ${mbps} Mbps, decoder=${s.decoderImplementation}`);
          }
        });
      }, 2000);
    }
  });
  c.on('close', () => closeTheirScreen(c));
  c.on('error', () => closeTheirScreen(c));
  if (c.peerConnection) {
    c.peerConnection.addEventListener('iceconnectionstatechange', () => {
      if (c.peerConnection.iceConnectionState === 'failed') closeTheirScreen(c);
    });
  }
}

function closeTheirScreen(c) {
  const theirs = state.theirScreen;
  if (!theirs || (c && theirs !== c)) return;
  state.theirScreen = null;
  try { theirs.close(); } catch { /* already closed */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('screenVideo').srcObject = null;
  $('screenPanel').hidden = true;
  document.body.classList.remove('watching');
  window.communicator.fitForVideo(false);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $('screenVideo').requestFullscreen().catch(() => {});
}

// ------------------------------------------------------------------ stats --

function startStats(c) {
  stopStats();
  state.lastInbound = null;
  state.statsTimer = setInterval(() => readStats(c), 1000);
  readStats(c);
}

function stopStats() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  resetStats();
}

async function readStats(c) {
  const pc = c.peerConnection;
  if (!pc || state.call !== c) return;
  const report = await pc.getStats();
  let pair = null;
  let inbound = null;

  report.forEach((s) => {
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
    if (s.type === 'inbound-rtp' && s.kind === 'audio') inbound = s;
  });

  let pingMs = null;
  if (pair && typeof pair.currentRoundTripTime === 'number') {
    pingMs = pair.currentRoundTripTime * 1000;
    $('statPing').textContent = `${Math.round(pingMs)} ms`;
    const local = report.get(pair.localCandidateId);
    const remote = report.get(pair.remoteCandidateId);
    const relayed = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
    $('statRoute').textContent = relayed ? 'Relayed' : 'Direct';
  }

  let bufferMs = null;
  if (inbound) {
    const prev = state.lastInbound;
    if (prev && inbound.jitterBufferEmittedCount > prev.jitterBufferEmittedCount) {
      bufferMs = ((inbound.jitterBufferDelay - prev.jitterBufferDelay) /
        (inbound.jitterBufferEmittedCount - prev.jitterBufferEmittedCount)) * 1000;
    } else if (inbound.jitterBufferEmittedCount > 0) {
      bufferMs = (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000;
    }
    if (bufferMs !== null) $('statBuffer').textContent = `${Math.round(bufferMs)} ms`;

    if (prev) {
      const lost = (inbound.packetsLost || 0) - (prev.packetsLost || 0);
      const got = (inbound.packetsReceived || 0) - (prev.packetsReceived || 0);
      const pct = lost + got > 0 ? (Math.max(0, lost) / (lost + got)) * 100 : 0;
      $('statLoss').textContent = `${pct.toFixed(1)} %`;
    }
    state.lastInbound = {
      jitterBufferDelay: inbound.jitterBufferDelay,
      jitterBufferEmittedCount: inbound.jitterBufferEmittedCount,
      packetsLost: inbound.packetsLost,
      packetsReceived: inbound.packetsReceived,
    };
  }

  if (pingMs !== null && bufferMs !== null) {
    // One-way network + jitter buffer + ~30 ms for capture, encoding and playback.
    const est = pingMs / 2 + bufferMs + 30;
    $('statDelay').textContent = `≈ ${Math.round(est)} ms`;
    if (!state.loggedStats) {
      state.loggedStats = true;
      console.log(`[stats] ping=${Math.round(pingMs)}ms buffer=${Math.round(bufferMs)}ms est=${Math.round(est)}ms route=${$('statRoute').textContent}`);
    }
  }
}

// ---------------------------------------------------------------- actions --

function toggleMute() {
  state.muted = !state.muted;
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
  }
  renderMute();
}

function generateRoom() {
  const words = ['falcon', 'tiger', 'nova', 'orbit', 'pixel', 'storm', 'raven', 'blaze', 'frost', 'comet'];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  $('roomInput').value = `${word}-${num}`;
}

function bindUI() {
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
  $('fullscreenBtn').addEventListener('click', toggleFullscreen);
  $('screenVideo').addEventListener('dblclick', toggleFullscreen);
  $('leaveBtn').addEventListener('click', leave);

  $('volume').value = String(Math.round(settings.volume * 100));
  $('volumeValue').textContent = `${$('volume').value}%`;
  $('volume').addEventListener('input', () => {
    settings.volume = Number($('volume').value) / 100;
    remoteAudio.volume = settings.volume;
    $('volumeValue').textContent = `${$('volume').value}%`;
    saveSettings();
  });

  $('inputSelect').addEventListener('change', async () => {
    settings.inputId = $('inputSelect').value;
    saveSettings();
    if (state.localStream) await startMic().catch(console.error);
  });
  $('outputSelect').addEventListener('change', async () => {
    settings.outputId = $('outputSelect').value;
    saveSettings();
    await applyOutputDevice();
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

  navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices().catch(() => {}));

  window.communicator.onToggleMute(toggleMute);
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
  bindUI();
  bindUpdates();
  renderMute();
  resetStats();
  requestAnimationFrame(drawMeters);

  const info = await window.communicator.getInfo();
  state.info = info;
  renderShare();
  $('version').textContent = `v${info.version}`;
  $('hotkey').textContent = info.muteHotkey;
  if (info.room) {
    settings.room = cleanRoom(info.room);
    $('roomInput').value = settings.room;
  }

  if (settings.room) {
    join(); // Auto-connect on launch, like picking up a phone.
  } else {
    setStatus('idle', 'Not connected');
    showView('setup');
  }
}

init();
