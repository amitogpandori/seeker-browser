// Bridge for the browser chrome (toolbar, tabs, panels).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ui', {
  cmd: (name, ...args) => ipcRenderer.invoke('cmd', name, ...args),
  ai: (action, arg) => ipcRenderer.invoke('ai', action, arg),
  on: (channel, cb) => {
    const h = (e, ...args) => cb(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
