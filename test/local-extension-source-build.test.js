const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const {createHash} = require('node:crypto');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {test} = require('node:test');
const {openDirectory, readDevelopmentFile} = require('../src-main/local-extension-development');
const {createStandardExtensionBuilder, readSourceSnapshot, runSourceWorker, validateDiagnostics} = require('../src-main/standard-extension-source-build');
const {inspectPayload, verifyPayload, verifyBuildReceipt} = require('../src-main/standard-extension-payload');

test('payload verification detects modified, extra, linked and mismatched runtime files', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'tw-compiler-lock-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const worker = path.join(root, 'worker.mjs');
  await fs.writeFile(worker, 'fixed worker');
  const lock = {formatVersion: 1, recipe: 'turbowarp-standard-worker-v1', platform: 'darwin', arch: process.arch,
    electronVersion: '43.8.4', packages: {'@kubohiroya/sb3-toolchain': {version: '0.30.0'},
      rolldown: {version: '1.3.3', integrity: 'sha512-' + 'A'.repeat(86) + '=='}}, ...inspectPayload(root)};
  const marker = path.join(root, 'compiler-lock.json');
  await fs.writeFile(marker, JSON.stringify(lock));
  assert.equal(verifyPayload(root).bytes, 12);
  await fs.writeFile(worker, 'tampered');
  assert.throws(() => verifyPayload(root), {code: 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'});
  await fs.writeFile(worker, 'fixed worker');
  await fs.writeFile(path.join(root, 'extra.mjs'), 'unlocked');
  assert.throws(() => verifyPayload(root), {code: 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'});
  await fs.unlink(path.join(root, 'extra.mjs'));
  await fs.symlink(worker, path.join(root, 'linked.mjs'));
  assert.throws(() => verifyPayload(root), {code: 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'});
  await fs.unlink(path.join(root, 'linked.mjs'));
  assert.throws(() => verifyPayload(root, 'different-arch'), {code: 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'});
});

test('receipt normalization binds input, lock, compiler and all actual output bytes', () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const snapshot = {files: new Map([['pnpm-lock.yaml', Buffer.from('locked')], ['src/index.ts', Buffer.from('source')]])};
  const files = new Map(['fixture.js', 'fixture.js.map', 'extension-manifest.json', 'extension-development.json'].map(name => [name, Buffer.from(name)]));
  const payload = {packages: {rolldown: {version: '1.3.3', integrity: 'sha512-' + 'A'.repeat(86) + '=='}}};
  const raw = {profile: 'turbowarp-typescript-v1', execution: 'sandboxed', compiler: {name: 'rolldown', version: '1.3.3'},
    snapshotSHA256: sha(JSON.stringify([...snapshot.files.keys()].sort().map(name => [name, sha(snapshot.files.get(name))]))),
    lockfileSHA256: sha(snapshot.files.get('pnpm-lock.yaml')), outputs: Object.fromEntries([...files].map(([name, bytes]) => [name, sha(bytes)]))};
  const normalized = verifyBuildReceipt(raw, files, snapshot, payload);
  assert.equal(normalized.formatVersion, 1);
  assert.deepEqual(normalized.source, {kind: 'local-snapshot'});
  const origin = {kind: 'github', repository: 'outside-editor/fixture', commit: 'a'.repeat(40)};
  assert.deepEqual(verifyBuildReceipt(raw, files, {...snapshot, source: origin}, payload).source, origin);
  assert.throws(() => verifyBuildReceipt(raw, files, {...snapshot, source: {...origin, token: 'private'}}, payload),
    {code: 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'});
  assert.equal(normalized.compiler.integrity, payload.packages.rolldown.integrity);
  for (const changed of [{...raw, formatVersion: 9}, {...raw, token: 'must not persist'},
    {...raw, source: {kind: 'local-snapshot', path: '/private/source'}}, {...raw, lockfileSHA256: '0'.repeat(64)},
    {...raw, compiler: {...raw.compiler, path: '/private/compiler'}},
    {...raw, outputs: {...raw.outputs, 'fixture.js': '0'.repeat(64)}}]) {
    assert.throws(() => verifyBuildReceipt(changed, files, snapshot, payload), {code: 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'});
  }
});

test('compiler diagnostics expose only relative locations and stable codes', () => {
  const safe = {code: 'PARSE_ERROR', file: 'src/index.ts', line: 2, column: 4};
  assert.deepEqual(validateDiagnostics([{...safe, message: 'private source', frame: 'secret'},
    {...safe, file: '/private/source.ts'}, {...safe, file: 'src/../private.ts'}, {...safe, line: 0}]), [safe]);
  assert.deepEqual(validateDiagnostics([{...safe, file: 'src/日本語.ts'}]), [{...safe, file: 'src/日本語.ts'}]);
});

test('unsupported hosts and unavailable compiler payloads do not enable source builds', () => {
  for (const platform of ['win32', 'linux']) assert.equal(createStandardExtensionBuilder({platform, isPackaged: true}), null);
  assert.equal(createStandardExtensionBuilder({platform: 'darwin', mas: true, isPackaged: true}), null);
  assert.equal(createStandardExtensionBuilder({platform: 'darwin', isPackaged: true, resources: '/missing/compiler'}), null);
});

test('a source snapshot includes only bounded profile inputs', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'tw-source-input-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'src'));
  const write = (file, data) => fs.writeFile(path.join(root, file), data);
  await write('extension-build.json', '{"settings":"src/settings.json"}');
  await write('package.json', '{}');
  await write('pnpm-lock.yaml', '');
  await write('src/settings.json', '{"id":"fixture","unsandboxed":false}');
  await write('src/index.ts', 'export {};');
  await write('vite.config.ts', 'throw new Error("Do not run the project configuration");');
  await write('.env', 'TW_TEST_SENTINEL=outside');
  const directory = await openDirectory(root);
  const read = signal => readSourceSnapshot(directory, signal ?? new AbortController().signal, readDevelopmentFile);
  const {files, digest} = await read();
  assert.deepEqual([...files.keys()].sort(), [
    'extension-build.json', 'package.json', 'pnpm-lock.yaml', 'src/index.ts', 'src/settings.json'
  ]);
  assert.equal((await read()).digest, digest);
  await write('src/index.ts', Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(read(), {code: 'LOCAL_EXTENSION_SOURCE_LIMIT'});
  await write('src/index.ts', 'export {};');
  for (let i = 0; i < 4; i++) await write('src/big-' + i + '.ts', Buffer.alloc(1024 * 1024));
  await assert.rejects(read(), {code: 'LOCAL_EXTENSION_SOURCE_LIMIT'});
  for (let i = 0; i < 4; i++) await fs.unlink(path.join(root, 'src/big-' + i + '.ts'));
  await fs.symlink(path.join(root, '.env'), path.join(root, 'src/linked.ts'));
  await assert.rejects(read(), {code: 'LOCAL_EXTENSION_BOUNDARY'});
  await fs.unlink(path.join(root, 'src/linked.ts'));
  for (let i = 0; i < 129; i++) await write('src/item-' + i + '.ts', '');
  await assert.rejects(read(), {code: 'LOCAL_EXTENSION_SOURCE_LIMIT'});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(read(controller.signal), {name: 'AbortError'});
});

const binary = process.env.TW_PLUS_SOURCE_BUILD_ELECTRON;
test('macOS enforces file, process, network and environment isolation plus worker budgets',
  {skip: process.platform !== 'darwin' || !binary, timeout: 15_000}, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'tw-source-sandbox-')));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const compiler = path.join(root, 'compiler');
    await fs.mkdir(compiler);
    const executable = await fs.realpath(binary);
    const appRoot = path.resolve(executable, '../..');
    const worker = path.join(compiler, 'worker.cjs');
    const privateFile = path.join(root, 'private.txt');
    await fs.writeFile(privateFile, 'isolated probe data');
    const signalTarget = spawn('/bin/sleep', ['15'], {env: {}, stdio: 'ignore'});
    t.after(() => signalTarget.kill('SIGKILL'));
    const server = net.createServer(socket => socket.end());
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    await fs.writeFile(worker, `
      const fs = require('node:fs');
      const net = require('node:net');
const {createHash} = require('node:crypto');
      const {spawnSync} = require('node:child_process');
      const denial = attempt => { try { attempt(); return 'allowed'; } catch (error) { return error.code; } };
      const results = {
        read: denial(() => fs.readFileSync(${JSON.stringify(privateFile)})),
        readDataVolumeAlias: denial(() => fs.readFileSync(${JSON.stringify('/System/Volumes/Data' + privateFile)})),
        write: denial(() => fs.writeFileSync(${JSON.stringify(path.join(compiler, 'write-check'))}, 'x')),
        spawn: spawnSync('/usr/bin/true').error?.code ?? 'allowed',
        signal: denial(() => process.kill(${signalTarget.pid}, 'SIGTERM')),
        initialEnv: Object.keys(process.env).sort()
      };
      const socket = net.connect(${server.address().port}, '127.0.0.1');
      const finish = network => {
        socket.destroy();
        results.network = network;
        console.log(JSON.stringify({formatVersion: 1, files: [
          ['result', Buffer.from(JSON.stringify(results)).toString('base64')], ['a', ''], ['b', ''], ['c', '']
        ]}));
      };
      socket.once('error', error => finish(error.code));
      socket.once('connect', () => finish('allowed'));
    `);
    const options = {executable, appRoot, worker};
    const run = (signal = new AbortController().signal, budget) => runSourceWorker(options, '[]', signal, budget);
    const results = JSON.parse((await run()).files.get('result'));
    for (const operation of ['read', 'readDataVolumeAlias', 'write', 'spawn', 'signal', 'network']) assert.match(results[operation], /^(EACCES|EPERM)$/u);
    assert.deepEqual(results.initialEnv, ['ELECTRON_RUN_AS_NODE', 'RAYON_NUM_THREADS', 'UV_THREADPOOL_SIZE']);
    t.diagnostic('macOS rejected reads outside the runtime and compiler, writes, subprocess creation and a loopback connection');

    await fs.writeFile(worker, 'process.stdout.write("x".repeat(32768)); setTimeout(() => {}, 10000);');
    await assert.rejects(run(undefined, {outputLimit: 1024}), {code: 'LOCAL_EXTENSION_SOURCE_LIMIT'});
    await fs.writeFile(worker, 'setTimeout(() => {}, 10000);');
    await assert.rejects(run(undefined, {timeoutMs: 400}), {code: 'LOCAL_EXTENSION_SOURCE_TIMEOUT'});
    const controller = new AbortController();
    const running = run(controller.signal);
    await delay(300);
    controller.abort();
    await assert.rejects(running, {code: 'LOCAL_EXTENSION_SOURCE_CANCELLED'});
    t.diagnostic('oversized output, deadlines and cancellation terminate the worker');
    await fs.writeFile(worker, 'const chunks = []; setInterval(() => chunks.push(Buffer.alloc(8 * 1024 * 1024, 1)), 40);');
    await assert.rejects(run(undefined, {residentLimit: 128 * 1024 * 1024, sampleMs: 20, timeoutMs: 4000}),
      {code: 'LOCAL_EXTENSION_SOURCE_LIMIT'});
    t.diagnostic('native Buffer memory exceeding the sampled RSS budget terminates the worker');
  });


const resources = process.env.TW_PLUS_SOURCE_BUILD_RESOURCES;
test('the packaged compiler builds the standard profile from a bounded snapshot',
  {skip: process.platform !== 'darwin' || !binary || !resources, timeout: 30_000}, async t => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'tw-bundled-compiler-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    await fs.mkdir(path.join(root, 'src'));
    const inputs = {
      'extension-build.json': JSON.stringify({formatVersion: 1, profile: 'turbowarp-typescript-v1',
        entry: 'src/index.ts', settings: 'src/extension-config.json', blocks: 'src/block-definitions.json',
        lockfile: 'pnpm-lock.yaml', dependencies: 'none'}),
      'package.json': JSON.stringify({name: 'compiler-fixture', scripts: {build: 'exit 41', prepare: 'exit 42'}}),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'",
      'src/extension-config.json': JSON.stringify({id: 'fixture', slug: 'compiler-fixture', name: 'Compiler fixture',
        description: 'Standard build packaging test', author: 'Test', license: 'MPL-2.0', unsandboxed: false,
        docsURI: 'https://example.com/', blockIconURI: 'data:image/svg+xml;base64,PHN2Zy8+'}),
      'src/block-definitions.json': JSON.stringify({extensionName: 'Compiler fixture',
        blocks: [{opcode: 'value', blockType: 'REPORTER', text: 'value'}]}),
      'src/index.ts': 'const value: number = 41; Scratch.extensions.register({value});',
      'vite.config.ts': 'throw new Error("Project Vite config must never run");'
    };
    await Promise.all(Object.entries(inputs).map(([file, value]) => fs.writeFile(path.join(root, file), value)));

    const builder = createStandardExtensionBuilder({isPackaged: true, resources, executable: binary});
    assert.ok(builder, 'The bundle must provide the packaged compiler');
    const directory = await openDirectory(root);
    const {signal} = new AbortController();
    const compile = async () => builder.build(await builder.read(directory, signal, readDevelopmentFile), signal);
    const first = await compile();
    assert.deepEqual(await compile(), first);
    const descriptor = JSON.parse(first.get('extension-development.json'));
    assert.equal(descriptor.id, 'fixture');
    assert.equal(descriptor.bundle.file, 'compiler-fixture.js');
    for (const part of [descriptor.bundle, descriptor.api, descriptor.sourceMap]) {
      assert.equal(createHash('sha256').update(first.get(part.file)).digest('hex'), part.sha256);
    }
    assert.deepEqual(JSON.parse(first.get(descriptor.sourceMap.file)).sources, ['src/index.ts']);
    await fs.writeFile(path.join(root, 'src/index.ts'), 'const value: number = 42; Scratch.extensions.register({value});');
    const next = JSON.parse((await compile()).get('extension-development.json'));
    assert.notEqual(next.bundle.sha256, descriptor.bundle.sha256);
    assert.equal(next.api.sha256, descriptor.api.sha256);
    await assert.rejects(fs.access(path.join(root, 'node_modules')), {code: 'ENOENT'});
    await assert.rejects(fs.access(path.join(root, 'dist')), {code: 'ENOENT'});
    const current = await builder.read(directory, signal, readDevelopmentFile);
    const result = await builder.buildResult(current, signal);
    assert.equal(result.receipt.formatVersion, 1);
    assert.deepEqual(result.receipt.source, {kind: 'local-snapshot'});
    assert.ok(result.measurements.payloadBytes > 0);
    assert.ok(result.measurements.inputBytes > 0);
    assert.ok(result.measurements.outputBytes > 0);
    assert.equal(result.measurements.additionalRuntimeDownloadBytes, 0);
    assert.equal(JSON.stringify(result.receipt).includes(root), false);
    const workerFile = path.join(resources, 'standard-extension-compiler', process.arch, 'worker.mjs');
    const originalWorker = await fs.readFile(workerFile);
    try {
      await fs.writeFile(workerFile, Buffer.concat([originalWorker, Buffer.from('\n// modified after preparation\n')]));
      await assert.rejects(builder.buildResult(current, signal), {code: 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'});
    } finally { await fs.writeFile(workerFile, originalWorker); }
    await fs.writeFile(path.join(root, 'src/index.ts'), 'const value: = ;');
    await assert.rejects(compile(), error => {
      assert.equal(error.code, 'LOCAL_EXTENSION_SOURCE_FAILED');
      assert.deepEqual(error.diagnostics, [{code: 'PARSE_ERROR', file: 'src/index.ts', line: 1, column: 14}]);
      return true;
    });
  });
