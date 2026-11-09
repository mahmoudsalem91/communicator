const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('communicator', {
  getInfo: () => ipcRenderer.invoke('get-info'),
  onToggleMute: (cb) => ipcRenderer.on('toggle-mute', () => cb()),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
  installUpdate: () => ipcRenderer.send('install-update'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  selectScreenSource: (id) => ipcRenderer.invoke('select-screen-source', id),
  fitForVideo: (on) => ipcRenderer.send('fit-for-video', on),
  loadSettings: () => ipcRenderer.sendSync('settings-load'),
  saveSettings: (data) => ipcRenderer.send('settings-save', data),
  openSettingsFolder: () => ipcRenderer.invoke('open-settings-folder'),
});
