const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {ExternalYamlFiles} = require('../src-main/external-yaml-files');
const {ProjectLocks, identify, assertOwned} = require('../src-main/project-lock');

test('external YAML saves in place and rejects changed or unapproved files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-external-yaml-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'config.yaml');
  await fs.writeFile(file, '\uFEFFname: original\r\n', {mode: 0o640});
  const locks = new ProjectLocks(path.join(root, 'locks'));
  let lease;
  const port = new ExternalYamlFiles({
    reserve: async selected => {
      lease ??= locks.acquire(identify(selected), process.pid);
      return lease;
    },
    release: async token => {
      assert.equal(token, lease.token);
      locks.release(lease);
      lease = undefined;
    },
    verify: assertOwned
  });
  assert.equal(await port.open(async () => null), null);
  await assert.rejects(port.open(async () => path.join(root, 'other.sb3')), /\.yaml or \.yml/);
  const opened = await port.open(async () => file);
  assert.equal(opened.source, '\uFEFFname: original\r\n');
  assert.deepEqual(await port.open(async () => file), opened);
  await assert.rejects(port.save(file, opened.revision, 'injected'), /handle is closed/);
  const saved = await port.save(opened.id, opened.revision, '\uFEFFname: saved\r\n');
  assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFname: saved\r\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  await assert.rejects(port.save(opened.id, opened.revision, 'stale'), /changed on disk/);
  const replacement = path.join(root, 'replacement.yaml');
  await fs.writeFile(replacement, saved.source);
  await fs.rename(replacement, file);
  await assert.rejects(port.save(opened.id, saved.revision, 'replacement'), /changed on disk/);
  assert.equal(await fs.readFile(file, 'utf8'), saved.source);
  await port.close(opened.id);
  assert.equal((await fs.readdir(path.join(root, 'locks'))).length, 0);
});
