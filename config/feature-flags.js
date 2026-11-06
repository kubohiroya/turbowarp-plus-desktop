exports.plusRenderer = process.env.TW_PLUS_DESKTOP_RENDERER === '1';
exports.documentCsp = process.env.TW_PLUS_DESKTOP_DOCUMENT_CSP === '1';
const targetPopouts = process.env.TW_PLUS_DESKTOP_TARGET_PANELS_POPOUT === '1';
exports.editorPopouts = new Set(exports.plusRenderer ? [
  ['backpack', process.env.TW_PLUS_DESKTOP_BACKPACK_POPOUT === '1'],
  ['stage', process.env.TW_PLUS_DESKTOP_STAGE_POPOUT === '1'],
  ['sprite-list', targetPopouts],
  ['sprite-properties', targetPopouts],
  ['code', process.env.TW_PLUS_DESKTOP_CODE_POPOUT === '1']
].filter(([, enabled]) => enabled).map(([kind]) => kind) : []);
exports.projectIsolation = process.env.TW_PLUS_DESKTOP_PROJECT_ISOLATION === '1';
exports.projectJSONTransfer = process.env.TW_PLUS_DESKTOP_JSON_TRANSFER === '1';
exports.projectAssetTransfer = exports.projectJSONTransfer && process.env.TW_PLUS_DESKTOP_ASSET_TRANSFER === '1';
exports.externalYaml = exports.projectIsolation && process.env.TW_PLUS_DESKTOP_EXTERNAL_YAML === '1';
exports.workspaceLayout = exports.projectIsolation && process.env.TW_PLUS_DESKTOP_WORKSPACE_LAYOUT === '1';
