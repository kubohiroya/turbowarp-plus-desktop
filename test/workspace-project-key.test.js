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
  assert.equal(store.write(first, '{"version":1}'), true);
  assert.equal(store.write(second, '{"version":1,"project":"B"}'), true);
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
  assert.equal((await fs.readdir(directory)).length, 100);
});
