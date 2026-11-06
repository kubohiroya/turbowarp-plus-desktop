const path = require('node:path');
const AbstractWindow = require('./abstract');

const framePrefix = 'tw-plus-backpack-';
const ticketPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const controlsChannel = 'tw-plus-popup:mode';
const editorOrigin = 'tw-editor://.';

const isReservedPopout = frameName => typeof frameName === 'string' && frameName.startsWith('tw-plus-');
const fromMainFrame = (event, contents, url) => {
  const frame = event.senderFrame;
  return frame && frame === contents.mainFrame && frame.origin === editorOrigin && frame.url === url;
};

class BackpackPopoutWindow extends AbstractWindow {
  constructor (window, parentWindow, url) {
    super({existingWindow: window, parentWindow});
    this.initialURL = 'about:blank';
    const contents = window.webContents;
    const mode = () => window.isMinimized() ? 'minimized' : window.isMaximized() ? 'maximized' : 'normal';
    contents.ipc.handle(controlsChannel, (event, action) => {
      if (!fromMainFrame(event, contents, url)) return;
      if (action === 'maximize') window.maximize();
      else if (action === 'minimize') window.minimize();
      else if (action === 'restore') {
        if (window.isMinimized()) window.restore();
        if (window.isMaximized()) window.unmaximize();
      }
      else if (action !== undefined) return;
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
            console.error('Could not load the detached backpack:', error);
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

function installBackpackPopout (editor, editorURL) {
  const parent = editor.window;
  const contents = parent.webContents;
  let reservation;
  let child;
  const clearReservation = () => {
    if (!reservation) return;
    clearTimeout(reservation.expiry);
    reservation = undefined;
  };
  const close = () => {
    clearReservation();
    if (child && !child.isDestroyed()) child.destroy();
  };

  editor.ipc.on('reserve-backpack-popout', (event, ticket) => {
    if (!fromMainFrame(event, contents, editorURL) ||
        typeof ticket !== 'string' || !ticketPattern.test(ticket) || child || reservation) {
      event.returnValue = false;
      return;
    }
    reservation = {frameName: framePrefix + ticket, ticket, expiry: setTimeout(clearReservation, 5000).unref()};
    event.returnValue = true;
  });
  const matchesReservation = details =>
    reservation && details.frameName === reservation.frameName && details.url === 'about:blank' && !details.postBody;
  contents.on('did-create-window', (window, details) => {
    if (!isReservedPopout(details.frameName)) return;
    if (!matchesReservation(details) || !reservation.consumed) {
      window.destroy();
      return;
    }
    const url = new URL('backpack-popout.html', editorURL);
    url.hash = reservation.ticket;
    clearReservation();
    child = window;
    window.once('closed', () => { child = undefined; });
    new BackpackPopoutWindow(window, parent, url.href);
  });
  contents.on('did-start-navigation', event => {
    if (event.isMainFrame) close();
  });
  parent.once('closed', close);

  return details => {
    if (contents.getURL() !== editorURL || !matchesReservation(details) || reservation.consumed) {
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
          preload: path.resolve(__dirname, '../../src-preload/backpack-popout.js')
        }
      }
    };
  };
}

module.exports = {installBackpackPopout, isReservedPopout};
