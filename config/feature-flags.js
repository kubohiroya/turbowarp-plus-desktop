exports.plusRenderer = process.env.TW_PLUS_DESKTOP_RENDERER === '1';
exports.projectIsolation = process.env.TW_PLUS_DESKTOP_PROJECT_ISOLATION === '1';
exports.projectJSONTransfer = process.env.TW_PLUS_DESKTOP_JSON_TRANSFER === '1';
exports.projectAssetTransfer = exports.projectJSONTransfer && process.env.TW_PLUS_DESKTOP_ASSET_TRANSFER === '1';
exports.externalYaml = exports.projectIsolation && process.env.TW_PLUS_DESKTOP_EXTERNAL_YAML === '1';
exports.workspaceLayout = exports.projectIsolation && process.env.TW_PLUS_DESKTOP_WORKSPACE_LAYOUT === '1';
