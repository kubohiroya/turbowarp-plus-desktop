const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {EventEmitter, once} = require('node:events');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {test} = require('node:test');
const {installLocalExtensionDevelopment, openDirectory, readDevelopmentBuild} = require('../src-main/local-extension-development');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const id = 'fixture';
const api = JSON.stringify({formatVersion: 1, id, blocks: [], menus: []});

async function fixture (t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'tw-extension-watcher-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const dist = path.join(root, 'dist');
  await fs.mkdir(dist);
  const files = {
    bundle: path.join(dist, 'fixture.js'),
    api: path.join(dist, 'extension-manifest.json'),
    marker: path.join(dist, 'extension-development.json')
  };
  const publish = async (bundle, manifest = api) => {
    await fs.writeFile(files.bundle, bundle);
    await fs.writeFile(files.api, manifest);
    await fs.writeFile(`${files.marker}.tmp`, JSON.stringify({formatVersion: 1, id,
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
    assert.equal(Object.hasOwn(first, 'root'), false);
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
