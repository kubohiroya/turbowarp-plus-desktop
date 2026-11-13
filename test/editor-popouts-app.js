const {app, dialog} = require('electron');

app.setActivationPolicy('accessory');
app.setPath('userData', process.env.TW_PLUS_DESKTOP_DATA_DIR);

if (process.env.TW_PLUS_TEST_OFFLINE === '1') {
  app.commandLine.appendSwitch('proxy-server', 'http://127.0.0.1:65535');
  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
}

// Exercise the real BrowserWindows without showing them or moving OS focus.
require('../src-main/windows/abstract').prototype.show = () => {};
app.on('browser-window-created', (_event, window) => {
  window.show = () => {};
  window.focus = () => {};
});
dialog.showErrorBox = (_title, message) => {
  console.error(message);
  app.exit(1);
};
dialog.showMessageBoxSync = (windowOrOptions, options) => {
  console.error((options || windowOrOptions).message);
  app.exit(1);
};

require('../src-main/entrypoint');
