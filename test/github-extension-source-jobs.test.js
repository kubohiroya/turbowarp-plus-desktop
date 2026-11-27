const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {setTimeout: delay} = require('node:timers/promises');
const {test} = require('node:test');
const {installGitHubExtensionSourceJobs} = require('../src-main/github-extension-source-jobs');

const commit = 'a'.repeat(40);
const repository = 'outside-editor/fixture';
const origin = {kind: 'github', repository, commit};
const unavailable = {code: 'GITHUB_EXTENSION_SOURCE_UNAVAILABLE'};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = () => ({source: origin, measurements: {downloadBytes: 500, token: 'private'}, files: new Map([
  ['extension-build.json', Buffer.from(JSON.stringify({settings: 'src/settings.json'}))],
  ['package.json', Buffer.from('{"scripts":{"prepare":"DO NOT EXECUTE"}}')],
  ['pnpm-lock.yaml', Buffer.from('locked')],
  ['src/settings.json', Buffer.from('{"id":"fixture","unsandboxed":false}')],
  ['src/index.ts', Buffer.from('Scratch.extensions.register({});')]
])});

test('the GitHub source capability stays off until explicitly enabled at startup', () => {
  for (const value of ['', '0', '1']) {
    const enabled = execFileSync(process.execPath, ['-e',
      'process.stdout.write(String(require("./config/feature-flags").githubExtensionSourceBuild))'],
    {cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8',
      env: {...process.env, TW_PLUS_DESKTOP_RENDERER: '1', TW_PLUS_DESKTOP_EXTENSION_SOURCE_BUILD: '1',
        TW_PLUS_DESKTOP_GITHUB_EXTENSION_SOURCE_BUILD: value}});
    assert.equal(enabled, String(value === '1'));
  }
});
const output = () => {
  const files = new Map([
    ['fixture.js', Buffer.from('Scratch.extensions.register({});')],
    ['fixture.js.map', Buffer.from(JSON.stringify({version: 3, sources: ['src/index.ts'], names: [], mappings: ''}))],
    ['extension-manifest.json', Buffer.from('{"formatVersion":1,"id":"fixture","blocks":[],"menus":[]}')]
  ]);
  files.set('extension-development.json', Buffer.from(JSON.stringify({formatVersion: 1, id: 'fixture',
    bundle: {file: 'fixture.js', sha256: sha(files.get('fixture.js'))},
    api: {file: 'extension-manifest.json', sha256: sha(files.get('extension-manifest.json'))},
    sourceMap: {file: 'fixture.js.map', sha256: sha(files.get('fixture.js.map'))}})));
  return {files, receipt: {source: origin}, measurements: {payloadBytes: 2000, outputBytes: 100, privatePath: '/private/compiler'}};
};
function setup (t, builder, options = {}) {
  const contents = new EventEmitter();
  contents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  const handlers = new Map();
  const events = new Map();
  const event = {sender: contents, senderFrame: contents.mainFrame};
  installGitHubExtensionSourceJobs({handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => events.set(name, fn)},
    contents, {enabled: true, builder, ...options});
  t.after(() => contents.emit('destroyed'));
  const invoke = (name, ...args) => handlers.get('github-extension-source-' + name)(event, ...args);
  return {contents, handlers, events, event, invoke};
}

test('only the fixed Editor top frame can use enabled GitHub capabilities and bounded requests', async t => {
  let fetches = 0;
  const builder = {resolveGitHubSnapshot: async () => { fetches++; return snapshot(); }, buildResult: async () => output()};
  const {contents, handlers, events, event, invoke} = setup(t, builder);
  events.get('github-extension-source-enabled')(event);
  assert.equal(event.returnValue, true);
  for (const impostor of [{...event, sender: {}}, {...event, senderFrame: {...contents.mainFrame}},
    {...event, senderFrame: {url: 'https://github.com/fixture'}}]) {
    assert.throws(() => handlers.get('github-extension-source-prepare')(impostor, {repository}), unavailable);
  }
  for (const request of [{repository, token: 'private'}, {repository, path: '/private'}, {repository, command: 'npm'},
    {repository: 'https://github.com/' + repository}, {repository: '../private'}, {repository, ref: 'bad\nref'},
    {repository, ref: 'x'.repeat(129)}, {repository, expectedCommit: 'tag'}, null]) {
    await assert.rejects(invoke('prepare', request), unavailable);
  }
  assert.equal(fetches, 0);
  for (const options of [{enabled: false}, {builder: null}]) {
    const disabled = setup(t, builder, options);
    disabled.events.get('github-extension-source-enabled')(disabled.event);
    assert.equal(disabled.event.returnValue, false);
    assert.throws(() => disabled.invoke('prepare', {repository}), unavailable);
  }
});

test('prepare pins one immutable snapshot and result does not grant execution trust', async t => {
  const input = snapshot();
  let compiled = 0;
  let privateSnapshot;
  const {invoke} = setup(t, {
    resolveGitHubSnapshot: async (repo, options) => {
      assert.equal(repo, repository);
      assert.equal(options.ref, 'branch/name');
      assert.equal(options.expectedCommit, commit);
      assert.deepEqual(Object.keys(options).sort(), ['expectedCommit', 'ref', 'signal']);
      return input;
    },
    buildResult: async snap => { compiled++; privateSnapshot = snap; return output(); }
  });
  const prepared = await invoke('prepare', {repository, ref: 'branch/name', expectedCommit: commit});
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.source, origin);
  assert.equal(compiled, 0);
  assert.equal('files' in prepared, false);
  assert.throws(() => invoke('result', prepared.job), unavailable);
  assert.throws(() => invoke('status', 'foreign-job'), unavailable);
  input.files.set('src/index.ts', Buffer.from('mutated after prepare'));
  const ready = await invoke('build', prepared.job);
  assert.equal(ready.status, 'ready');
  assert.equal(privateSnapshot.files.get('src/index.ts').toString(), 'Scratch.extensions.register({});');
  const result = invoke('result', prepared.job);
  assert.equal(result.files.length, 4);
  assert.deepEqual(result.receipt.source, origin);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal('authorized' in result, false);
  assert.equal('environment' in result, false);
  assert.equal(compiled, 1);
  await assert.rejects(invoke('build', prepared.job), unavailable);
  invoke('cancel', prepared.job);
  assert.throws(() => invoke('result', prepared.job), unavailable);
});

test('changed commits, unexpected inputs, malformed builds and raw compiler details never become results', async t => {
  for (const mutate of [value => { value.source = {...origin, commit: 'b'.repeat(40)}; },
    value => value.files.set('../private', Buffer.from('private')),
    value => value.files.set('src/huge.ts', Buffer.alloc(1024 * 1024 + 1)),
    value => { value.files.set('src/settings.json', Buffer.from('{"id":"fixture","unsandboxed":true}')); }]) {
    const value = snapshot();
    mutate(value);
    const {invoke} = setup(t, {resolveGitHubSnapshot: async () => value, buildResult: async () => assert.fail('must not compile')});
    const failed = await invoke('prepare', {repository, expectedCommit: commit});
    assert.equal(failed.status, 'failed');
    assert.equal(failed.code, 'GITHUB_EXTENSION_SOURCE_FETCH_FAILED');
    assert.throws(() => invoke('result', failed.job), unavailable);
  }
  const {invoke} = setup(t, {resolveGitHubSnapshot: async () => snapshot(), buildResult: async () => {
    throw Object.assign(new Error('/private/token source snippet'), {diagnostics: [
      {code: 'PARSE_ERROR', file: 'src/index.ts', line: 2, column: 3, frame: 'private'},
      {code: 'PARSE_ERROR', file: '/private/source.ts', line: 2, column: 3}
    ]});
  }});
  const prepared = await invoke('prepare', {repository});
  const failed = await invoke('build', prepared.job);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.diagnostics, [{code: 'PARSE_ERROR', file: 'src/index.ts', line: 2, column: 3}]);
  assert.equal(JSON.stringify(failed).includes('private'), false);
  assert.throws(() => invoke('result', prepared.job), unavailable);
  invoke('cancel');
  const malformed = setup(t, {resolveGitHubSnapshot: async () => snapshot(), buildResult: async () => {
    const result = output();
    result.files.set('fixture.js', Buffer.from('wrong bytes'));
    return result;
  }});
  const pending = await malformed.invoke('prepare', {repository});
  assert.equal((await malformed.invoke('build', pending.job)).status, 'failed');
});

test('cancelling fetch or build releases the lease and stale work cannot replace a new job', async t => {
  for (const phase of ['fetch', 'build']) {
    let release;
    let started;
    const wait = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let first = true;
    const run = async (value, signal) => {
      if (first) { first = false; started(signal); await gate; }
      return value;
    };
    const {invoke} = setup(t, {
      resolveGitHubSnapshot: async (_repo, {signal}) => phase === 'fetch' ? run(snapshot(), signal) : snapshot(),
      buildResult: async (_snapshot, signal) => run(output(), signal)
    });
    const operation = phase === 'fetch' ? invoke('prepare', {repository}) :
      invoke('build', (await invoke('prepare', {repository})).job);
    const signal = await wait;
    const rejected = assert.rejects(operation, {code: 'GITHUB_EXTENSION_SOURCE_CANCELLED'});
    const cancellation = invoke('cancel');
    assert.equal(signal.aborted, true);
    const newer = await invoke('prepare', {repository});
    release();
    await rejected;
    assert.equal(await cancellation, true);
    assert.equal(invoke('status', newer.job).status, 'prepared');
    invoke('cancel');
  }
});

test('global capacity, navigation, renderer death and expiry bound retained jobs', async t => {
  const builder = {resolveGitHubSnapshot: async () => snapshot(), buildResult: async () => output()};
  const first = setup(t, builder);
  const second = setup(t, builder);
  const third = setup(t, builder);
  await first.invoke('prepare', {repository});
  await second.invoke('prepare', {repository});
  await assert.rejects(third.invoke('prepare', {repository}), {code: 'GITHUB_EXTENSION_SOURCE_BUSY'});
  first.contents.emit('did-start-navigation', {isMainFrame: false});
  await assert.rejects(third.invoke('prepare', {repository}), {code: 'GITHUB_EXTENSION_SOURCE_BUSY'});
  first.contents.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false});
  const next = await third.invoke('prepare', {repository});
  second.contents.emit('render-process-gone');
  third.invoke('cancel');
  const expired = setup(t, builder, {ttlMs: 10});
  const prepared = await expired.invoke('prepare', {repository});
  await delay(30);
  assert.throws(() => expired.invoke('status', prepared.job), unavailable);
  assert.throws(() => third.invoke('status', next.job), unavailable);
});
