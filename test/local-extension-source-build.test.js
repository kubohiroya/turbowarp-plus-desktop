const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {test} = require('node:test');
const {openDirectory, readDevelopmentFile} = require('../src-main/local-extension-development');
const {readSourceSnapshot, runSourceWorker} = require('../src-main/standard-extension-source-build');

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
    const server = net.createServer(socket => socket.end());
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    await fs.writeFile(worker, `
      const fs = require('node:fs');
      const net = require('node:net');
      const {spawnSync} = require('node:child_process');
      const denial = attempt => { try { attempt(); return 'allowed'; } catch (error) { return error.code; } };
      const results = {
        read: denial(() => fs.readFileSync(${JSON.stringify(privateFile)})),
        write: denial(() => fs.writeFileSync(${JSON.stringify(path.join(compiler, 'write-check'))}, 'x')),
        spawn: spawnSync('/usr/bin/true').error?.code ?? 'allowed',
        initialEnv: Object.keys(process.env).sort()
      };
      const socket = net.connect(${server.address().port}, '127.0.0.1');
      const finish = network => {
        socket.destroy();
        results.network = network;
        console.log(JSON.stringify([
          ['result', Buffer.from(JSON.stringify(results)).toString('base64')], ['a', ''], ['b', ''], ['c', '']
        ]));
      };
      socket.once('error', error => finish(error.code));
      socket.once('connect', () => finish('allowed'));
    `);
    const options = {executable, appRoot, worker};
    const run = (signal = new AbortController().signal, budget) => runSourceWorker(options, '[]', signal, budget);
    const results = JSON.parse((await run()).get('result'));
    for (const operation of ['read', 'write', 'spawn', 'network']) assert.match(results[operation], /^(EACCES|EPERM)$/u);
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
  });
