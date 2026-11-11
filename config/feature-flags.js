const {existsSync} = require('node:fs');
const path = require('node:path');

const rendererOverride = process.env.TW_PLUS_DESKTOP_RENDERER;
exports.plusRenderer = rendererOverride === undefined
  ? process.versions.electron !== undefined &&
    require('electron').app?.isPackaged === true &&
    existsSync(path.join(__dirname, '../dist-renderer-webpack/editor/plus-gui/gui.html'))
  : rendererOverride === '1';
exports.documentCsp = process.env.TW_PLUS_DESKTOP_DOCUMENT_CSP === '1';
const targetPopouts = process.env.TW_PLUS_DESKTOP_TARGET_PANELS_POPOUT;
exports.editorPopouts = new Set(exports.plusRenderer ? [
  ['backpack', process.env.TW_PLUS_DESKTOP_BACKPACK_POPOUT === '1'],
  ['stage', process.env.TW_PLUS_DESKTOP_STAGE_POPOUT === '1'],
  ['sprite-list', targetPopouts !== '0'],
  ['sprite-properties', targetPopouts === '1'],
  ['code', process.env.TW_PLUS_DESKTOP_CODE_POPOUT === '1']
].filter(([, enabled]) => enabled).map(([kind]) => kind) : []);
exports.projectIsolation = process.env.TW_PLUS_DESKTOP_PROJECT_ISOLATION === '1';
exports.projectJSONTransfer = process.env.TW_PLUS_DESKTOP_JSON_TRANSFER === '1';
exports.projectAssetTransfer = exports.projectJSONTransfer && process.env.TW_PLUS_DESKTOP_ASSET_TRANSFER === '1';
exports.externalYaml = exports.projectIsolation && process.env.TW_PLUS_DESKTOP_EXTERNAL_YAML === '1';
