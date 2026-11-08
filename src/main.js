const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session, shell } = require('electron');
const path = require('path');
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
const MUTE_HOTKEY = 'CommandOrControl+Shift+M';

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 520,
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

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
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
    pendingSourceId = null;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === wanted);
      if (source) callback({ video: source });
      else callback({});
    } catch {
      callback({});
    }
  });

  createWindow();

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
}));

// ------------------------------------------------------------ screen share --

let pendingSourceId = null;

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

ipcMain.handle('select-screen-source', (_e, id) => {
  pendingSourceId = id;
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

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall(true, true);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
