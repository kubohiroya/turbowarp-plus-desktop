const assert = require('node:assert/strict');
const {test} = require('node:test');
const {runInNewContext} = require('node:vm');

test('Packager can bake an extension ending in a line comment without a final newline', async () => {
  const {patchPackagerPreview} = await import('../scripts/patch-packager-preview.mjs');
  const upstream = [
    'frame.src = URL.createObjectURL(e.data.blob);',
    'const bake = async (Z, n) => `(function(Scratch) { ${await Z.fetchExtensionScript(n)} })(Scratch);`;'
  ].join('\n');
  const patchedBake = patchPackagerPreview(upstream).split('\n').at(-1);
  const bake = runInNewContext(patchedBake + '\nbake;');
  const extension = 'Scratch.register(); // source ends here';
  const script = await bake({fetchExtensionScript: async () => extension}, 'https://example.test/extension.js');
  let registrations = 0;
  runInNewContext(script, {Scratch: {register: () => { registrations++; }}});
  assert.equal(registrations, 1);
});
