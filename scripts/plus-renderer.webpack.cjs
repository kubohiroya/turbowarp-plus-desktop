const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');

const config = require(path.join(process.env.TW_PLUS_EDITOR_SOURCE, 'scripts/desktop/webpack.config.cts'));
const guiRequire = createRequire(path.join(process.env.E2E_GUI_ROOT, 'package.json'));
const HtmlWebpackPlugin = guiRequire('html-webpack-plugin');
const addons = path.join(process.env.TW_PLUS_DESKTOP_SOURCE, 'src-renderer-webpack/editor/addons');
const template = fs.readFileSync(path.join(addons, 'addons.html'), 'utf8');
const oldEntry = '<script src="index.js" onerror="webpackScriptError(event)"></script>';
if (!template.includes(oldEntry)) throw new Error('Desktop addon settings template has changed');

config.entry['desktop-addon-settings'] = path.join(addons, 'index.jsx');
config.plugins.push(new HtmlWebpackPlugin({
  chunks: ['desktop-addon-settings'],
  filename: 'addons.html',
  templateContent: template.replace(oldEntry, '')
}));
module.exports = config;
