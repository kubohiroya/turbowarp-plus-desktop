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
    await fs.writeFile(files.bundle, 'partial');
    await delay(80);
    assert.equal(updates.length, 0);
    const update = once(webContents, 'local-extension-build');
    await publish('second');
    const [second] = await update;
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
