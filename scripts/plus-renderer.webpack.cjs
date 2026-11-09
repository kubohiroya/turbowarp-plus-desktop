const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');

const editor = process.env.TW_PLUS_EDITOR_SOURCE;
const config = require(path.join(editor, 'scripts/desktop/webpack.config.cts'));
const guiRequire = createRequire(path.join(process.env.E2E_GUI_ROOT, 'package.json'));
const HtmlWebpackPlugin = guiRequire('html-webpack-plugin');
const addons = path.join(process.env.TW_PLUS_DESKTOP_SOURCE, 'src-renderer-webpack/editor/addons');
const gui = path.join(addons, '../gui');
config.resolve.alias['@tw-plus/pinned-backpack-window-host$'] =
  path.join(editor, 'scripts/desktop/open-backpack-window.ts');
config.resolve.alias['@tw-plus/pinned-desktop-panel-host$'] =
  path.join(editor, 'site/editor-layout/desktop-panel-host.ts');
config.resolve.alias['@tw-plus/browser-window-host$'] =
  path.join(editor, 'site/editor-backpack/browser-host.ts');
// Saving collects edits from panels in other windows through the Editor's own collector. Resolve the
// package as the Editor does, so both imports share one registry.
config.resolve.alias['@tw-plus/pending-surface-edits$'] =
  createRequire(path.join(editor, 'package.json')).resolve('@kubohiroya/turbowarp-editor-surfaces');
// Keep the Desktop adapter at the pinned Editor's existing window host boundaries.
const popoutHost = path.join(gui, 'popout-host.js');
for (const request of [
  '@tw-plus/backpack-window-host',
  './desktop-panel-host.ts',
  '../editor-layout/desktop-panel-host.ts',
  '../../editor-layout/desktop-panel-host.ts'
]) {
  config.resolve.alias[request + '$'] = popoutHost;
}
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
