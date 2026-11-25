const assert = require('node:assert/strict');
const {execFile} = require('node:child_process');
const {createHash} = require('node:crypto');
const {EventEmitter} = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const {tmpdir} = require('node:os');
const {test} = require('node:test');
const {promisify} = require('node:util');
const {installLocalExtensionDevelopment, openDirectory, readDevelopmentBuild} = require('../src-main/local-extension-development');

const exec = promisify(execFile);
const origin = 'http://localhost:41015';
const prefix = '/plus-gui/';
const testId = 'kubohiroyatest';
const testName = 'the greeting includes the name';
const assertId = 'check-development-greeting';
const testHash = '7f6541ce906594cde7d02498c65e8a800f0c194a924d288f9de4d702e738d868';

test('a rebuilt local TypeScript extension automatically changes the same Desktop Scratch test from red to green',
  {timeout: 60_000}, async t => {
    const editor = process.env.TW_PLUS_EDITOR_SOURCE;
    const template = process.env.TW_PLUS_EXTENSION_TEMPLATE_ROOT;
    const testBundle = process.env.TW_PLUS_TEST_EXTENSION_JS;
    for (const value of [editor, template, testBundle]) assert.ok(value && path.isAbsolute(value),
      'Set TW_PLUS_EDITOR_SOURCE, TW_PLUS_EXTENSION_TEMPLATE_ROOT and TW_PLUS_TEST_EXTENSION_JS');
    const {chromium, expect} = require(path.join(editor, 'node_modules/@playwright/test'));
    const Zip = require(path.join(editor, 'node_modules/@turbowarp/jszip'));
    const {project} = require(path.join(editor, 'test/e2e/extension-loader/project.cts'));
    const renderer = path.resolve(__dirname, '../dist-renderer-webpack/editor/plus-gui');
    const pin = require('../config/plus-renderer.json');
    const info = JSON.parse(await fs.readFile(path.join(renderer, 'build-info.json'), 'utf8'));
    const {stdout} = await exec('git', ['-C', editor, 'rev-parse', 'HEAD']);
    assert.equal(info.editorRevision, pin.editorRevision);
    assert.equal(info.editorRevision, stdout.trim());

    const worktree = await fs.mkdtemp(path.join(tmpdir(), 'tw-local-extension-'));
    t.after(() => fs.rm(worktree, {recursive: true, force: true}));
    const folder = path.join(worktree, 'extension');
    await fs.mkdir(folder);
    for (const name of ['src', 'assets', 'vite.config.ts', 'package.json']) {
      await fs.cp(path.join(template, name), path.join(folder, name), {recursive: true});
    }
    await fs.symlink(path.join(template, 'node_modules'), path.join(folder, 'node_modules'), 'junction');
    const sourcePath = path.join(folder, 'src/extension.ts');
    const correctedSource = await fs.readFile(sourcePath, 'utf8');
    const faultySource = correctedSource.replace('Hello, {name}!', 'Wrong, {name}!');
    assert.notEqual(faultySource, correctedSource);
    const build = async source => {
      await fs.writeFile(sourcePath, source);
      await exec(process.execPath, [path.join(folder, 'node_modules/vite/bin/vite.js'), 'build'], {cwd: folder});
      return readDevelopmentBuild(await openDirectory(folder));
    };
    const faulty = await build(faultySource);
    const testBytes = await fs.readFile(testBundle);
    assert.equal(createHash('sha256').update(testBytes).digest('hex'), testHash);
    const blocks = {
      'development-test': {opcode: `${testId}_whentest`, next: assertId, parent: null,
        inputs: {NAME: [1, [10, testName]]}, fields: {}, shadow: false, topLevel: true, x: 40, y: 40},
      [assertId]: {opcode: `${testId}_assert_strict_equals`, next: null, parent: 'development-test',
        inputs: {ACTUAL: [2, 'greeting'], EXPECTED: [1, [10, 'Hello, Scratch!']]}, fields: {}, shadow: false, topLevel: false},
      greeting: {opcode: `${faulty.id}_hello`, next: null, parent: assertId,
        inputs: {NAME: [1, [10, 'Scratch']]}, fields: {}, shadow: false, topLevel: false}
    };
    const zip = await Zip.loadAsync(await project({id: faulty.id, execution: 'sandboxed', code: faulty.bytes,
      sha256: faulty.sha256, stageBlocks: blocks, embeddedPath: `extensions/${faulty.id}.js`}));
    const json = JSON.parse(await zip.file('project.json').async('string'));
    const script = 'extensions/turbowarp-test.js';
    json.extensions.push(testId);
    json.turboWarpPlus.extensions.push({id: testId, execution: 'unsandboxed', sha256: testHash,
      source: {type: 'embedded-file', path: script}});
    zip.file('project.json', JSON.stringify(json));
    zip.file(script, testBytes);
    const sb3 = await zip.generateAsync({type: 'nodebuffer'});

    const args = ['--enable-unsafe-swiftshader'];
    if (process.platform === 'darwin') args.push('--single-process', '--no-zygote', '--disable-crash-reporter');
    const browser = await chromium.launch({headless: true, args});
    t.after(() => browser.close());
    const context = await browser.newContext({serviceWorkers: 'block'});
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || !url.pathname.startsWith(prefix)) return route.abort();
      const filename = path.resolve(renderer, decodeURIComponent(url.pathname.slice(prefix.length)));
      if (!filename.startsWith(renderer + path.sep)) return route.abort();
      try {
        return await route.fulfill({path: filename});
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return route.fulfill({status: 404});
      }
    });
    await context.route('https://kubohiroya.github.io/turbowarp-plus-packages/extensions-v1.json', route => route.fulfill({
      json: {schemaVersion: 1, extensions: [{id: testId, name: 'Test', version: '0.1.0', unsandboxed: 'required',
        url: 'https://kubohiroya.github.io/turbowarp-test/dist/turbowarp-test.js', sha256: testHash,
        description: 'Scratch test hats and assertions', dependencies: [], license: 'MPL-2.0'}]},
      headers: {'access-control-allow-origin': '*'}
    }));
    const page = await context.newPage();
    const failures = [];
    const alerts = [];
    const activity = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('dialog', async dialog => { failures.push(dialog.message()); await dialog.dismiss(); });

    const handlers = new Map();
    const webContents = new EventEmitter();
    webContents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
    const forTransport = value => value?.bytes ? {...value, bytes: [...value.bytes]} : value;
    webContents.send = (channel, value) => {
      activity.push([channel, value?.sha256 ?? value?.code]);
      if (!page.isClosed()) void page.evaluate(([name, payload]) => window.deliverDesktopIPC(name, payload),
        [channel, forTransport(value)]).catch(error => failures.push(error.message));
    };
    let consent = 0;
    installLocalExtensionDevelopment({on() {}, handle: (channel, handler) => handlers.set(channel, handler)}, webContents, {
      chooseDirectory: async () => folder,
      confirm: async (_root, id) => { assert.equal(id, faulty.id); consent++; return true; }
    });
    t.after(() => webContents.emit('destroyed'));
    await page.exposeFunction('invokeDesktopIPC', async (name, ...args) => {
      const value = await handlers.get(name)({sender: webContents, senderFrame: webContents.mainFrame}, ...args);
      activity.push([name, value?.sha256 ?? value]);
      return forTransport(value);
    });
    await page.exposeFunction('recordDesktopAlert', message => { alerts.push(message); });
    await page.addInitScript(() => {
      const listeners = new Map();
      const subscribe = (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); };
      window.deliverDesktopIPC = (name, value) => listeners.get(name)?.(value);
      window.PromptsPreload = {alert: message => { void window.recordDesktopAlert(message); }, confirm: () => false};
      window.EditorPreload = {
        isInitiallyFullscreen: () => false, getInitialFile: async () => null,
        setExportForPackager() {}, setChanged() {}, closedFile() {}, dropPermissions() {}, setIsFullScreen() {},
        getAdvancedCustomizations: async () => ({}), getPreferredMediaDevices: async () => ({}),
        setLocale: () => ({strings: {'prompt.ok': 'OK', 'prompt.cancel': 'Cancel'}}),
        localExtensions: {
          start: () => window.invokeDesktopIPC('local-extension-start'),
          stop: () => window.invokeDesktopIPC('local-extension-stop'),
          authorize: (...args) => window.invokeDesktopIPC('local-extension-authorize', ...args),
          onBuild: listener => subscribe('local-extension-build', listener),
          onStopped: listener => subscribe('local-extension-stopped', listener)
        }
      };
    });
    t.after(() => { if (failures.length) t.diagnostic(failures.join('\n')); });
    await page.goto(`${origin}${prefix}gui.html?lang=en`);
    await page.waitForFunction(() => Boolean(window.vm?.runtime.getTargetForStage()));
    const loading = page.evaluate(bytes => window.vm.loadProject(new Uint8Array(bytes)), [...sb3]);
    const review = page.getByRole('dialog').filter({has: page.locator('.twextsec-review')});
    await review.getByTestId('twextsec-enable-all').click();
    await loading;
    await page.evaluate(() => {
      const vm = window.vm;
      vm.runtime.getTargetForStage().createVariable('unsaved', 'unsaved', '', false);
      vm.runtime.getTargetForStage().variables.unsaved.value = 'unchanged';
      vm.emit('PROJECT_CHANGED');
    });
    await page.locator('img[class*="about-icon"]').click();
    await page.getByText('Open Extension Development Folder…', {exact: true}).click();
    await expect.poll(() => consent).toBe(1);

    const popup = page.waitForEvent('popup');
    const runMenu = page.getByRole('button', {name: 'Run view opening options'});
    if (await runMenu.count()) await runMenu.click();
    else await page.getByRole('button', {name: 'Stage display options'}).click();
    await page.getByText('Open the test run view', {exact: true}).click();
    const view = await popup;
    const result = view.locator('.twpe-test-run__test').filter({hasText: testName});
    await view.getByRole('button', {name: 'Run all'}).click();
    await expect(result).toHaveAttribute('data-status', 'failed');
    await expect(result.locator('code')).toHaveText(['"Hello, Scratch!"', '"Wrong, Scratch!"']);
    await expect(result.getByRole('button', {name: 'Show block'})).toHaveAttribute('data-block-id', assertId);

    const corrected = await build(correctedSource);
    assert.notEqual(faulty.sha256, corrected.sha256);
    assert.equal(faulty.apiSHA256, corrected.apiSHA256);
    const installed = () => page.evaluate(id => JSON.parse(window.vm.toJSON(undefined, {allowOptimization: false}))
      .turboWarpPlus.extensions.find(entry => entry.id === id)?.sha256, faulty.id);
    try {
      await expect.poll(installed, {timeout: 10_000}).toBe(corrected.sha256);
    } catch (error) {
      t.diagnostic(JSON.stringify(activity));
      t.diagnostic(await page.getByRole('dialog').allTextContents().then(values => values.join('\n')));
      throw error;
    }
    await expect(review).toHaveCount(0);
    assert.equal(consent, 1);
    assert.equal(await page.evaluate(() => window.vm.runtime.getTargetForStage().variables.unsaved.value), 'unchanged');
    await view.getByRole('button', {name: 'Run all'}).click();
    await expect(result).toHaveAttribute('data-status', 'passed');
    assert.deepEqual(failures, []);
    assert.deepEqual(alerts, []);
    assert.equal(await installed(), corrected.sha256);
    t.diagnostic(`same assertion ${assertId}: "Wrong, Scratch!" failed, "Hello, Scratch!" passed`);

    const incompatible = await build(correctedSource.replace('opcode: block.opcode,', 'opcode: `${block.opcode}Changed`, '));
    assert.notEqual(incompatible.sha256, corrected.sha256);
    assert.equal(incompatible.apiSHA256, corrected.apiSHA256);
    await expect.poll(() => alerts).toEqual(['The new build could not be applied. The previous build is still active.']);
    assert.equal(await installed(), corrected.sha256);
    assert.equal(consent, 1);
    t.diagnostic('an incompatible registered opcode was rejected, and the corrected build was restored');
  });
