const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('communicator', {
  getInfo: () => ipcRenderer.invoke('get-info'),
  onToggleMute: (cb) => ipcRenderer.on('toggle-mute', () => cb()),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
  installUpdate: () => ipcRenderer.send('install-update'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  selectScreenSource: (id, withAudio) => ipcRenderer.invoke('select-screen-source', id, Boolean(withAudio)),
  fitForVideo: (on) => ipcRenderer.send('fit-for-video', on),
  loadSettings: () => ipcRenderer.sendSync('settings-load'),
  saveSettings: (data) => ipcRenderer.send('settings-save', data),
  openSettingsFolder: () => ipcRenderer.invoke('open-settings-folder'),

  // tray + overlay
  setAppOptions: (o) => ipcRenderer.send('app-options', o),
  setOverlayState: (s) => ipcRenderer.send('overlay-state', s),
  attention: () => ipcRenderer.send('attention'),

  // invite links
  onInvite: (cb) => ipcRenderer.on('invite', (_e, room) => cb(room)),

  // push-to-talk
  setPtt: (cfg) => ipcRenderer.send('ptt-config', cfg),
  capturePttKey: () => ipcRenderer.invoke('ptt-capture'),
  onPtt: (cb) => ipcRenderer.on('ptt', (_e, down) => cb(Boolean(down))),

  saveChat: (text) => ipcRenderer.send('chat-save', text),

  // recording
  recOpen: (folder, name) => ipcRenderer.invoke('rec-open', folder, name),
  recWrite: (id, bytes) => ipcRenderer.send('rec-write', id, bytes),
  recClose: (id) => ipcRenderer.send('rec-close', id),
  openRecordingsFolder: () => ipcRenderer.invoke('open-recordings-folder'),
});
