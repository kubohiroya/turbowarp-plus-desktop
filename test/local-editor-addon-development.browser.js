const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {installLocalEditorAddonDevelopment} = require('../src-main/local-editor-addon-development');

const origin = 'http://localhost:41015';
const prefix = '/plus-gui/';

test('Desktop runs both add-on formats and replaces TypeScript commands on rebuild', {timeout: 45_000}, async t => {
  const editor = process.env.TW_PLUS_EDITOR_SOURCE;
  assert.ok(editor && path.isAbsolute(editor), 'Set TW_PLUS_EDITOR_SOURCE to the pinned Editor checkout');
  const {chromium, expect} = require(path.join(editor, 'node_modules/@playwright/test'));
  const {transform} = require(path.join(editor, 'node_modules/esbuild'));
  const renderer = path.resolve(__dirname, '../dist-renderer-webpack/editor/plus-gui');
  const pin = require('../config/plus-renderer.json');
  const info = JSON.parse(await fs.readFile(path.join(renderer, 'build-info.json'), 'utf8'));
  assert.equal(info.editorRevision, pin.editorRevision);

  const worktree = await fs.mkdtemp(path.join(tmpdir(), 'tw-local-addon-'));
  t.after(() => fs.rm(worktree, {recursive: true, force: true}));
  const turbo = path.join(worktree, 'turbo-commands');
  const plus = path.join(worktree, 'plus-commands');
  const startup = path.join(worktree, 'startup-commands');
  const startupOutput = path.join(startup, 'entry.js');
  const buildStartup = label => fs.writeFile(startupOutput, `export const activate = api =>
    api.registerCommand('startup', ${JSON.stringify(label)}, () => {});`);
  await Promise.all([fs.mkdir(turbo), fs.mkdir(plus), fs.mkdir(startup)]);
  await Promise.all([
    fs.writeFile(path.join(turbo, 'addon.json'), JSON.stringify({
      name: 'Turbo commands', userscripts: [{url: 'command.js', matches: ['projects']}],
      settings: [{id: 'stop-label', type: 'string', default: 'Stop from TurboWarp add-on'}]
    })),
    fs.writeFile(path.join(turbo, 'command.js'), `export default ({addon}) =>
      addon.tab.registerEditorCommand('stop', addon.settings.get('stop-label'), () =>
        ({project: 'stop', label: 'Stopped from TurboWarp add-on'}));`),
    fs.writeFile(path.join(plus, 'package.json'), JSON.stringify({
      name: 'plus-commands', displayName: 'Plus commands', turbowarpPlusEditor: {addon: {entry: 'command.mjs'}}
    })),
    fs.writeFile(path.join(startup, 'package.json'), JSON.stringify({
      name: 'startup-commands', displayName: 'Startup commands',
      turbowarpPlusEditor: {addon: {entry: 'entry.js', activation: 'startup'}}
    })),
    buildStartup('Startup version one')
  ]);
  const plusSource = `export function activate(api: {
    registerCommand(id: string, label: string,
      handler: () => Promise<{project?: 'run', label: string}>): void
  }) {
    let calls = 0;
    api.registerCommand('run', 'Run build VERSION', async () => {
      if (typeof document !== 'undefined' || typeof process !== 'undefined' ||
          typeof (globalThis as any).EditorPreload !== 'undefined') {
        return {label: 'Unexpected privileges'};
      }
      try {
        await fetch('${origin}${prefix}sandbox-probe.js');
        return {label: 'Unexpected network access'};
      } catch {}
      try {
        await import('${origin}${prefix}sandbox-probe.js');
        return {label: 'Unexpected external module'};
      } catch {}
      return {label: 'Ran build VERSION #' + (++calls), EFFECT};
    });
  }`;
  const output = path.join(plus, 'command.mjs');
  const build = async (version, effect) => {
    const source = plusSource.replaceAll('VERSION', version).replace('EFFECT', effect);
    const input = path.join(plus, 'command.ts');
    await fs.writeFile(input, source);
    const {code} = await transform(await fs.readFile(input, 'utf8'), {loader: 'ts', format: 'esm'});
    await fs.writeFile(output + '.tmp', code);
    await fs.rename(output + '.tmp', output);
  };
  await build('one', '');
  const args = ['--enable-unsafe-swiftshader'];
  if (process.platform === 'darwin') args.push('--single-process', '--no-zygote', '--disable-crash-reporter');
  const browser = await chromium.launch({headless: true, args});
  const webContents = new EventEmitter();
  let closing = false;
  t.after(async () => {
    closing = true;
    webContents.emit('destroyed');
    await browser.close();
  });
  const context = await browser.newContext({serviceWorkers: 'block'});
  let probeRequests = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !url.pathname.startsWith(prefix)) return route.abort();
    if (url.pathname.endsWith('/sandbox-probe.js')) {
      probeRequests++;
      return route.fulfill({body: 'export default null', contentType: 'text/javascript',
        headers: {'Access-Control-Allow-Origin': '*'}});
    }
    const filename = path.resolve(renderer, decodeURIComponent(url.pathname.slice(prefix.length)));
    if (!filename.startsWith(renderer + path.sep)) return route.abort();
    try { return await route.fulfill({path: filename}); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return route.fulfill({status: 404});
    }
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => { if (errors.length) t.diagnostic(errors.join('\n')); });
  webContents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  webContents.isDestroyed = () => closing || page.isClosed();
  webContents.send = (name, payload) => {
    void page.evaluate(([channel, value]) => window.deliverAddonIPC(channel, value), [name, payload])
      .catch(error => { if (!closing) errors.push(error.message); });
  };
  const handlers = new Map();
  const folders = [turbo, plus, startup];
  const approvals = [];
  installLocalEditorAddonDevelopment({on() {}, handle: (name, handler) => handlers.set(name, handler)}, webContents, {
    chooseDirectory: async () => folders.shift(),
    confirm: async (_root, id, capability) => { approvals.push({id, ...capability}); return true; },
    intervalMs: 75
  });
  await page.exposeFunction('invokeAddonIPC', async (name, ...values) => handlers.get(`local-editor-addon-${name}`)(
    {sender: webContents, senderFrame: webContents.mainFrame}, ...values));
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const listeners = new Map();
    const subscribe = (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); };
    window.deliverAddonIPC = (name, value) => listeners.get(name)?.(value);
    window.PromptsPreload = {alert() {}, confirm: () => false};
    window.EditorPreload = {
      isInitiallyFullscreen: () => false, getInitialFile: async () => null,
      setExportForPackager() {}, setChanged() {}, closedFile() {}, dropPermissions() {}, setIsFullScreen() {},
      getAdvancedCustomizations: async () => ({}), getPreferredMediaDevices: async () => ({}),
      setLocale: () => ({strings: {'prompt.ok': 'OK', 'prompt.cancel': 'Cancel'}}),
      localExtensions: {onBuild: () => () => {}, onStopped: () => () => {}},
      localEditorAddons: {
        list: () => window.invokeAddonIPC('list'),
        start: () => window.invokeAddonIPC('start'),
        setEnabled: (...values) => window.invokeAddonIPC('set-enabled', ...values),
        remove: token => window.invokeAddonIPC('remove', token),
        prepared: (...values) => window.invokeAddonIPC('prepared', ...values),
        onChange: listener => subscribe('local-editor-addon-change', listener),
        onRuntime: listener => subscribe('local-editor-addon-runtime', listener),
        ready: () => window.invokeAddonIPC('ready')
      }
    };
  });
  await page.goto(`${origin}${prefix}gui.html?lang=en`);
  await page.waitForFunction(() => Boolean(window.vm?.runtime.getTargetForStage()));
  const probeURL = `${origin}${prefix}sandbox-probe.js`;
  assert.equal(await page.evaluate(async url => (await fetch(url)).text(), probeURL), 'export default null');
  assert.equal(probeRequests, 1);
  await page.evaluate(() => {
    window.projectActions = [];
    for (const action of ['greenFlag', 'stopAll']) {
      const run = window.vm[action].bind(window.vm);
      window.vm[action] = () => { window.projectActions.push(action); return run(); };
    }
  });
  const openFolders = async () => {
    await page.getByRole('button', {name: 'Desktop menu', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Editor Add-on Development Folders…'}).click();
    return page.getByRole('dialog', {name: 'Editor Add-on Development Folders'});
  };
  const dialog = await openFolders();
  const add = dialog.getByRole('button', {name: 'Add Development Folder…'});
  await add.click();
  await expect(dialog.getByRole('checkbox', {name: 'Turbo commands'})).toBeChecked();
  await add.click();
  const enabled = dialog.getByRole('checkbox', {name: 'Plus commands'});
  await expect(enabled).toBeChecked();
  await dialog.getByText('Close', {exact: true}).click();

  const command = name => page.getByRole('button', {name, exact: true});
  const actions = () => page.evaluate(() => window.projectActions);
  await command('Stop from TurboWarp add-on').click();
  await expect(command('Stopped from TurboWarp add-on')).toBeVisible();
  await command('Run build one').click();
  await expect(command('Ran build one #1')).toBeVisible();
  assert.deepEqual(await actions(), ['stopAll']);

  await build('two', "project: 'run'");
  await command('Run build two').click();
  await expect(command('Ran build two #1')).toBeVisible();
  assert.deepEqual(await actions(), ['stopAll', 'greenFlag']);
  await expect(command('Stopped from TurboWarp add-on')).toBeVisible();

  await fs.writeFile(output, 'export function activate( {');
  await openFolders();
  await expect(dialog.getByRole('alert')).toHaveText('JavaScript failed to start. Check the entry point and command registration.');
  await dialog.getByText('Close', {exact: true}).click();
  await command('Ran build two #1').click();
  await expect(command('Ran build two #2')).toBeVisible();

  await openFolders();
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await dialog.getByText('Close', {exact: true}).click();
  await expect(command('Ran build two #2')).toHaveCount(0);
  await expect(command('Stopped from TurboWarp add-on')).toBeVisible();
  const reload = async () => {
    webContents.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false, url: webContents.mainFrame.url});
    await page.reload();
    await page.waitForFunction(() => Boolean(window.vm?.runtime.getTargetForStage()));
    await expect(command('Stop from TurboWarp add-on')).toBeVisible();
  };
  const reloadNotice = dialog.getByRole('status').filter({hasText: 'reload the editor'});
  await openFolders();
  await add.click();
  const startupCheckbox = dialog.getByRole('checkbox', {name: 'Startup commands'});
  await expect(startupCheckbox).toBeChecked();
  await expect(reloadNotice).toBeVisible();
  await dialog.getByText('Close', {exact: true}).click();
  await expect(command('Startup version one')).toHaveCount(0);
  await reload();
  await expect(command('Startup version one')).toBeVisible();

  await page.evaluate(() => {
    const stage = window.vm.runtime.getTargetForStage();
    stage.createVariable('unsaved', 'unsaved', '', false);
    stage.variables.unsaved.value = 'keep this edit';
    window.vm.emit('PROJECT_CHANGED');
  });
  const startupRow = dialog.locator('li').filter({hasText: 'startup-commands'});
  const activeBuild = startupRow.locator('code[title]');
  await openFolders();
  await expect(reloadNotice).toHaveCount(0);
  const firstDigest = await activeBuild.getAttribute('title');
  assert.match(firstDigest, /^[a-f0-9]{64}$/u);
  await buildStartup('Startup version two');
  await expect(reloadNotice).toBeVisible();
  await expect(activeBuild).toHaveAttribute('title', firstDigest);
  await dialog.getByText('Close', {exact: true}).click();
  await expect(command('Startup version one')).toBeVisible();
  await expect(command('Startup version two')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.vm.runtime.getTargetForStage().variables.unsaved.value), 'keep this edit');
  await reload();
  await expect(command('Startup version two')).toBeVisible();

  await fs.writeFile(startupOutput, 'export function activate( {');
  await reload();
  await expect(command('Startup version two')).toBeVisible();
  await openFolders();
  await expect(startupRow.getByRole('alert')).toContainText('JavaScript failed to start');
  await startupCheckbox.click();
  await expect(startupCheckbox).not.toBeChecked();
  await expect(reloadNotice).toBeVisible();
  await dialog.getByText('Close', {exact: true}).click();
  await expect(command('Startup version two')).toBeVisible();
  await reload();
  await expect(command('Startup version two')).toHaveCount(0);

  await buildStartup('Startup version three');
  await openFolders();
  await startupCheckbox.click();
  await expect(reloadNotice).toBeVisible();
  await dialog.getByText('Close', {exact: true}).click();
  await reload();
  await expect(command('Startup version three')).toBeVisible();
  await openFolders();
  await startupRow.getByRole('button', {name: 'Remove from list'}).click();
  await expect(startupCheckbox).toBeDisabled();
  await expect(reloadNotice).toBeVisible();
  await dialog.getByText('Close', {exact: true}).click();
  await reload();
  await expect(command('Startup version three')).toHaveCount(0);
  await openFolders();
  await expect(startupRow).toHaveCount(0);

  assert.deepEqual(approvals, [
    {id: 'turbo-commands', scripts: true, activation: 'live'},
    {id: 'plus-commands', scripts: true, activation: 'live'},
    {id: 'startup-commands', scripts: true, activation: 'startup'}
  ]);
  assert.equal(probeRequests, 1);
  assert.deepEqual(errors, []);
});
