const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {workspaceProjectKey, discardWorkspaceLayouts} = require('../src-main/workspace-project-key');

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
