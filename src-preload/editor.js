const {contextBridge, ipcRenderer} = require('electron');

const localGit = {
  getConnection: () => ipcRenderer.invoke('local-git-connection'),
  getState: () => ipcRenderer.invoke('local-git-state'),
  begin: (remember = false) => ipcRenderer.invoke('local-git-begin', remember),
  finish: () => ipcRenderer.invoke('local-git-finish'),
  restore: () => ipcRenderer.invoke('local-git-restore'),
  authorizeRepository: (remote, write = false, review = false) =>
    ipcRenderer.invoke('local-git-authorize', remote, write, review),
  getSession: () => ipcRenderer.invoke('local-git-session'),
  disconnect: () => ipcRenderer.invoke('local-git-disconnect')
};

contextBridge.exposeInMainWorld('EditorPreload', {
  localGit: ipcRenderer.sendSync('local-git-enabled') === true ? localGit : null,
  localGitAuth: ipcRenderer.sendSync('local-git-auth-enabled') === true ? {
    ...localGit,
    getAuthMethods: remote => ipcRenderer.invoke('local-git-auth-methods', remote),
    connectPersonalAccessToken: (remote, remember = false) =>
      ipcRenderer.invoke('local-git-connect-personal-access-token', remote, remember),
    connectGitCredential: (remote, login) => ipcRenderer.invoke('local-git-connect-git-credential', remote, login)
  } : null,
  ...(ipcRenderer.sendSync('editor-popouts-enabled') === true && {
    reservePopout: (kind, ticket) => ipcRenderer.sendSync('reserve-editor-popout', kind, ticket)
  }),
  workspaceLayout: ipcRenderer.sendSync('workspace-layout-enabled') === true ? {
    read: () => ipcRenderer.sendSync('read-workspace-layout'),
    write: raw => { ipcRenderer.sendSync('write-workspace-layout', raw); }
  } : null,
  externalYaml: ipcRenderer.sendSync('external-yaml-enabled') === true ? {
    open: () => ipcRenderer.invoke('open-external-yaml'),
    save: (id, revision, source) => ipcRenderer.invoke('save-external-yaml', id, revision, source),
    close: id => ipcRenderer.invoke('close-external-yaml', id)
  } : null,
  projectJSONTransfer: ipcRenderer.sendSync('project-json-transfer-enabled') === true,
  projectAssetTransfer: ipcRenderer.sendSync('project-asset-transfer-enabled') === true ? {
    stage: (kind, bytes) => ipcRenderer.invoke('stage-transfer-asset', kind, bytes),
    read: (transferId, asset) => ipcRenderer.invoke('read-transfer-asset', transferId, asset),
    discard: transferId => ipcRenderer.invoke('discard-transfer-asset', transferId)
  } : null,
  isInitiallyFullscreen: () => ipcRenderer.sendSync('is-initially-fullscreen'),
  getInitialFile: () => ipcRenderer.invoke('get-initial-file'),
  getFile: (id) => ipcRenderer.invoke('get-file', id),
  openedFile: (id) => ipcRenderer.invoke('opened-file', id),
  closedFile: () => ipcRenderer.invoke('closed-file'),
  dropPermissions: () => ipcRenderer.invoke('drop-permissions'),
  showSaveFilePicker: (suggestedName) => ipcRenderer.invoke('show-save-file-picker', suggestedName),
  showOpenFilePicker: () => ipcRenderer.invoke('show-open-file-picker'),
  setLocale: (locale) => ipcRenderer.sendSync('set-locale', locale),
  setChanged: (changed) => ipcRenderer.invoke('set-changed', changed),
  openNewWindow: () => ipcRenderer.invoke('open-new-window'),
  openAddonSettings: (search) => ipcRenderer.invoke('open-addon-settings', search),
  openPackager: () => ipcRenderer.invoke('open-packager'),
  openDesktopSettings: () => ipcRenderer.invoke('open-desktop-settings'),
  openPrivacy: () => ipcRenderer.invoke('open-privacy'),
  openAbout: () => ipcRenderer.invoke('open-about'),
  getPreferredMediaDevices: () => ipcRenderer.invoke('get-preferred-media-devices'),
  getAdvancedCustomizations: () => ipcRenderer.invoke('get-advanced-customizations'),
  setExportForPackager: (callback) => {
    exportForPackager = callback;
  },
  setIsFullScreen: (isFullScreen) => ipcRenderer.invoke('set-is-full-screen', isFullScreen)
});

let exportForPackager = () => Promise.reject(new Error('exportForPackager missing'));

ipcRenderer.on('export-project-to-port', (e) => {
  const port = e.ports[0];
  exportForPackager()
    .then(({data, name}) => {
      port.postMessage({ data, name });
    })
    .catch((error) => {
      console.error(error);
      port.postMessage({ error: true });
    });
});

window.addEventListener('message', (e) => {
  if (e.source === window) {
    const data = e.data;
    if (data && typeof data.ipcStartWriteStream === 'string') {
      ipcRenderer.postMessage('start-write-stream', data.ipcStartWriteStream, e.ports);
    }
  }
});

ipcRenderer.on('enumerate-media-devices', (e) => {
  navigator.mediaDevices.enumerateDevices()
    .then((devices) => {
      e.sender.send('enumerated-media-devices', {
        devices: devices.map((device) => ({
          deviceId: device.deviceId,
          kind: device.kind,
          label: device.label
        }))
      });
    })
    .catch((error) => {
      console.error(error);
      e.sender.send('enumerated-media-devices', {
        error: `${error}`
      });
    });
});

contextBridge.exposeInMainWorld('PromptsPreload', {
  alert: (message) => ipcRenderer.sendSync('alert', message),
  confirm: (message) => ipcRenderer.sendSync('confirm', message),
});

if (ipcRenderer.sendSync('project-process-mode')) {
  const {webUtils} = require('electron');
  document.addEventListener('drop', event => {
    if (!event.isTrusted) return;
    const paths = [...event.dataTransfer.files].map(file => webUtils.getPathForFile(file))
      .filter(path => /\.(sb3|sb2|sb)$/i.test(path));
    if (!paths.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void ipcRenderer.invoke('open-dropped-projects', paths);
  }, {capture: true});
}

// In some Linux environments, people may try to drag & drop files that we don't have access to.
// Remove when https://github.com/electron/electron/issues/30650 is fixed.
if (navigator.userAgent.includes('Linux')) {
  document.addEventListener('drop', (e) => {
    if (e.isTrusted) {
      for (const file of e.dataTransfer.files) {
        // Using webUtils is safe as we don't have a legacy build for Linux
        const {webUtils} = require('electron');
        const path = webUtils.getPathForFile(file);
        ipcRenderer.invoke('check-drag-and-drop-path', path);
      }
    }
  }, {
    capture: true
  });
}
