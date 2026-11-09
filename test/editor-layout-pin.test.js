const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const name = '@kubohiroya/turbowarp-plus-editor-layout';
const version = '0.1.26';
const integrity = 'sha512-7/1D4zROxXKXwsXmmqnTvOdwUqxbwNXy5Ahl9VsElhytqTlq/0O1lrfbANHd8I2i0aH5lPn+VhTNyRrwOp208A==';
const resolved = `https://registry.npmjs.org/${name}/-/turbowarp-plus-editor-layout-${version}.tgz`;
const pin = () => ({
  manifest: {devDependencies: {[name]: version}},
  lock: {packages: {
    '': {devDependencies: {[name]: version}},
    [`node_modules/${name}`]: {version, resolved, integrity, dev: true}
  }}
});
const load = () => import('../scripts/editor-layout-pin.mjs');

test('the Editor Layout pin resolves to its exact npm release and integrity', async () => {
  const {resolveEditorLayout} = await load();
  assert.deepEqual(resolveEditorLayout(pin()), {package: name, version, resolved, integrity});
});

test('a Layout pin that is not exact, consistent and integrity-checked is rejected', async () => {
  const {resolveEditorLayout} = await load();
  const cases = [
    [value => { delete value.manifest.devDependencies[name]; }, /does not depend/],
    [value => { value.manifest.devDependencies[name] = '^0.1.26'; value.lock.packages[''].devDependencies[name] = '^0.1.26'; }, /exact npm Layout version/],
    [value => { value.lock.packages[''].devDependencies[name] = '0.1.25'; }, /root lock differs/],
    [value => { delete value.lock.packages[`node_modules/${name}`].integrity; }, /SHA-512 integrity/],
    [value => { value.lock.packages[`node_modules/${name}`].integrity = 'sha1-abc='; }, /SHA-512 integrity/],
    [value => { value.lock.packages[`node_modules/${name}`].resolved = resolved.replace(version, '0.1.25'); }, /published npm tarball/]
  ];
  for (const [change, message] of cases) {
    const value = pin();
    change(value);
    assert.throws(() => resolveEditorLayout(value), message);
  }
});

test('the installed Layout must be the version the Editor lockfile pins', async t => {
  const {verifyEditorLayout} = await load();
  const editor = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-layout-pin-'));
  t.after(() => fs.rm(editor, {recursive: true, force: true}));
  const {manifest, lock} = pin();
  await fs.writeFile(path.join(editor, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(editor, 'package-lock.json'), JSON.stringify(lock));
  const installed = path.join(editor, 'node_modules', name);
  await fs.mkdir(path.join(installed, 'dist'), {recursive: true});
  await fs.writeFile(path.join(installed, 'dist/index.js'), '');
  const writeInstalled = installedVersion => fs.writeFile(path.join(installed, 'package.json'), JSON.stringify({
    name, version: installedVersion, exports: {'.': './dist/index.js'}
  }));
  await writeInstalled(version);
  assert.deepEqual(await verifyEditorLayout(editor), {package: name, version, resolved, integrity});
  await writeInstalled('0.1.25');
  await assert.rejects(verifyEditorLayout(editor), /Installed Layout differs/);
});
