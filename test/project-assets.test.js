const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ProjectAssets} = require('../src-main/project-assets');

async function fixture (t, options) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-project-assets-'));
  t.after(() => fs.rm(work, {recursive: true, force: true}));
  const root = path.join(work, 'vault');
  return {vault: new ProjectAssets(root, options), root, work};
}

test('keeps exact binary data apart from the reference, including across broker restart', async t => {
  const {vault, root} = await fixture(t);
  const data = Buffer.from([0, 1, 255, 0, 40]);
  const owner = Symbol();
  for (const kind of ['costume', 'sound']) {
    const {transferId, assets: [asset]} = await vault.stage(owner, kind, data);
    assert.deepEqual(asset, {id: 'asset', kind, size: data.length,
      sha256: createHash('sha256').update(data).digest('hex')});
    const file = path.join(root, transferId + '.' + kind);
    assert.deepEqual(await fs.readFile(file), data);
    const restarted = new ProjectAssets(root);
    await restarted.sweep();
    assert.deepEqual(await restarted.read(transferId, asset), data);
    assert.deepEqual(await restarted.read(transferId, asset), data);
    assert.equal(await vault.discard(Symbol(), transferId), false);
    assert.equal(await vault.discard(owner, transferId), true);
    await assert.rejects(vault.read(transferId, asset), /missing/);
  }
});

test('rejects tampering, unowned paths and expiration, and sweeps interrupted writes', async t => {
  let now = Date.now();
  const {vault, root, work} = await fixture(t, {now: () => now, ttl: 5000});
  const owner = Symbol();
  const {transferId, assets: [asset]} = await vault.stage(owner, 'costume', Buffer.from([1, 2]));
  const file = path.join(root, transferId + '.costume');
  await assert.rejects(vault.read('../project.sb3', asset), /invalid/);
  await assert.rejects(vault.read(transferId, {...asset, size: 1}), /invalid/);
  await assert.rejects(vault.read(transferId, {...asset, kind: 'sound'}), /missing/);
  await fs.writeFile(file, Buffer.from([1, 3]));
  await assert.rejects(vault.read(transferId, asset), /invalid/);
  if (process.platform !== 'win32') {
    const outside = path.join(work, 'outside');
    await fs.writeFile(outside, Buffer.from([1, 2]));
    await fs.unlink(file);
    await fs.symlink(outside, file);
    await assert.rejects(vault.read(transferId, asset), /invalid/);
    await vault.sweep();
    assert.deepEqual(await fs.readFile(outside), Buffer.from([1, 2]));
  }
  const second = await vault.stage(owner, 'sound', Buffer.from([4]));
  const pending = path.join(root, 'f'.repeat(64) + '.pending');
  await fs.writeFile(pending, 'abandoned');
  now += 10_000;
  await assert.rejects(vault.read(second.transferId, second.assets[0]), /expired/);
  await vault.sweep();
  assert.deepEqual(await fs.readdir(root), []);
});

test('serializes competing writes against the same quota', async t => {
  const {vault, root} = await fixture(t, {capacity: 5});
  const owner = Symbol();
  const first = vault.stage(owner, 'costume', Buffer.from([1, 2, 3]));
  const second = vault.stage(owner, 'sound', Buffer.from([4, 5, 6]));
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /store is full/);
  assert.equal((await fs.readdir(root)).length, 1);
});
