const assert = require('node:assert/strict');
const {EventEmitter, once} = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {installLocalEditorAddonDevelopment, readEditorAddon} = require('../src-main/local-editor-addon-development');
const {openDirectory} = require('../src-main/local-extension-development');

async function makeFolder (parent, name, format) {
  const root = path.join(parent, name);
  await fs.mkdir(root);
  const manifest = format === 'turbowarp' ? {name, userstyles: [{url: 'main.css', matches: ['projects']}]} :
    {name, turbowarpPlusEditor: {addon: {styles: ['main.css']}}};
  const file = path.join(root, format === 'turbowarp' ? 'addon.json' : 'package.json');
  await fs.writeFile(file, JSON.stringify(manifest));
  const css = path.join(root, 'main.css');
  await fs.writeFile(css, `.editor { --${name}: first; }`);
  return {root, file, manifest, css};
}

test('loads local JavaScript and CSS for both formats within the selected folder', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-addon-profile-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const a = await makeFolder(parent, 'turbo', 'turbowarp');
  const b = await makeFolder(parent, 'plus-addon', 'plus');
  const read = async ({root}) => readEditorAddon(await openDirectory(root));
  assert.equal((await read(a)).format, 'turbowarp');
  assert.equal((await read(b)).format, 'plus');
  await fs.writeFile(a.file, JSON.stringify({...a.manifest, userscripts: [{url: 'example.js'}],
    dynamicDisable: false, settings: [{id: 'name', default: 'Run'}, {id: 'unsupported', default: {}}]}));
  const turboSource = 'export default ({addon}) => addon.tab.registerEditorCommand("run", "Run", () => ({project: "run"}));';
  await fs.writeFile(path.join(a.root, 'example.js'), turboSource);
  const turbo = await read(a);
  assert.deepEqual(turbo.sources, [turboSource]);
  assert.equal(turbo.activation, 'startup');
  assert.deepEqual(turbo.settings, [{id: 'name', label: 'name', default: 'Run', kind: 'text', dynamic: false}]);
  await fs.writeFile(a.file, JSON.stringify({...a.manifest, userscripts: [{url: 'example.js', if: {}}]}));
  assert.equal((await read(a)).unavailable, 'LOCAL_ADDON_RUNTIME_UNSUPPORTED');
  const plusSource = 'export const activate = api => api.registerCommand("stop", "Stop", () => ({project: "stop"}));';
  await fs.writeFile(path.join(b.root, 'sample.mjs'), plusSource);
  const viewportPackage = {name: 'plus-addon', turbowarpPlusEditor: {
    addon: {entry: 'sample.mjs', permissions: ['workspace.viewport'],
      settings: [{id: 'tone', name: 'Tone', type: 'select', default: 'brief', dynamic: true,
        potentialValues: [{id: 'brief', name: 'Brief'}, {id: 'detailed', name: 'Detailed'}]}]}
  }};
  await fs.writeFile(b.file, JSON.stringify(viewportPackage));
  const plus = await read(b);
  assert.equal(plus.css, '');
  assert.deepEqual(plus.sources, [plusSource]);
  assert.equal(plus.activation, 'live');
  assert.equal(plus.viewport, true);
  assert.deepEqual(plus.settings[0], {id: 'tone', label: 'Tone', kind: 'select', default: 'brief', dynamic: true,
    options: [{value: 'brief', label: 'Brief'}, {value: 'detailed', label: 'Detailed'}]});
  await fs.writeFile(b.file, JSON.stringify({...viewportPackage,
    turbowarpPlusEditor: {addon: {...viewportPackage.turbowarpPlusEditor.addon, permissions: ['workspace.anything']}}
  }));
  assert.equal((await read(b)).unavailable, 'LOCAL_ADDON_RUNTIME_UNSUPPORTED');
  await fs.writeFile(b.file, JSON.stringify(b.manifest));
  for (const css of ['@import "https://test.invalid/style.css";',
    '.editor { background: var(--network, image-set("https://test.invalid/private" 1x)); }',
    '.editor { background: u\\72l(https://test.invalid); }',
    '.editor { content: "/*"; background: url(https://test.invalid/private); color: "*/"; }']) {
    await fs.writeFile(b.css, css);
    await assert.rejects(read(b), {code: 'LOCAL_ADDON_STYLE_UNSUPPORTED'});
  }
  await fs.writeFile(b.css, '.editor { color: red');
  await assert.rejects(read(b), {code: 'LOCAL_ADDON_INCOMPLETE'});
  await fs.writeFile(b.file, JSON.stringify({name: 'plus-addon', turbowarpPlusEditor: {addon: {styles: ['../outside.css']}}}));
  await assert.rejects(read(b), {code: 'LOCAL_ADDON_MANIFEST'});
  await fs.writeFile(b.file, JSON.stringify(b.manifest));
  await fs.unlink(b.css);
  await fs.symlink(a.css, b.css);
  await assert.rejects(read(b), {code: 'LOCAL_ADDON_BOUNDARY'});
});

test('the two editor add-on folders can update, pause and resume independently', {timeout: 5000}, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-addon-sessions-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const a = await makeFolder(parent, 'turbo', 'turbowarp');
  const b = await makeFolder(parent, 'plus-addon', 'plus');
  const selected = [a.root, b.root, a.root];
  const webContents = new EventEmitter();
  const styles = new Map();
  webContents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  webContents.isDestroyed = () => false;
  webContents.send = (...args) => webContents.emit(...args);
  let nextStyle = 0;
  webContents.insertCSS = async css => {
    const key = ++nextStyle;
    styles.set(key, css);
    return key;
  };
  webContents.removeInsertedCSS = async key => { assert.ok(styles.delete(key)); };
  const handlers = new Map();
  const invoke = (name, ...args) => handlers.get(`local-editor-addon-${name}`)(
    {sender: webContents, senderFrame: webContents.mainFrame}, ...args);
  let approvals = 0;
  installLocalEditorAddonDevelopment({on() {}, handle: (name, listener) => handlers.set(name, listener)}, webContents,
    {chooseDirectory: async () => selected.shift(), confirm: async () => { approvals++; return true; }, intervalMs: 12});
  t.after(() => webContents.emit('destroyed'));
  assert.throws(() => handlers.get('local-editor-addon-list')({sender: webContents, senderFrame: {}}),
    {code: 'LOCAL_ADDON_UNAVAILABLE'});
  await invoke('start');
  await invoke('start');
  const [first, second] = invoke('list');
  assert.equal(first.directory, await fs.realpath(a.root));
  assert.equal(second.directory, await fs.realpath(b.root));
  assert.equal(styles.size, 2);
  await assert.rejects(invoke('start'), {code: 'LOCAL_ADDON_DUPLICATE'});
  await invoke('set-enabled', first.token, false);
  assert.deepEqual(invoke('list').map(item => item.enabled), [false, true]);
  assert.equal(styles.size, 1);
  const change = once(webContents, 'local-editor-addon-change');
  await fs.writeFile(b.css, '.editor { --plus-addon: second; }');
  await change;
  assert.deepEqual([...styles.values()], ['.editor { --plus-addon: second; }']);
  await fs.writeFile(a.file, JSON.stringify({...a.manifest, userscripts: [{url: 'example.js'}]}));
  await fs.writeFile(path.join(a.root, 'example.js'), 'export default () => {};');
  await assert.rejects(invoke('set-enabled', first.token, true), {code: 'LOCAL_ADDON_CHANGED'});
  assert.deepEqual(invoke('list').map(item => item.enabled), [false, true]);
  await fs.writeFile(a.file, JSON.stringify(a.manifest));
  await fs.writeFile(a.css, '.editor { --turbo: newer; }');
  await invoke('set-enabled', first.token, true);
  assert.ok([...styles.values()].some(css => css.includes('--turbo: newer')));
  assert.equal(approvals, 2);
  await invoke('remove', second.token);
  assert.deepEqual(invoke('list').map(item => item.id), [first.id]);
  webContents.emit('did-start-navigation', {isMainFrame: true, url: webContents.mainFrame.url});
  assert.equal(styles.size, 0);
  assert.equal(invoke('list')[0].appliedDigest, null);
  await invoke('ready');
  assert.equal(styles.size, 1);
  assert.match(invoke('list')[0].appliedDigest, /^[a-f0-9]{64}$/u);
  assert.equal(approvals, 2);
  webContents.emit('did-start-navigation', {isMainFrame: true, url: 'https://example.invalid/'});
  await invoke('ready');
  assert.equal(styles.size, 0);
  assert.deepEqual(invoke('list'), []);
});

test('setting changes are atomic and keep deferred values until the next editor start', {timeout: 5000}, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-addon-settings-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const addon = await makeFolder(parent, 'turbo', 'turbowarp');
  await fs.writeFile(addon.file, JSON.stringify({...addon.manifest, userstyles: [], userscripts: [{url: 'entry.js'}],
    settings: [
      {id: 'live', name: 'Live setting', type: 'boolean', default: false, dynamic: true},
      {id: 'passes', name: 'Passes', type: 'positive_integer', default: 1, max: 3}
    ]
  }));
  const script = path.join(addon.root, 'entry.js');
  await fs.writeFile(script, 'export default () => {};');
  const webContents = new EventEmitter();
  webContents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  webContents.isDestroyed = () => false;
  const handlers = new Map();
  const event = {sender: webContents, senderFrame: webContents.mainFrame};
  const invoke = (name, ...args) => handlers.get(`local-editor-addon-${name}`)(event, ...args);
  const runtime = [];
  webContents.send = (channel, message) => {
    if (channel !== 'local-editor-addon-runtime') return;
    runtime.push(message);
    if (message.type === 'prepare') invoke('prepared', message.runtimeId, true);
    webContents.emit(message.type, message);
  };
  installLocalEditorAddonDevelopment({on() {}, handle: (name, listener) => handlers.set(name, listener)}, webContents,
    {chooseDirectory: async () => addon.root, confirm: async () => true, intervalMs: 10});
  t.after(() => webContents.emit('destroyed'));
  await invoke('start');
  const {token, settingsRevision} = invoke('list')[0];
  const configure = changes => invoke('set-settings', token, settingsRevision, changes);
  await assert.rejects(invoke('set-settings', token, 'old-schema', [['live', true]]), {code: 'LOCAL_ADDON_SETTINGS_CHANGED'});
  await assert.rejects(configure([['live', true], ['passes', 4]]), {code: 'LOCAL_ADDON_INVALID_SETTINGS'});
  await assert.rejects(configure([['live', true], ['live', false]]), {code: 'LOCAL_ADDON_INVALID_SETTINGS'});
  assert.deepEqual(invoke('list')[0].settings.map(field => field.value), [false, 1]);
  await configure([['live', true], ['passes', 2]]);
  assert.deepEqual(runtime.at(-1).values, [['live', true]]);
  assert.equal(invoke('list')[0].reloadRequired, true);

  const rebuilt = once(webContents, 'prepare');
  await fs.writeFile(script, 'export default async () => {};');
  assert.deepEqual((await rebuilt)[0].values, [['live', true], ['passes', 1]]);
  webContents.emit('did-start-navigation', {isMainFrame: true, url: webContents.mainFrame.url});
  await invoke('ready');
  assert.deepEqual(runtime.filter(message => message.type === 'prepare').at(-1).values, [['live', true], ['passes', 2]]);
  assert.equal(invoke('list')[0].reloadRequired, false);
});
