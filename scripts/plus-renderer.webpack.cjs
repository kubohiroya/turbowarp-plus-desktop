const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');

const editor = process.env.TW_PLUS_EDITOR_SOURCE;
const config = require(path.join(editor, 'scripts/desktop/webpack.config.cts'));
const guiRequire = createRequire(path.join(process.env.E2E_GUI_ROOT, 'package.json'));
const HtmlWebpackPlugin = guiRequire('html-webpack-plugin');
const editorRequire = createRequire(path.join(editor, 'package.json'));
const addons = path.join(process.env.TW_PLUS_DESKTOP_SOURCE, 'src-renderer-webpack/editor/addons');
const gui = path.join(addons, '../gui');
const editorHost = path.join(editor, 'site/gui-integration/index.ts');
const hostProvider = config.plugins.find(plugin => plugin.definitions?.__TW_GUI_HOST__ === editorHost);
if (!hostProvider) throw new Error('The pinned Editor GUI host connection has changed');
hostProvider.definitions.__TW_GUI_HOST__ = path.join(gui, 'plus-gui-host.jsx');
config.resolve.alias['@tw-plus/pinned-gui-host$'] = editorHost;
config.resolve.alias['./editor-addon-startup.js$'] = path.join(gui, 'local-editor-addon-runtime.js');
config.resolve.alias['@tw-plus/pinned-stage-controls$'] =
  editorRequire.resolve('@kubohiroya/turbowarp-plus-editor-workbench/stage-controls');
config.resolve.alias['./local-extension-authoring.js$'] =
  createRequire(path.join(editor, 'package.json')).resolve('@kubohiroya/turbowarp-extension-loader/scratch-vm');
config.resolve.alias['@tw-plus/pinned-backpack-window-host$'] =
  path.join(editor, 'scripts/desktop/open-backpack-window.ts');
config.resolve.alias['@tw-plus/pinned-desktop-panel-host$'] =
  path.join(editor, 'site/editor-layout/desktop-panel-host.ts');
// The Editor takes the browser window host from windows' ./surfaces (Editor #753); use the same install.
config.resolve.alias['@tw-plus/browser-window-host$'] =
  createRequire(path.join(editor, 'package.json')).resolve('@kubohiroya/turbowarp-plus-editor-windows/surfaces');
// Saving collects edits from panels in other windows through the Editor's own collector. Resolve the
// package as the Editor does, so both imports share one registry.
config.resolve.alias['@tw-plus/pending-surface-edits$'] =
  createRequire(path.join(editor, 'package.json')).resolve('@kubohiroya/turbowarp-plus-editor-windows/surfaces');
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
config.entry['test-frame'] = path.join(editor, 'site/test-run/frame.ts');
config.plugins.push(new HtmlWebpackPlugin({chunks: ['test-frame'], filename: 'test-frame.html', title: 'Test'}));
config.plugins.push(new HtmlWebpackPlugin({
  chunks: ['desktop-addon-settings'],
  filename: 'addons.html',
  templateContent: template.replace(oldEntry, '')
}));
const addonFrame = path.join(gui, 'editor-addon-runtime-frame.js');
config.plugins.push(new HtmlWebpackPlugin({
  filename: 'editor-addon-runtime.html',
  inject: false,
  minify: false,
  templateContent: ({compilation}) => {
    compilation.fileDependencies.add(addonFrame);
    const source = fs.readFileSync(addonFrame, 'utf8').replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(source).digest('base64');
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}' blob:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><script>${source}</script>`;
  }
}));
module.exports = config;
