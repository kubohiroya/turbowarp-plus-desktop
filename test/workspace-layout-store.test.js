const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {readWorkspaceLayout, writeWorkspaceLayout} = require('../src-main/workspace-layout-store');

test('workspace layout storage is isolated by canonical project identity', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-layout-storage-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  assert.equal(readWorkspaceLayout(root, '/project/A.sb3'), null);
  writeWorkspaceLayout(root, '/project/A.sb3', '{"layout":"horizontal"}');
  writeWorkspaceLayout(root, '/project/B.sb3', '{"layout":"vertical"}');
  writeWorkspaceLayout(root, '/project/A.sb3', 'x'.repeat(1024 * 1024 + 1));
  assert.equal(readWorkspaceLayout(root, '/project/A.sb3'), '{"layout":"horizontal"}');
  writeWorkspaceLayout(root, '/project/A.sb3', '{"layout":"updated"}');
  assert.equal(readWorkspaceLayout(root, '/project/A.sb3'), '{"layout":"updated"}');
  assert.equal(readWorkspaceLayout(root, '/project/B.sb3'), '{"layout":"vertical"}');
  assert.equal((await fs.readdir(path.join(root, 'workspace-layouts'))).length, 2);
});
