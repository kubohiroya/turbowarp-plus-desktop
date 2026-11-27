import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const require = createRequire(import.meta.url);
const {createStandardExtensionBuilder} = require('../src-main/standard-extension-source-build');
const {installGitHubExtensionSourceJobs} = require('../src-main/github-extension-source-jobs');
const executable = process.env.TW_PLUS_SOURCE_BUILD_ELECTRON;
const resources = process.env.TW_PLUS_SOURCE_BUILD_RESOURCES;
if (!executable || !resources) throw new Error('Set the trusted Node-mode Electron executable and prepared resources');
const builder = createStandardExtensionBuilder({isPackaged: true, executable, resources: path.resolve(resources)});
assert.ok(builder, 'Prepare the verified Toolchain 0.31.2 payload');
const contents = new EventEmitter();
contents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
const handlers = new Map();
installGitHubExtensionSourceJobs({on() {}, handle: (name, handler) => handlers.set(name, handler)}, contents, {builder, enabled: true});
const event = {sender: contents, senderFrame: contents.mainFrame};
const invoke = (name, ...args) => handlers.get('github-extension-source-' + name)(event, ...args);
const request = {repository: 'kubohiroya/turbowarp-extension-template', ref: 'v0.13.0',
  expectedCommit: 'b4cd60ecf9f2a3094dc446bf1b99dabaeb89517a'};
try {
  const prepared = await invoke('prepare', request);
  assert.equal(prepared.status, 'prepared', prepared.code);
  assert.throws(() => invoke('result', prepared.job), {code: 'GITHUB_EXTENSION_SOURCE_UNAVAILABLE'});
  const ready = await invoke('build', prepared.job);
  assert.equal(ready.status, 'ready', ready.code);
  const result = invoke('result', prepared.job);
  assert.equal(result.receipt.source.commit, request.expectedCommit);
  assert.equal(result.receipt.compiler.version, '1.3.4');
  const reference = JSON.parse(await readFile(new URL('../docs/evidence/standard-extension-host-macos-arm64.json', import.meta.url), 'utf8'));
  assert.deepEqual(result.receipt.outputs, reference.receipt.outputs);
  const compiler = path.join(path.resolve(resources), 'standard-extension-compiler', process.arch);
  const {lockStandardExtensionBuild} = await import(pathToFileURL(
    path.join(compiler, 'node_modules/@kubohiroya/sb3-toolchain/dist/extension-artifact-lock.js')).href);
  const lock = lockStandardExtensionBuild({files: new Map(result.files), receipt: result.receipt});
  assert.equal(lock.provenance.kind, 'build');
  await invoke('cancel', prepared.job);
  assert.throws(() => invoke('result', prepared.job), {code: 'GITHUB_EXTENSION_SOURCE_UNAVAILABLE'});
  const evidence = {at: new Date().toISOString(), desktopCodeRevision: process.env.TW_PLUS_VERIFICATION_REVISION ?? 'local',
    platform: process.platform, arch: process.arch, source: result.source,
    toolchain: '0.31.2', receipt: result.receipt, measurements: result.measurements,
    preparedWithoutCompilation: true, sharedArtifactLockAccepted: true, cancelledResultUnavailable: true, matchesPR79Outputs: true,
    validationScope: 'Real public GitHub broker and isolated compiler with a previously built Electron 43.8.4 Node-mode runtime; in-process test IPC transport, no product renderer or new DMG tested.'};
  await writeFile('dist/github-source-jobs-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  contents.emit('destroyed');
}
