const path = require('node:path');
const AbstractWindow = require('./abstract');

const ticketPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const controlsChannel = 'tw-plus-popup:mode';
const editorOrigin = 'tw-editor://.';

const isReservedPopout = frameName => typeof frameName === 'string' && frameName.startsWith('tw-plus-');
const fromMainFrame = (event, contents, url) => {
  const frame = event.senderFrame;
  return frame && frame === contents.mainFrame && frame.origin === editorOrigin && frame.url === url;
};

class EditorPopoutWindow extends AbstractWindow {
  constructor (window, parentWindow, url) {
    super({existingWindow: window, parentWindow});
    this.initialURL = 'about:blank';
    const contents = window.webContents;
    contents.ipc.on('tw-plus-popup:enabled', event => {
      event.returnValue = Boolean(fromMainFrame(event, contents, url));
    });
    const mode = () => window.isMinimized() ? 'minimized' : window.isMaximized() ? 'maximized' : 'normal';
    contents.ipc.handle(controlsChannel, (event, action) => {
      if (!fromMainFrame(event, contents, url)) return;
      if (action === 'maximize') window.maximize();
      else if (action === 'minimize') window.minimize();
      else if (action === 'restore') {
        if (window.isMinimized()) window.restore();
        if (window.isMaximized()) window.unmaximize();
      } else if (action !== undefined) return;
      return mode();
    });
    for (const event of ['maximize', 'unmaximize', 'minimize', 'restore']) {
      window.on(event, () => {
        if (!contents.isDestroyed() && contents.getURL() === url) contents.send(controlsChannel, mode());
      });
    }
    contents.on('will-frame-navigate', event => {
      if (!event.isMainFrame) event.preventDefault();
    });
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('did-navigate-in-page', (_event, nextURL, isMainFrame) => {
      if (isMainFrame && nextURL !== url) window.destroy();
    });

    // Wait for Electron's initial about:blank navigation before loading the packaged document.
    const deadline = setTimeout(() => {
      if (!window.isDestroyed()) window.destroy();
    }, 5000).unref();
    window.once('closed', () => clearTimeout(deadline));
    const loadChild = () => {
      if (contents.getURL() !== 'about:blank' || contents.isLoadingMainFrame()) return;
      contents.removeListener('did-stop-loading', loadChild);
      setImmediate(() => {
        if (window.isDestroyed()) return;
        this.loadURL(url).then(() => {
          clearTimeout(deadline);
          if (!window.isDestroyed()) this.show();
        }).catch(error => {
          if (!window.isDestroyed()) {
            console.error('Could not load the detached editor panel:', error);
            window.destroy();
          }
        });
      });
    };
    contents.on('did-stop-loading', loadChild);
    loadChild();
  }

  handleWindowOpen () {
    return {action: 'deny'};
  }

  handleWillNavigate (event, url) {
    if (url !== 'about:blank' || this.initialURL !== 'about:blank') event.preventDefault();
  }

  handlePermissionCheck () {
    return false;
  }

  isPopup () {
    return true;
  }
}

function installEditorPopouts (editor, editorURL, enabled) {
  editorURL.searchParams.set('twPlusStandardLayout', '1');
  if (enabled.has('backpack')) editorURL.searchParams.set('twPlusBackpackPopout', '1');
  if (enabled.has('stage')) editorURL.searchParams.set('twPlusStagePopout', '1');
  if (enabled.has('sprite-list') || enabled.has('sprite-properties')) {
    editorURL.searchParams.set('twPlusTargetPanelsPopout', '1');
    editorURL.searchParams.set('twPlusSpriteProperties', '1');
    // The properties panel uses the editor's layout menu to reveal its undock control.
    editorURL.searchParams.set('twPlusWindowLayout', '1');
  }
  if (enabled.has('code')) editorURL.searchParams.set('twPlusCodePopout', '1');

  const parent = editor.window;
  const contents = parent.webContents;
  const reservations = new Map();
  const children = new Map();
  const clearReservation = frameName => {
    clearTimeout(reservations.get(frameName)?.expiry);
    reservations.delete(frameName);
  };
  const close = () => {
    for (const frameName of reservations.keys()) clearReservation(frameName);
    for (const {window} of children.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
  };

  editor.ipc.on('reserve-editor-popout', (event, kind, ticket) => {
    if (!fromMainFrame(event, contents, editorURL.href) || !enabled.has(kind) ||
        typeof ticket !== 'string' || !ticketPattern.test(ticket)) {
      event.returnValue = false;
      return;
    }
    const frameName = `tw-plus-${kind}-${ticket}`;
    const count = [...reservations.values(), ...children.values()].filter(item => item.kind === kind).length;
    if (reservations.has(frameName) || children.has(frameName) || count >= (kind === 'code' ? 2 : 1)) {
      event.returnValue = false;
      return;
    }
    reservations.set(frameName, {kind, ticket, expiry: setTimeout(() => clearReservation(frameName), 5000).unref()});
    event.returnValue = true;
  });
  contents.on('did-create-window', (window, {frameName, url: initialURL, postBody}) => {
    if (!isReservedPopout(frameName)) return;
    const reservation = reservations.get(frameName);
    if (!reservation?.consumed || initialURL !== 'about:blank' || postBody) {
      window.destroy();
      return;
    }
    const {kind} = reservation;
    const url = new URL(`${kind}-popout.html`, editorURL);
    url.hash = reservation.ticket;
    clearReservation(frameName);
    children.set(frameName, {kind, window});
    window.once('closed', () => children.delete(frameName));
    new EditorPopoutWindow(window, parent, url.href);
  });
  contents.on('did-start-navigation', event => {
    // The editor uses the History API for modal state without changing its URL.
    if (event.isMainFrame && (!event.isSameDocument || event.url !== editorURL.href)) close();
  });
  parent.once('closed', close);

  return details => {
    const reservation = reservations.get(details.frameName);
    if (contents.getURL() !== editorURL.href || !reservation || reservation.consumed ||
        details.url !== 'about:blank' || details.postBody) {
      return {action: 'deny'};
    }
    reservation.consumed = true;
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: {
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          preload: path.resolve(__dirname, '../../src-preload/editor-popout.js')
        }
      }
    };
  };
}

module.exports = {installEditorPopouts, isReservedPopout};
