import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, promises as fs} from 'node:fs';
import path from 'node:path';
import asar from '@electron/asar';
import {Arch, build, Platform} from 'electron-builder';
import {verifyEditorWorkbench} from './editor-workbench-pin.mjs';

const desktop = path.resolve(import.meta.dirname, '..');
const [target, arch, sourceFile] = process.argv.slice(2);
const targets = new Map([
  ['dmg', {platform: Platform.MAC, arch: 'arm64', extension: '.dmg', hosts: ['darwin']}],
  ['nsis', {platform: Platform.WINDOWS, arch: 'x64', extension: '.exe', hosts: ['win32', 'linux']}],
  ['AppImage', {platform: Platform.LINUX, arch: 'x64', extension: '.AppImage', hosts: ['linux']}]
]);
const selected = targets.get(target);
assert.ok(selected?.hosts.includes(process.platform) && arch === selected.arch && arch === process.arch && sourceFile,
  'Usage: node scripts/package-development.mjs <dmg arm64|nsis x64|AppImage x64> <Editor site/source.json> on a supported host');
const {platform, extension} = selected;
const crossBuild = platform.nodeName !== process.platform;

const readJson = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const output = path.join(desktop, 'dist/development-package');
const staged = path.join(desktop, 'dist/development-artifact');
await fs.rm(staged, {recursive: true, force: true});

const rendererPath = 'dist-renderer-webpack/editor/plus-gui';
const renderer = path.join(desktop, rendererPath);
const buildInfoPath = path.join(renderer, 'build-info.json');
const buildInfo = await readJson(buildInfoPath);
const {editorRevision} = await readJson(path.join(desktop, 'config/plus-renderer.json'));
const {guiRepository, guiRevision, vmRepository, vmRevision} = await readJson(sourceFile);
const git = (...args) => execFileSync('git', args, {cwd: desktop, encoding: 'utf8'}).trim();
const desktopRevision = git('rev-parse', 'HEAD');
const {packages} = await readJson(path.join(desktop, 'package-lock.json'));
assert.deepEqual(
  [buildInfo.desktopRevision, buildInfo.editorRevision, buildInfo.guiRevision, buildInfo.vmRevision, buildInfo.electronVersion],
  [desktopRevision, editorRevision, guiRevision, vmRevision, packages['node_modules/electron'].version],
  'The built renderer differs from the checked-out Desktop or its pinned dependencies'
);
// The Editor checkout owns `site/source.json`; its lockfile and install name the adopted Workbench release.
assert.deepEqual(buildInfo.editorWorkbench, await verifyEditorWorkbench(path.resolve(path.dirname(sourceFile), '..')),
  'The built renderer does not record the Workbench release the pinned Editor adopts');
assert.equal(buildInfo.desktopDirty, false, 'Build the renderer from a clean Desktop checkout');
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Package from a clean Desktop checkout');

const builtFiles = await build({
  projectDir: desktop,
  targets: platform.createTarget(target, Arch[arch]),
  publish: 'never',
  config: {
    directories: {output},
    extraMetadata: {tw_dist: 'development-artifact', tw_update: false},
    mac: {identity: null, notarize: false},
    win: {signExecutable: false},
    ...(crossBuild && {npmRebuild: false}),
    afterPack: ({appOutDir, packager}) => {
      const archive = path.join(packager.getResourcesDir(appOutDir), 'app.asar');
      if (crossBuild) {
        assert.ok(!asar.listPackage(archive).some(filename => filename.endsWith('.node')),
          'Cross-packaging requires JavaScript-only runtime dependencies');
      }
      const embedded = asar.extractFile(archive, `${rendererPath}/build-info.json`);
      assert.deepEqual(JSON.parse(embedded.toString('utf8')), buildInfo, 'Packaged renderer metadata differs');
      asar.statFile(archive, `${rendererPath}/gui.html`);
      asar.statFile(archive, `${rendererPath}/addons.html`);
      asar.statFile(archive, `${rendererPath}/notices/family.json`);
    }
  }
});
const artifacts = builtFiles.filter(filename => path.extname(filename) === extension);
assert.equal(artifacts.length, 1, `Expected one ${extension} artifact from electron-builder`);
const [artifact] = artifacts;
const name = `TurboWarp-Plus-Desktop-development-${buildInfo.desktopVersion}-${platform.nodeName}-${arch}${extension}`;
const hash = createHash('sha256');
for await (const chunk of createReadStream(artifact)) hash.update(chunk);

await fs.mkdir(staged, {recursive: true});
await fs.copyFile(artifact, path.join(staged, name));
await fs.writeFile(path.join(staged, 'SHA256SUMS'), `${hash.digest('hex')}  ${name}\n`);
await fs.copyFile(buildInfoPath, path.join(staged, 'build-info.json'));
await fs.cp(path.join(renderer, 'notices'), path.join(staged, 'notices'), {recursive: true});
for (const [source, name] of [
  ['LICENSE', 'LICENSE'],
  ['scripts/library-files.json', 'library-files.json'],
  ['scripts/packager.json', 'packager.json'],
  ['docs/desktop-distribution.md', 'desktop-distribution.md']
]) {
  await fs.copyFile(path.join(desktop, source), path.join(staged, name));
}
const sources = {
  desktop: `https://github.com/kubohiroya/turbowarp-plus-desktop/tree/${desktopRevision}`,
  editor: `https://github.com/kubohiroya/turbowarp-plus-editor/tree/${editorRevision}`,
  gui: `https://github.com/${guiRepository}/tree/${guiRevision}`,
  vm: `https://github.com/${vmRepository}/tree/${vmRevision}`,
  editorWorkbench: buildInfo.editorWorkbench.resolved,
  standardGui: packages['node_modules/scratch-gui'].resolved,
  standardExtensions: packages['node_modules/@turbowarp/extensions'].resolved
};
await fs.writeFile(path.join(staged, 'source-info.json'), JSON.stringify(sources, null, 2) + '\n');
