const {
  app, BrowserWindow, Menu, Tray, nativeImage, screen,
  desktopCapturer, globalShortcut, ipcMain, session, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');

// `--profile=<name>` gives a separate settings folder, so two copies can run
// on one PC for testing (npm run start:second).
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (profileArg) {
  const profile = profileArg.split('=')[1].replace(/[^a-z0-9_-]/gi, '');
  app.setPath('userData', path.join(app.getPath('appData'), `Communicator-${profile}`));
}

// Keep audio processing at full speed even when the window is in the background.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Auto-connect on launch should play the friend's voice without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let tray = null;
let overlay = null;
let overlayReady = false;
const MUTE_HOTKEY = 'CommandOrControl+Shift+M';

// Options the page tells us about (tray, overlay, push-to-talk).
const options = { tray: true, overlay: false };
const overlayState = { show: false, people: [] };

// Invite links look like communicator://join/<room-code>.
const PROTOCOL = 'communicator';
function inviteFromArgs(args) {
  for (const a of args) {
    const m = /^communicator:\/\/join\/([a-z0-9-]{1,40})\/?$/i.exec(String(a));
    if (m) return m[1].toLowerCase();
  }
  return '';
}
const startInvite = inviteFromArgs(process.argv);

// Register as the handler for invite links (installed builds only, so a dev
// copy of Electron never hijacks the link).
if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 500,
    height: 920,
    minWidth: 400,
    minHeight: 560,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: 'Communicator',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Minimize to the tray instead of the taskbar (the call keeps running).
  win.on('minimize', (e) => {
    if (options.tray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  for (const ev of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) win.on(ev, updateOverlay);

  // In development, mirror the page's log lines to the terminal.
  if (!app.isPackaged) {
    // `--screenshot=<file.png>` saves the window 15 s after launch (layout checks).
    const shotArg = process.argv.find((a) => a.startsWith('--screenshot='));
    if (shotArg) {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(shotArg.slice('--screenshot='.length), img.toPNG());
      }, 15000);
    }
    win.webContents.on('console-message', (e) => {
      console.log(`[renderer${profileArg ? ' ' + profileArg.split('=')[1] : ''}] ${e.message}`);
    });
  }

  // Open external links in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

// ------------------------------------------------------------------- tray --

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Communicator');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Communicator', click: showWindow },
    { label: 'Mute / unmute', click: () => send('toggle-mute') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => {
    if (win && win.isVisible() && !win.isMinimized()) win.hide();
    else showWindow();
  });
}

// ---------------------------------------------------------------- overlay --
// A small see-through, click-through window that stays on top of games and
// shows who is talking. It only appears while the main window is not in front.

function overlayWanted() {
  const mainInFront = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
  return options.overlay && overlayState.show && !mainInFront;
}

function ensureOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  const area = screen.getPrimaryDisplay().workArea;
  overlay = new BrowserWindow({
    x: area.x + 16,
    y: area.y + 16,
    width: 240,
    height: 330,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlayReady = false;
  overlay.webContents.once('did-finish-load', () => { overlayReady = true; pushOverlayState(); });
  overlay.on('closed', () => { overlay = null; overlayReady = false; });
  return overlay;
}

function pushOverlayState() {
  if (overlay && !overlay.isDestroyed() && overlayReady) {
    overlay.webContents.send('overlay-state', overlayState.people);
  }
}

function updateOverlay() {
  if (overlayWanted()) {
    const o = ensureOverlay();
    pushOverlayState();
    if (!o.isVisible()) o.showInactive();
  } else if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
    overlay.hide();
  }
}

ipcMain.on('app-options', (_e, o) => {
  if (!o || typeof o !== 'object') return;
  options.tray = Boolean(o.tray);
  options.overlay = Boolean(o.overlay);
  updateOverlay();
});

ipcMain.on('overlay-state', (_e, s) => {
  if (!s || typeof s !== 'object' || !Array.isArray(s.people)) return;
  overlayState.show = Boolean(s.show);
  overlayState.people = s.people.slice(0, 8).map((p) => ({
    name: String(p.name || '').slice(0, 24),
    speaking: Boolean(p.speaking),
    muted: Boolean(p.muted),
    hue: Number(p.hue) || 0,
  }));
  updateOverlay();
});

// Flash the taskbar button when a chat message arrives and the window is behind.
ipcMain.on('attention', () => {
  if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
});

// ------------------------------------------------------------ push-to-talk --
// Electron's global shortcuts only report a key going down, never up, so
// "hold to talk" uses a small native keyboard/mouse hook (uiohook-napi). The
// hook only runs while push-to-talk is on, or while the user is picking a key.

let uio = null;
try {
  uio = require('uiohook-napi');
} catch (err) {
  console.warn('[ptt] global key hook unavailable:', err.message);
}

const keyNames = {};
if (uio) for (const [name, code] of Object.entries(uio.UiohookKey)) keyNames[code] = name;

const ptt = { enabled: false, key: null, held: false, started: false, capture: null };

function pttSync() {
  if (!uio) return;
  const need = (ptt.enabled && ptt.key) || ptt.capture;
  if (need && !ptt.started) {
    uio.uIOhook.start();
    ptt.started = true;
  } else if (!need && ptt.started) {
    uio.uIOhook.stop();
    ptt.started = false;
  }
}

function pttMatches(kind, code) {
  return ptt.key && ptt.key.type === kind && ptt.key.code === code;
}

function pttHandle(kind, code, down) {
  if (ptt.capture) {
    // Picking a key: the next press wins. Escape cancels; left/right click are ignored.
    if (!down) return;
    if (kind === 'mouse' && (code === 1 || code === 2)) return;
    const done = ptt.capture;
    ptt.capture = null;
    if (kind === 'key' && keyNames[code] === 'Escape') done(null);
    else done({ type: kind, code, label: kind === 'mouse' ? `Mouse ${code}` : keyNames[code] || `Key ${code}` });
    pttSync();
    return;
  }
  if (!ptt.enabled || !pttMatches(kind, code)) return;
  if (ptt.held === down) return; // ignore key auto-repeat
  ptt.held = down;
  send('ptt', down);
}

if (uio) {
  uio.uIOhook.on('keydown', (e) => pttHandle('key', e.keycode, true));
  uio.uIOhook.on('keyup', (e) => pttHandle('key', e.keycode, false));
  uio.uIOhook.on('mousedown', (e) => pttHandle('mouse', e.button, true));
  uio.uIOhook.on('mouseup', (e) => pttHandle('mouse', e.button, false));
}

ipcMain.on('ptt-config', (_e, c) => {
  if (!c || typeof c !== 'object') return;
  const k = c.key;
  ptt.key = k && (k.type === 'key' || k.type === 'mouse') && Number.isInteger(k.code) ? { type: k.type, code: k.code } : null;
  ptt.enabled = Boolean(c.enabled) && Boolean(ptt.key);
  if (ptt.held && !ptt.enabled) {
    ptt.held = false;
    send('ptt', false);
  }
  pttSync();
});

ipcMain.handle('ptt-capture', () => new Promise((resolve) => {
  if (!uio) return resolve(null);
  if (ptt.capture) ptt.capture(null);
  const timer = setTimeout(() => {
    if (ptt.capture === done) { ptt.capture = null; pttSync(); }
    resolve(null);
  }, 10000);
  const done = (result) => { clearTimeout(timer); resolve(result); };
  ptt.capture = done;
  pttSync();
}));

// ------------------------------------------------------------ chat history --
// Chat messages are saved to disk encrypted with AES-256-GCM, using a fresh
// random key for every message that is thrown away right after encrypting.
// Nobody (including you) can ever decrypt the file; no key exists anywhere.

const CHAT_FILE_MAX = 5 * 1024 * 1024;

ipcMain.on('chat-save', (_e, text) => {
  if (typeof text !== 'string' || !text) return;
  const file = path.join(app.getPath('userData'), 'chat-history.enc');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > CHAT_FILE_MAX) fs.truncateSync(file, 0);
    const key = crypto.randomBytes(32); // never stored, never returned
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(text.slice(0, 2000), 'utf8'), cipher.final()]);
    const record = Buffer.concat([iv, cipher.getAuthTag(), body]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(record.length);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, Buffer.concat([len, record]));
  } catch (err) {
    console.error('[chat] could not save:', err.message);
  }
});

// -------------------------------------------------------------- recording --
// The page hands over audio in small chunks; they are appended to a file
// straight away, so a crash loses at most a second of the recording.

const recordings = new Map(); // id -> file descriptor
let recordingSeq = 0;

function recordingsRoot() {
  return path.join(app.getPath('documents'), 'Communicator Recordings');
}

ipcMain.handle('rec-open', (_e, folder, fileName) => {
  const safe = (s) => String(s || '').replace(/[^a-z0-9 _.-]/gi, '_').slice(0, 60) || 'recording';
  const dir = path.join(recordingsRoot(), safe(folder));
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${safe(fileName)}.webm`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${safe(fileName)} (${i}).webm`);
  const id = ++recordingSeq;
  recordings.set(id, fs.openSync(file, 'w'));
  return { id, file };
});

ipcMain.on('rec-write', (_e, id, bytes) => {
  const fd = recordings.get(id);
  if (fd === undefined || !(bytes instanceof Uint8Array)) return;
  try { fs.writeSync(fd, bytes); } catch (err) { console.error('[rec] write failed:', err.message); }
});

ipcMain.on('rec-close', (_e, id) => {
  const fd = recordings.get(id);
  if (fd === undefined) return;
  recordings.delete(id);
  try { fs.closeSync(fd); } catch { /* already closed */ }
});

ipcMain.handle('open-recordings-folder', () => {
  fs.mkdirSync(recordingsRoot(), { recursive: true });
  return shell.openPath(recordingsRoot());
});

function setupUpdater() {
  if (!app.isPackaged) {
    send('update-status', { state: 'dev' });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => send('update-status', { state: 'checking' }));
  autoUpdater.on('update-available', (info) => send('update-status', { state: 'downloading', version: info.version }));
  autoUpdater.on('update-not-available', () => send('update-status', { state: 'latest' }));
  autoUpdater.on('download-progress', (p) => send('update-status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update-status', { state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => send('update-status', { state: 'error', message: String(err && err.message || err) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 30 * 60 * 1000); // every 30 minutes
}

app.on('second-instance', (_e, argv) => {
  showWindow();
  const room = inviteFromArgs(argv);
  if (room) send('invite', room);
});

app.whenReady().then(() => {
  // Allow microphone access for our own page only.
  const allowed = new Set(['media', 'speaker-selection', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission));

  // getDisplayMedia() in the page shares whatever source the user picked in our own picker.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const wanted = pendingSourceId;
    const withAudio = pendingSourceAudio;
    pendingSourceId = null;
    pendingSourceAudio = false;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === wanted);
      if (!source) callback({});
      else if (withAudio) callback({ video: source, audio: 'loopback' }); // system sound (Windows)
      else callback({ video: source });
    } catch {
      callback({});
    }
  });

  createWindow();
  createTray();

  // Global mute toggle that works while a game has focus.
  globalShortcut.register(MUTE_HOTKEY, () => send('toggle-mute'));

  win.webContents.once('did-finish-load', setupUpdater);
});

// `--room=<code>` pre-fills the room (handy for testing two copies).
const roomArg = process.argv.find((a) => a.startsWith('--room='));
const nameArg = process.argv.find((a) => a.startsWith('--name='));

ipcMain.handle('get-info', () => ({
  version: app.getVersion(),
  muteHotkey: 'Ctrl+Shift+M',
  room: roomArg ? roomArg.split('=')[1] : '',
  name: nameArg ? nameArg.split('=')[1] : '',
  testShare: !app.isPackaged && process.argv.includes('--test-share'),
  invite: startInvite,
  pttAvailable: Boolean(uio),
}));

// ------------------------------------------------------------ screen share --

let pendingSourceId = null;
let pendingSourceAudio = false;

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources
    .filter((s) => s.name !== 'Communicator')
    .map((s) => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen:'),
      thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    }));
});

ipcMain.handle('select-screen-source', (_e, id, withAudio) => {
  pendingSourceId = id;
  pendingSourceAudio = Boolean(withAudio);
});

// Make the window big enough to watch the friend's screen, then restore it.
let boundsBeforeVideo = null;
ipcMain.on('fit-for-video', (_e, on) => {
  if (!win || win.isDestroyed()) return;
  if (on) {
    if (boundsBeforeVideo || win.isMaximized() || win.isFullScreen()) return;
    const b = win.getBounds();
    if (b.width >= 960) return;
    boundsBeforeVideo = b;
    win.setBounds({ width: 1040, height: Math.max(b.height, 820) });
    win.center();
  } else if (boundsBeforeVideo) {
    if (!win.isMaximized() && !win.isFullScreen()) win.setBounds(boundsBeforeVideo);
    boundsBeforeVideo = null;
  }
});

// ---------------------------------------------------------------- settings --
// Settings live in a plain JSON file in the app's AppData folder
// (%APPDATA%\Communicator\settings.json), so they survive updates and are easy
// to back up or reset. Writes are debounced and atomic (temp file + rename).

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let pendingSettings = null;
let settingsTimer = null;

function readSettingsFile() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null; // missing or unreadable: the page falls back to defaults
  }
}

function flushSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = null;
  if (!pendingSettings) return;
  const file = settingsFile();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(pendingSettings, null, 2));
    fs.renameSync(tmp, file);
    pendingSettings = null;
  } catch (err) {
    console.error('[settings] could not save:', err.message);
  }
}

ipcMain.on('settings-load', (e) => {
  e.returnValue = readSettingsFile();
});

ipcMain.on('settings-save', (_e, data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  if (JSON.stringify(data).length > 64 * 1024) return; // settings are tiny; refuse junk
  pendingSettings = data;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(flushSettings, 300);
});

ipcMain.handle('open-settings-folder', () => shell.openPath(app.getPath('userData')));

app.on('before-quit', flushSettings);

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall(true, true);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (uio && ptt.started) uio.uIOhook.stop();
  for (const fd of recordings.values()) try { fs.closeSync(fd); } catch { /* ignore */ }
});
app.on('window-all-closed', () => app.quit());
