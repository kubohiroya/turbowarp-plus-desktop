const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {transformSync} = require('@babel/core');

const renderer = path.resolve(__dirname, '../src-renderer-webpack/editor/gui');
const feedback = () => import('../src-renderer-webpack/editor/gui/source-build-feedback.mjs');
const load = (name, imports) => {
  const filename = path.join(renderer, name);
  const {code} = transformSync(readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    presets: [[require.resolve('@babel/preset-env'), {targets: {node: 'current'}, modules: 'commonjs'}],
      require.resolve('@babel/preset-react')]
  });
  const module = {exports: {}};
  new Function('require', 'module', 'exports', code)(name => {
    if (!Object.hasOwn(imports, name)) throw new Error('Unexpected renderer dependency: ' + name);
    return imports[name];
  }, module, module.exports);
  return module.exports;
};
const flush = () => new Promise(resolve => setImmediate(resolve));

test('build feedback keeps only bounded coordinates and measured values', async () => {
  const {sourceBuildDiagnostics, sourceBuildMeasurements, formatBuildBytes} = await feedback();
  const safe = {code: 'PARSE_ERROR', file: 'src/日本語.ts', line: 2, column: 4};
  assert.deepEqual(sourceBuildDiagnostics([{...safe, message: 'private', frame: 'source'},
    {...safe, file: '/home/private.ts'}, {...safe, file: 'src/../private.ts'},
    {...safe, line: Infinity}, {...safe, column: 10000000}, {...safe, code: '<script>'}]), [safe]);
  assert.equal(sourceBuildDiagnostics(Array(40).fill(safe)).length, 16);
  assert.deepEqual(sourceBuildMeasurements({inputBytes: 100, outputBytes: -1, payloadBytes: 200,
    additionalRuntimeDownloadBytes: 0, elapsedMs: NaN, privatePath: '/private/source'}),
  {inputBytes: 100, payloadBytes: 200, additionalRuntimeDownloadBytes: 0});
  assert.equal(sourceBuildMeasurements({outputBytes: Infinity}), undefined);
  assert.deepEqual([0, 1024, 1024 * 1024].map(formatBuildBytes), ['0 B', '1.0 KiB', '1.0 MiB']);
});

test('renderer preserves the last applied measurements through failure and updates unchanged output without reapplying', async () => {
  const listeners = {};
  const events = new Map();
  const updates = [];
  const applied = [];
  const initial = {session: 'lease', id: 'fixture', sha256: 'first', directory: '/chosen', mode: 'source',
    bytes: Buffer.from('// fixture'), measurements: {inputBytes: 100, payloadBytes: 200}};
  let failApply = false;
  let applyGate;
  const authoring = {
    inspect: async () => ({extensions: []}),
    onProjectReplacement: callback => { events.set('replacement', callback); return () => {}; },
    onDispose: () => () => {},
    applyDevelopmentBuild: async (build, authorize) => {
      if (applyGate) await applyGate;
      if (failApply) throw new Error('fixture transaction failed');
      assert.equal(await authorize(build), true);
      applied.push(build.sha256);
    }
  };
  const host = {
    start: async () => initial, authorize: async () => true, stop: async () => {},
    setEnabled: async (_session, enabled) => enabled ? initial : null,
    ...Object.fromEntries(['Build', 'Artifacts', 'Stopped'].map(name => ['on' + name, callback => {
      listeners[name] = callback;
      return () => {};
    }]))
  };
  const {connectLocalExtensionDevelopment} = load('local-extension-development.js', {
    './local-extension-authoring.js': {getExtensionAuthoringHost: () => authoring},
    './source-build-feedback.mjs': await feedback()
  });
  const connection = connectLocalExtensionDevelopment({extensionManager: {}}, host,
    code => assert.fail(code), sessions => updates.push(sessions));
  await connection.start('source');
  await flush();
  const current = () => updates.at(-1)[0];
  assert.deepEqual(current().measurements, initial.measurements);
  const diagnostics = [{code: 'PARSE_ERROR', file: 'src/index.ts', line: 2, column: 4, message: 'private'}];
  listeners.Artifacts({session: 'lease', code: 'LOCAL_EXTENSION_SOURCE_FAILED', diagnostics});
  assert.deepEqual(current().buildDiagnostics, [{code: 'PARSE_ERROR', file: 'src/index.ts', line: 2, column: 4}]);
  assert.deepEqual(current().measurements, initial.measurements);
  listeners.Artifacts({session: 'lease', code: 'LOCAL_EXTENSION_SOURCE_FAILED', diagnostics: [{...diagnostics[0], line: 3}]});
  assert.equal(current().buildDiagnostics[0].line, 3);
  listeners.Artifacts({session: 'lease', waiting: false});
  listeners.Build({...initial, measurements: {inputBytes: 110, payloadBytes: 200, privatePath: 'private'}});
  await flush();
  assert.deepEqual(applied, ['first']);
  assert.deepEqual(current().buildDiagnostics, []);
  assert.deepEqual(current().measurements, {inputBytes: 110, payloadBytes: 200});
  failApply = true;
  listeners.Build({...initial, sha256: 'second', measurements: {inputBytes: 500}});
  await flush();
  assert.equal(current().appliedDigest, 'first');
  assert.deepEqual(current().measurements, {inputBytes: 110, payloadBytes: 200});
  failApply = false;
  let release;
  applyGate = new Promise(resolve => { release = resolve; });
  listeners.Build({...initial, sha256: 'third', measurements: {inputBytes: 700}});
  await flush();
  listeners.Artifacts({session: 'lease', code: 'LOCAL_EXTENSION_SOURCE_FAILED', diagnostics});
  await connection.setEnabled('lease', false);
  release();
  await flush();
  assert.deepEqual(current().buildDiagnostics, []);
  assert.deepEqual(current().measurements, {inputBytes: 110, payloadBytes: 200});
  assert.equal(current().appliedDigest, 'first');
  connection.dispose();
});

test('development dialog renders shared capacity and safe compile coordinates separately from runtime errors', async () => {
  const React = require('react');
  const {renderToStaticMarkup} = require('react-dom/server');
  const {LocalExtensionDevelopmentDialog} = load('local-extension-development-dialog.jsx', {
    react: React,
    'scratch-gui/src/components/modal/modal.jsx': ({children}) => React.createElement('section', null, children),
    '@kubohiroya/turbowarp-extension-security-dialog': {parseExtensionMetadata: () => ({name: 'fixture'})},
    '@kubohiroya/turbowarp-extension-security-dialog/react': {
      ExtensionRow: ({details, children}) => React.createElement('li', null, details, children)
    },
    '@kubohiroya/turbowarp-extension-security-dialog/project-review.css': {},
    './desktop-settings-menu.css': {},
    './source-build-feedback.mjs': await feedback()
  });
  for (const locale of ['ja', 'en']) {
    const markup = renderToStaticMarkup(React.createElement(LocalExtensionDevelopmentDialog, {
      locale, errorText: code => code,
      sessions: [{token: 'lease', id: 'fixture', sourceHeader: '', mode: 'source', directory: '/chosen',
        buildError: 'LOCAL_EXTENSION_SOURCE_FAILED',
        buildDiagnostics: [{code: 'PARSE_ERROR', file: 'src/index.ts', line: 2, column: 4}],
        diagnostic: {file: 'src/runtime.ts', line: 5, column: 6},
        measurements: {payloadBytes: 2 * 1024 * 1024, additionalRuntimeDownloadBytes: 0, elapsedMs: 100}}]
    }));
    for (const text of ['src/index.ts:2:4 (PARSE_ERROR)', 'src/runtime.ts:5:6', '2.0 MiB', '0 B', '100 ms']) {
      assert.ok(markup.includes(text), text);
    }
    assert.ok(markup.includes(locale === 'ja' ? '前回の正常ビルド' : 'Last successful build'));
    assert.ok(markup.includes(locale === 'ja' ? '拡張間で共有' : 'shared across extensions'));
  }
});
