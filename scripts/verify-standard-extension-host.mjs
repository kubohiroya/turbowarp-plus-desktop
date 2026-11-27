import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';
const toolchain = process.env.TW_PLUS_SOURCE_BUILD_TOOLCHAIN;
const executable = process.env.TW_PLUS_SOURCE_BUILD_ELECTRON;
const resources = process.env.TW_PLUS_SOURCE_BUILD_RESOURCES;
if (!toolchain || !executable || !resources)
  throw new Error('Set the trusted Toolchain checkout, Electron executable and compiler resources');
const {resolveGitHubExtensionSnapshot} = await import(
  pathToFileURL(path.join(toolchain, 'dist/standard-extension-build.js')).href
);
const {lockStandardExtensionBuild, createDeterministicSb3} = await import(
  pathToFileURL(path.join(toolchain, 'dist/index.js')).href
);
const {unpackSb3} = await import(pathToFileURL(path.join(toolchain, 'dist/browser.js')).href);
const require = createRequire(import.meta.url);
const {createStandardExtensionBuilder} = require('../src-main/standard-extension-source-build');
const {zipSync, strToU8} = createRequire(path.join(toolchain, 'package.json'))('fflate');
const builder = createStandardExtensionBuilder({isPackaged: true, executable, resources: path.resolve(resources)});
if (!builder) throw new Error('No verified build host');
const {signal} = new AbortController();
const source = await resolveGitHubExtensionSnapshot('https://github.com/kubohiroya/turbowarp-extension-template', {
  ref: 'v0.13.0',
  expectedCommit: 'b4cd60ecf9f2a3094dc446bf1b99dabaeb89517a',
  signal,
});
const first = await builder.buildResult(source, signal);
const second = await builder.buildResult(source, signal);
if (JSON.stringify(first.receipt) !== JSON.stringify(second.receipt)) throw new Error('Different repeated receipts');
const lock = lockStandardExtensionBuild(first);
const id = JSON.parse(lock.apiJSON).id;
const marker = JSON.parse(first.files.get('extension-development.json'));
const project = {
  targets: [{isStage: true, name: 'Stage', blocks: {}, costumes: [], sounds: []}],
  extensions: [id],
  extensionURLs: {
    [id]: 'data:text/javascript;base64,' + Buffer.from(first.files.get(marker.bundle.file)).toString('base64'),
  },
};
const archive = zipSync({
  'project.json': strToU8(JSON.stringify(project)),
  'tw-plus/extension-locks.json': strToU8(JSON.stringify({formatVersion: 1, extensions: [{id, artifactLock: lock}]})),
});
const unpacked = unpackSb3(archive);
const directory = await mkdtemp(path.join(tmpdir(), 'tw-isolated-roundtrip-'));
try {
  for (const [name, bytes] of unpacked.files) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, bytes);
  }
  const rebuilt = await createDeterministicSb3(directory);
  const again = unpackSb3(rebuilt.archive);
  if (
    !Buffer.from(again.files.get('embedded-extensions.json')).equals(
      Buffer.from(unpacked.files.get('embedded-extensions.json')),
    )
  )
    throw new Error('Lost lock metadata');
  const local = await builder.buildResult({files: source.files}, signal);
  if (local.receipt.source.kind !== 'local-snapshot') throw new Error('Local source identity');
  const reference = JSON.parse(
    await readFile(path.join(toolchain, 'docs/evidence/issue-103-source-build.json'), 'utf8'),
  );
  if (JSON.stringify(reference.receipt.outputs) !== JSON.stringify(first.receipt.outputs))
    throw new Error('Different Node and Electron output hashes');
  const evidence = {
    toolchainReference: 'sb3-toolchain PR #109 / fb92d158cbf5d762590e4c6118d732ebed695bec',
    matchesNodeReference: true,
    at: new Date().toISOString(),
    host: {platform: process.platform, arch: process.arch, node: process.versions.node},
    environment: first.environment,
    source: source.source,
    sourceMeasurements: source.measurements,
    measurements: first.measurements,
    receipt: first.receipt,
    repeatedReceiptEqual: true,
    sb3Roundtrip: true,
    localSnapshot: true,
  };
  await writeFile('dist/source-build-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await rm(directory, {recursive: true, force: true});
}
