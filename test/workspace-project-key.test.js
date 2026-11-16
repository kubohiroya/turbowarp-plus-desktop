const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {workspaceProjectKey, discardWorkspaceLayouts} = require('../src-main/workspace-project-key');
const {createDockviewLayoutStore} = require('../src-main/dockview-layout-store');

test('an SB3 has one key for its canonical path, which does not reveal the path', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-project-key-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'Game.sb3');
  const other = path.join(root, 'Other.sb3');
  await fs.writeFile(file, '');
  await fs.writeFile(other, '');
  await fs.symlink(file, path.join(root, 'Link.sb3'));
  const key = workspaceProjectKey(file);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(workspaceProjectKey(path.join(root, 'Link.sb3')), key);
  assert.equal(workspaceProjectKey(path.join(root, '.', 'Game.sb3')), key);
  assert.notEqual(workspaceProjectKey(other), key);
  assert.equal(key.includes('Game'), false);
});

test('layouts kept as files by earlier versions are removed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-project-key-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'workspace-layouts'));
  await fs.writeFile(path.join(root, 'workspace-layouts', 'a.json'), '{}');
  discardWorkspaceLayouts(root);
  await assert.rejects(fs.stat(path.join(root, 'workspace-layouts')), {code: 'ENOENT'});
  discardWorkspaceLayouts(root);
});

test('the launcher stores one bounded layout per project across restarts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-dockview-layout-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const store = createDockviewLayoutStore(root);
  assert.equal(store.read(first), null);
  assert.throws(() => store.read('../project'), /Invalid workspace key/);
  assert.equal(typeof store.write(first, '{"version":1}'), 'number');
  assert.equal(typeof store.write(second, '{"version":1,"project":"B"}'), 'number');
  assert.equal(store.write(first, 'a'.repeat(256 * 1024 + 1)), false);
  const reopened = createDockviewLayoutStore(root);
  assert.equal(reopened.read(first), '{"version":1}');
  assert.equal(reopened.read(second), '{"version":1,"project":"B"}');
});

test('the launcher retains only the 100 most recently used project layouts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-dockview-layout-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const key = index => index.toString(16).padStart(64, '0');
  const store = createDockviewLayoutStore(root);
  for (let index = 0; index < 100; index++) store.write(key(index), '{}');
  const directory = path.join(root, 'dockview-layouts');
  const old = new Date(0);
  await fs.utimes(path.join(directory, key(0) + '.json'), old, old);
  await fs.utimes(path.join(directory, key(1) + '.json'), old, old);
  assert.equal(store.read(key(0)), '{}');
  store.write(key(100), '{}');
  assert.equal(store.read(key(0)), '{}');
  assert.equal(store.read(key(1)), null);
  const files = await fs.readdir(directory);
  assert.equal(files.filter(file => file.endsWith('.json')).length, 100);
  assert.equal(files.filter(file => file.endsWith('.saved-at')).length, 100);
  assert.equal(files.includes(key(1) + '.saved-at'), false);
});

test('the launcher reports when a layout last changed, not when it was opened', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-dockview-layout-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const key = 'c'.repeat(64);
  const store = createDockviewLayoutStore(root);
  assert.equal(store.readRecord(key), null);
  assert.equal(store.write(key, '{"version":1}', 1000), 1000);
  assert.deepEqual(store.readRecord(key), {layout: '{"version":1}', savedAt: 1000});
  // An unchanged layout keeps its time.
  assert.equal(store.write(key, '{"version":1}', 2000), 1000);
  assert.deepEqual(createDockviewLayoutStore(root).readRecord(key), {layout: '{"version":1}', savedAt: 1000});
  assert.equal(store.write(key, '{"version":2}', 3000), 3000);
  assert.deepEqual(store.readRecord(key), {layout: '{"version":2}', savedAt: 3000});
  assert.equal(store.write(key, 'a'.repeat(256 * 1024 + 1), 4000), false);
  assert.deepEqual(store.readRecord(key), {layout: '{"version":2}', savedAt: 3000});
});

test('a layout saved by an earlier version has no time until it changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-dockview-layout-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const key = 'd'.repeat(64);
  const directory = path.join(root, 'dockview-layouts');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, key + '.json'), '{"version":1}');
  const store = createDockviewLayoutStore(root);
  assert.deepEqual(store.readRecord(key), {layout: '{"version":1}'});
  assert.equal(store.write(key, '{"version":1}', 1000), true);
  assert.deepEqual(store.readRecord(key), {layout: '{"version":1}'});
  await fs.writeFile(path.join(directory, key + '.saved-at'), 'not a time');
  assert.deepEqual(store.readRecord(key), {layout: '{"version":1}'});
  assert.equal(store.write(key, '{"version":2}', 2000), 2000);
  assert.deepEqual(store.readRecord(key), {layout: '{"version":2}', savedAt: 2000});
});
