const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {EventEmitter, once} = require('node:events');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {test} = require('node:test');
const {installLocalExtensionDevelopment, openDirectory, readDevelopmentBuild, readDevelopmentFile} = require('../src-main/local-extension-development');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const id = 'fixture';
const api = JSON.stringify({formatVersion: 1, id, blocks: [], menus: []});

async function fixture (t, extensionId = id) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'tw-extension-watcher-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const dist = path.join(root, 'dist');
  await fs.mkdir(dist);
  const files = {
    bundle: path.join(dist, 'fixture.js'),
    api: path.join(dist, 'extension-manifest.json'),
    map: path.join(dist, 'fixture.js.map'),
    marker: path.join(dist, 'extension-development.json')
  };
  const publish = async (bundle, manifest = JSON.stringify({...JSON.parse(api), id: extensionId})) => {
    await fs.writeFile(files.bundle, bundle);
    await fs.writeFile(files.api, manifest);
    await fs.writeFile(`${files.marker}.tmp`, JSON.stringify({formatVersion: 1, id: extensionId,
      bundle: {file: 'fixture.js', sha256: sha256(bundle)}, api: {file: 'extension-manifest.json', sha256: sha256(manifest)}}));
    await fs.rename(`${files.marker}.tmp`, files.marker);
  };
  return {root, publish, files};
}

test('a development snapshot rejects partial files and references outside the selected directory', async t => {
  const {root, publish, files} = await fixture(t);
  await publish('first');
  const directory = await openDirectory(root);
  assert.equal((await readDevelopmentBuild(directory)).sha256, sha256('first'));
  await fs.writeFile(files.bundle, 'unfinished');
  await assert.rejects(readDevelopmentBuild(directory), {code: 'LOCAL_EXTENSION_INCOMPLETE'});
  const other = path.join(root, 'private.js');
  await fs.writeFile(other, 'private');
  await fs.unlink(files.bundle);
  await fs.symlink(other, files.bundle, 'file');
  await assert.rejects(readDevelopmentBuild(directory), {code: 'LOCAL_EXTENSION_BOUNDARY'});
});

test('a development snapshot verifies its optional map without exposing its contents', async t => {
  const {root, publish, files} = await fixture(t);
  await publish('first');
  const directory = await openDirectory(root);
  const descriptor = JSON.parse(await fs.readFile(files.marker, 'utf8'));
  assert.equal(Object.hasOwn(await readDevelopmentBuild(directory), 'sourceMapSHA256'), false);
  const map = {version: 3, file: 'fixture.js', sources: ['src/extension.ts', '[external]'], names: [], mappings: 'AAAA'};
  const writeMap = async (value, file = 'fixture.js.map') => {
    const body = JSON.stringify(value);
    const hash = sha256(body);
    await fs.writeFile(files.map, body);
    await fs.writeFile(files.marker, JSON.stringify({...descriptor, sourceMap: {file, sha256: hash}}));
    return hash;
  };
  const hash = await writeMap(map);
  assert.deepEqual(await readDevelopmentBuild(directory), {
    id, bytes: new Uint8Array(Buffer.from('first')), sha256: sha256('first'), apiSHA256: sha256(api),
    sourceMapSHA256: hash
  });
  await fs.writeFile(files.map, 'changed');
  await assert.rejects(readDevelopmentBuild(directory), {code: 'LOCAL_EXTENSION_INCOMPLETE'});
  await writeMap(map, '../fixture.js.map');
  await assert.rejects(readDevelopmentBuild(directory), {code: 'LOCAL_EXTENSION_DESCRIPTOR'});
  await writeMap({...map, sources: ['../../outside.ts']});
  await assert.rejects(readDevelopmentBuild(directory), {code: 'LOCAL_EXTENSION_DESCRIPTOR'});
  await writeMap({...map, sourcesContent: ['private source']});
  await assert.rejects(readDevelopmentBuild(directory), {code: 'LOCAL_EXTENSION_DESCRIPTOR'});
});

test('runtime coordinates resolve only through the map of the applied build', {timeout: 5000}, async t => {
  const {root, files} = await fixture(t);
  await fs.writeFile(files.api, api);
  const build = async (code, mappings) => {
    const body = JSON.stringify({version: 3, file: 'fixture.js', sources: ['src/extension.ts'], names: [], mappings});
    const bundleSHA256 = sha256(code);
    const sourceMapSHA256 = sha256(body);
    await Promise.all([fs.writeFile(files.bundle, code), fs.writeFile(files.map, body)]);
    const marker = files.marker + '.tmp';
    await fs.writeFile(marker, JSON.stringify({formatVersion: 1, id,
      bundle: {file: 'fixture.js', sha256: bundleSHA256},
      api: {file: 'extension-manifest.json', sha256: sha256(api)},
      sourceMap: {file: 'fixture.js.map', sha256: sourceMapSHA256}}));
    await fs.rename(marker, files.marker);
    return [bundleSHA256, sourceMapSHA256];
  };
  const first = await build('first', 'AAEC');
  const contents = new EventEmitter();
  contents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  contents.send = (...args) => contents.emit(...args);
  const handlers = new Map();
  installLocalExtensionDevelopment({on() {}, handle: (name, handler) => handlers.set(name, handler)}, contents,
    {chooseDirectory: async () => root, confirm: async () => true, intervalMs: 20});
  t.after(() => contents.emit('destroyed'));
  const event = {sender: contents, senderFrame: contents.mainFrame};
  const invoke = (name, ...args) => handlers.get('local-extension-' + name)(event, ...args);
  const {session} = await invoke('start');
  const retain = (...args) => invoke('retain-diagnostics', session, ...args);
  const resolve = (...args) => invoke('resolve-diagnostic', session, ...args);
  assert.equal(retain(...first, true), false);
  assert.equal(retain(...first, false), true);
  assert.equal(retain(...first, true), true);
  assert.deepEqual(resolve(...first, 1, 1), {file: 'src/extension.ts', line: 3, column: 2});
  const update = once(contents, 'local-extension-build');
  const second = await build('second', 'AAGC');
  await update;
  assert.equal(retain(...second, false), true);
  assert.equal(resolve(...second, 1, 1), null);
  assert.equal(resolve(first[0], second[1], 1, 1), null);
  assert.equal(resolve(...first, 2, 1), null);
  assert.equal(resolve(...first, '1', 1), null);
  assert.deepEqual(resolve(...first, 1, 1), {file: 'src/extension.ts', line: 3, column: 2});
  assert.equal(retain(...second, true), true);
  assert.equal(resolve(...first, 1, 1), null);
  assert.deepEqual(resolve(...second, 1, 1), {file: 'src/extension.ts', line: 4, column: 2});
  invoke('stop', session);
  assert.equal(resolve(...second, 1, 1), null);
});

test('retries an atomic artifact replacement after opening its previous inode', async t => {
  const {files, publish} = await fixture(t);
  await publish('first');
  const bundle = await fs.realpath(files.bundle);
  const next = bundle + '.tmp';
  await fs.writeFile(next, 'second');
  const open = fs.open.bind(fs);
  const swap = t.mock.method(fs, 'open', async (name, ...args) => {
    const handle = await open(name, ...args);
    await fs.rename(next, name);
    return handle;
  });
  await assert.rejects(readDevelopmentFile(bundle, 1024), {code: 'LOCAL_EXTENSION_INCOMPLETE'});
  swap.mock.restore();
  assert.equal((await readDevelopmentFile(bundle, 1024)).toString(), 'second');
});

test('watching requires the current Editor frame and grants only the active session and compatible generation',
  {timeout: 5000}, async t => {
    const {root, files, publish} = await fixture(t);
    await publish('first');
    const webContents = new EventEmitter();
    webContents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
    webContents.send = (name, value) => webContents.emit(name, value);
    const handlers = new Map();
    let confirmed = 0;
    installLocalExtensionDevelopment({on() {}, handle: (name, handler) => handlers.set(name, handler)}, webContents,
      {chooseDirectory: async () => root, confirm: async () => { confirmed++; return true; }, intervalMs: 20});
    t.after(() => webContents.emit('destroyed'));
    const event = {sender: webContents, senderFrame: webContents.mainFrame};
    const invoke = (name, ...args) => handlers.get('local-extension-' + name)(event, ...args);
    assert.throws(() => handlers.get('local-extension-start')({...event, senderFrame: {...event.senderFrame}}),
      {code: 'LOCAL_EXTENSION_UNAVAILABLE'});
    assert.throws(() => handlers.get('local-extension-start')({...event, sender: {}}), {code: 'LOCAL_EXTENSION_UNAVAILABLE'});
    const first = await invoke('start');
    assert.equal(confirmed, 1);
    assert.equal(first.id, id);
    assert.equal(first.directory, await fs.realpath(root));
    assert.equal(invoke('authorize', first.session, id, first.sha256), true);
    assert.equal(invoke('authorize', first.session, 'other', first.sha256), false);
    const updates = [];
    webContents.on('local-extension-build', build => updates.push(build));
    const unavailable = once(webContents, 'local-extension-artifacts');
    await fs.writeFile(files.bundle, 'partial');
    assert.deepEqual(await unavailable, [{session: first.session, waiting: true}]);
    assert.equal(updates.length, 0);
    assert.equal(invoke('authorize', first.session, id, first.sha256), true);
    const available = once(webContents, 'local-extension-artifacts');
    const update = once(webContents, 'local-extension-build');
    await publish('second');
    const [second] = await update;
    assert.deepEqual(await available, [{session: first.session, waiting: false}]);
    assert.equal(second.session, first.session);
    assert.equal(Object.hasOwn(second, 'directory'), false);
    assert.equal(invoke('authorize', first.session, id, first.sha256), false);
    assert.equal(invoke('authorize', first.session, id, second.sha256), true);
    await publish('second');
    await delay(80);
    assert.equal(updates.length, 1);
    const stopped = once(webContents, 'local-extension-stopped');
    await publish('third', JSON.stringify({...JSON.parse(api), blocks: [{opcode: 'different'}]}));
    assert.deepEqual(await stopped, [{session: first.session, code: 'LOCAL_EXTENSION_INCOMPATIBLE'}]);
    assert.equal(invoke('authorize', first.session, id, second.sha256), false);
    assert.equal(confirmed, 1);
  });

test('different extension folders can update and stop independently in the same window',
  {timeout: 5000}, async t => {
    const first = await fixture(t);
    const second = await fixture(t, 'secondfixture');
    const sameId = await fixture(t);
    await Promise.all([first.publish('first'), second.publish('second'), sameId.publish('duplicate')]);
    const selected = [first.root, second.root, first.root, sameId.root];
    const webContents = new EventEmitter();
    webContents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
    webContents.send = (name, value) => webContents.emit(name, value);
    const handlers = new Map();
    let confirmed = 0;
    installLocalExtensionDevelopment({on() {}, handle: (name, handler) => handlers.set(name, handler)}, webContents,
      {chooseDirectory: async () => selected.shift(), confirm: async () => { confirmed++; return true; }, intervalMs: 20});
    t.after(() => webContents.emit('destroyed'));
    const event = {sender: webContents, senderFrame: webContents.mainFrame};
    const invoke = (name, ...args) => handlers.get('local-extension-' + name)(event, ...args);
    const a = await invoke('start');
    const b = await invoke('start');
    assert.notEqual(a.session, b.session);
    assert.equal(a.directory, await fs.realpath(first.root));
    assert.equal(b.directory, await fs.realpath(second.root));
    await assert.rejects(invoke('start'), {code: 'LOCAL_EXTENSION_ALREADY_WATCHING'});
    await assert.rejects(invoke('start'), {code: 'LOCAL_EXTENSION_ALREADY_WATCHING'});
    assert.equal(confirmed, 2);
    assert.equal(invoke('authorize', a.session, b.id, b.sha256), false);
    assert.equal(invoke('authorize', a.session, a.id, a.sha256), true);
    assert.equal(invoke('authorize', b.session, b.id, b.sha256), true);

    await invoke('set-enabled', a.session, false);
    const updates = [];
    webContents.on('local-extension-build', value => updates.push(value));
    const update = once(webContents, 'local-extension-build');
    await Promise.all([first.publish('first-updated'), second.publish('second-updated')]);
    const [next] = await update;
    assert.equal(next.session, b.session);
    await delay(80);
    assert.equal(updates.length, 1);
    assert.equal(invoke('authorize', a.session, a.id, a.sha256), false);
    assert.equal(invoke('authorize', b.session, b.id, next.sha256), true);
    const resumed = await invoke('set-enabled', a.session, true);
    assert.equal(resumed.sha256, sha256('first-updated'));
    assert.equal(invoke('authorize', a.session, a.id, resumed.sha256), true);
    assert.equal(confirmed, 2);
    invoke('stop', a.session);
    assert.equal(invoke('authorize', b.session, b.id, next.sha256), true);
    invoke('stop');
    assert.equal(invoke('authorize', b.session, b.id, next.sha256), false);
  });

test('source consent precedes compilation and cancelling an addition revokes it', {timeout: 5000}, async t => {
  const {root, publish, files} = await fixture(t);
  await publish('first');
  const compiled = new Map(await Promise.all([
    ['fixture.js', files.bundle], ['extension-manifest.json', files.api], ['extension-development.json', files.marker]
  ].map(async ([name, filename]) => [name, await fs.readFile(filename)])));
  const contents = new EventEmitter();
  contents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  contents.send = (...args) => contents.emit(...args);
  const handlers = new Map();
  let approval = false;
  let waitForCancel = false;
  installLocalExtensionDevelopment({on() {}, handle: (name, handler) => handlers.set(name, handler)}, contents, {
    chooseDirectory: async () => root,
    confirm: async (_root, extensionId, mode) => {
      assert.equal(extensionId, id);
      assert.equal(mode, 'source');
      return approval;
    },
    sourceBuilder: {
      read: async () => ({id, digest: 'first'}),
      build: async (_snapshot, signal) => {
        assert.ok(approval);
        if (waitForCancel) {
          contents.emit('build-started');
          await once(signal, 'abort');
          assert.ok(signal.aborted);
        }
        return compiled;
      }
    }
  });
  t.after(() => contents.emit('destroyed'));
  const event = {sender: contents, senderFrame: contents.mainFrame};
  const invoke = (name, ...args) => handlers.get('local-extension-' + name)(event, ...args);
  assert.equal(await invoke('start', 'source'), null);
  approval = true;
  waitForCancel = true;
  const started = once(contents, 'build-started');
  const cancelled = invoke('start', 'source');
  await started;
  invoke('cancel-start');
  assert.equal(await cancelled, null);
  waitForCancel = false;
  const result = await invoke('start', 'source');
  assert.equal(invoke('authorize', result.session, result.id, result.sha256), true);
  await invoke('set-enabled', result.session, false);
  assert.equal(invoke('authorize', result.session, result.id, result.sha256), false);
});

test('source mode never publishes a successful but superseded build', {timeout: 5000}, async t => {
  const {readSourceSnapshot} = require('../src-main/standard-extension-source-build');
  const root = await fs.mkdtemp(path.join(tmpdir(), 'tw-extension-source-generation-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'src'));
  const sourceFile = path.join(root, 'src/index.ts');
  const writeSource = label => fs.writeFile(sourceFile, `export const value = '${label}';`);
  await Promise.all([
    fs.writeFile(path.join(root, 'extension-build.json'), JSON.stringify({settings: 'src/settings.json'})),
    fs.writeFile(path.join(root, 'package.json'), '{}'),
    fs.writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'"),
    fs.writeFile(path.join(root, 'src/settings.json'), JSON.stringify({id, unsandboxed: false})),
    writeSource('first')
  ]);

  const contents = new EventEmitter();
  contents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  contents.send = (...args) => contents.emit(...args);
  const handlers = new Map();
  const updates = [];
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => {
    clearInterval(keepAlive);
    contents.emit('destroyed');
  });
  let approvalCount = 0;
  let blockedLabel;
  let release;
  const bundle = label => `fixture output for ${label}`;
  installLocalExtensionDevelopment({on() {}, handle: (name, handler) => handlers.set(name, handler)}, contents, {
    chooseDirectory: async () => root,
    confirm: async () => { approvalCount++; return true; },
    sourceBuilder: {
      read: readSourceSnapshot,
      build: async ({files}) => {
        // No extension code executes in this fixture. The mock returns valid, hash-linked output.
        const label = /'([^']+)'/u.exec(files.get('src/index.ts').toString())[1];
        if (label === blockedLabel) {
          await new Promise(resolve => {
            release = resolve;
            contents.emit('compiler-blocked');
          });
        }
        return new Map([
          ['fixture.js', Buffer.from(bundle(label))],
          ['extension-manifest.json', Buffer.from(api)],
          ['extension-development.json', Buffer.from(JSON.stringify({
            formatVersion: 1, id,
            bundle: {file: 'fixture.js', sha256: sha256(bundle(label))},
            api: {file: 'extension-manifest.json', sha256: sha256(api)}
          }))]
        ]);
      }
    },
    intervalMs: 15
  });
  contents.on('local-extension-build', build => updates.push(build.sha256));
  const event = {sender: contents, senderFrame: contents.mainFrame};
  const invoke = (name, ...args) => handlers.get('local-extension-' + name)(event, ...args);

  // Initial add must not create a lease for a build superseded while compilation ran.
  blockedLabel = 'first';
  const firstCompile = once(contents, 'compiler-blocked');
  const initial = invoke('start', 'source');
  await firstCompile;
  await writeSource('second');
  release();
  await assert.rejects(initial, {code: 'LOCAL_EXTENSION_SOURCE_CHANGED'});
  const current = await invoke('start', 'source');
  assert.equal(current.sha256, sha256(bundle('second')));
  const authorize = (label) => invoke('authorize', current.session, id, sha256(bundle(label)));

  // In an existing lease, the old working hash remains authorized until a fresh build is ready.
  blockedLabel = 'third';
  const thirdCompile = once(contents, 'compiler-blocked');
  await writeSource('third');
  await thirdCompile;
  await writeSource('fourth');
  blockedLabel = 'fourth';
  const fourthCompile = once(contents, 'compiler-blocked');
  release();
  await fourthCompile;
  assert.deepEqual(updates, []);
  assert.equal(authorize('third'), false);
  assert.equal(authorize('second'), true);
  const updated = once(contents, 'local-extension-build');
  release();
  const [next] = await updated;
  assert.equal(next.session, current.session);
  assert.deepEqual(updates, [sha256(bundle('fourth'))]);
  assert.equal(authorize('fourth'), true);
  assert.equal(authorize('second'), false);
  assert.equal(approvalCount, 2);
});
