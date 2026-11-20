const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onState: (cb) => ipcRenderer.on('overlay-state', (_e, people) => cb(people)),
});
