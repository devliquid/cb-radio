const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cb', {
  host: (port) => ipcRenderer.invoke('host:start', port),
  unhost: () => ipcRenderer.invoke('host:stop'),
});
