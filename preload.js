const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cb', {
  host: (port) => ipcRenderer.invoke('host:start', port),
  unhost: () => ipcRenderer.invoke('host:stop'),
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, pct) => fn(pct)),
});
