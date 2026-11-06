const {contextBridge, ipcRenderer} = require('electron');

const channel = 'tw-plus-popup:mode';
if (location.protocol === 'tw-editor:' && location.host === '.' &&
    location.pathname === '/plus-gui/backpack-popout.html') {
  // Do not let the consumed frame name select this window without the open handler.
  window.name = '';
  contextBridge.exposeInMainWorld('TwPlusWindowControls', {
    mode: () => ipcRenderer.invoke(channel),
    change: action => ipcRenderer.invoke(channel, action),
    onMode: callback => {
      const listener = (_event, mode) => callback(mode);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  });
}
