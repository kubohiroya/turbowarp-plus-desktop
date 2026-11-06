const {app, dialog} = require('electron');

app.setActivationPolicy('accessory');
app.setPath('userData', process.env.TW_PLUS_DESKTOP_DATA_DIR);

// Exercise the real BrowserWindows without showing them or moving OS focus.
require('../src-main/windows/abstract').prototype.show = () => {};
dialog.showMessageBoxSync = (windowOrOptions, options) => {
  console.error((options || windowOrOptions).message);
  app.exit(1);
};

require('../src-main/entrypoint');
