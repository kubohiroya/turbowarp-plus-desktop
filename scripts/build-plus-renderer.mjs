import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const desktop = path.resolve(import.meta.dirname, '..');
const [editorArgument, guiArgument] = process.argv.slice(2);
if (!editorArgument || !guiArgument) {
  throw new Error('Usage: npm run webpack:plus -- <Editor checkout> <Scratch GUI checkout>');
}
const editor = path.resolve(editorArgument);
const gui = path.resolve(guiArgument);
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], {encoding: 'utf8'}).trim();
const revision = directory => git(directory, 'rev-parse', 'HEAD');
const {editorRevision} = await json(path.join(desktop, 'config/plus-renderer.json'));

assert.equal(revision(editor), editorRevision, 'Editor checkout differs from the Desktop renderer pin');
assert.equal(git(editor, 'status', '--porcelain'), '', 'Editor checkout must be clean');
assert.equal(git(gui, 'status', '--porcelain'), '', 'GUI checkout must be clean');

const editorModule = name => import(pathToFileURL(path.join(editor, 'scripts/site', name)).href);
const source = await editorModule('source.ts');
const pins = await source.readPins();
const {revision: guiRevision} = await source.verifyHost(gui, pins);
await source.verifyInstalledCore(editor, pins);
await source.verifyDocumentEditorDependency(editor, pins);
await source.verifyLoaderDependency(editor, pins);
await source.verifySecurityDependency(editor, pins);
await source.verifyScriptTransferDependency(editor, pins);
const {buildFamilyNotices} = await editorModule('family-notices.ts');

const outputRoot = path.join(desktop, 'dist-renderer-webpack/editor');
await fs.mkdir(outputRoot, {recursive: true});
const stage = await fs.mkdtemp(path.join(outputRoot, '.plus-gui-'));
const destination = path.join(outputRoot, 'plus-gui');

try {
  const env = {
    ...process.env,
    CI: '1',
    NODE_ENV: 'production',
    ROOT: '',
    E2E_GUI_ROOT: gui,
    TW_PLUS_DESKTOP_SOURCE: desktop,
    DISABLE_V8_COMPILE_CACHE: '1'
  };
  delete env.TW_PLUS_LOCAL_CATALOG_INPUT;
  execFileSync(process.execPath, [
    '--openssl-legacy-provider', path.join(gui, 'node_modules/webpack/bin/webpack.js'),
    '--config', path.join(editor, 'scripts/desktop/webpack.config.cts'),
    '--output-path', stage, '--bail'
  ], {cwd: gui, env, stdio: 'inherit'});

  await fs.access(path.join(stage, 'gui.html'));
  const familyNotices = await buildFamilyNotices(stage, [
    {origin: 'scratch-gui', directory: gui},
    {origin: 'turbowarp-plus-editor', directory: editor, includeDev: true}
  ]);
  const {version: desktopVersion} = await json(path.join(desktop, 'package.json'));
  const {version: electronVersion} = await json(path.join(desktop, 'node_modules/electron/package.json'));
  const buildInfo = {
    desktopRevision: revision(desktop),
    desktopDirty: git(desktop, 'status', '--porcelain', '--untracked-files=no') !== '',
    desktopVersion, electronVersion, editorRevision, guiRevision, vmRevision: pins.vmRevision,
    previewReloadStyles: pins.previewReloadStyles, familyNotices
  };
  await fs.writeFile(path.join(stage, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');
  await fs.rm(destination, {recursive: true, force: true});
  await fs.rename(stage, destination);
  console.log('Plus renderer: ' + path.join(destination, 'build-info.json'));
} finally {
  await fs.rm(stage, {recursive: true, force: true});
}
