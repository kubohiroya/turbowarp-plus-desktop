const assert = require('node:assert/strict');
const {execFile, spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const {EventEmitter, once} = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const {tmpdir} = require('node:os');
const {test} = require('node:test');
const {promisify} = require('node:util');

const exec = promisify(execFile);
const origin = 'http://localhost:41015';
const prefix = '/plus-gui/';
const testId = 'kubohiroyatest';
const testName = 'the greeting includes the name';
const assertId = 'check-development-greeting';
const testHash = '7f6541ce906594cde7d02498c65e8a800f0c194a924d288f9de4d702e738d868';

test('two independently watched extension folders update one Desktop project and its Scratch test',
  {timeout: 90_000}, async t => {
    const editor = process.env.TW_PLUS_EDITOR_SOURCE;
    const template = process.env.TW_PLUS_EXTENSION_TEMPLATE_ROOT;
    const testBundle = process.env.TW_PLUS_TEST_EXTENSION_JS;
    const packagedApp = process.env.TW_PLUS_DESKTOP_APP_SOURCE;
    const bundledElectron = process.env.TW_PLUS_SOURCE_BUILD_ELECTRON;
    const sourceMode = Boolean(bundledElectron);
    const compilerResources = process.env.TW_PLUS_SOURCE_BUILD_RESOURCES;
    const expectSourceMap = process.env.TW_PLUS_EXPECT_DEVELOPMENT_SOURCE_MAP === '1';
    const expectRuntimeDiagnostic = process.env.TW_PLUS_EXPECT_RUNTIME_DIAGNOSTIC === '1';
    for (const value of [editor, template, testBundle]) assert.ok(value && path.isAbsolute(value),
      'Set TW_PLUS_EDITOR_SOURCE, TW_PLUS_EXTENSION_TEMPLATE_ROOT and TW_PLUS_TEST_EXTENSION_JS');
    if (packagedApp) assert.ok(path.isAbsolute(packagedApp), 'TW_PLUS_DESKTOP_APP_SOURCE must be an absolute path');
    const app = packagedApp || path.resolve(__dirname, '..');
    const {installLocalExtensionDevelopment, openDirectory, readDevelopmentBuild, readDevelopmentFile} =
      require(path.join(app, 'src-main/local-extension-development'));
    const sourceBuilder = sourceMode && require(path.join(app, 'src-main/standard-extension-source-build'))
      .createStandardExtensionBuilder({isPackaged: Boolean(compilerResources), resources: compilerResources, executable: bundledElectron});
    if (sourceMode) assert.ok(sourceBuilder, 'Prepare the published compiler payload before testing');
    const {installLocalEditorAddonDevelopment} = require(path.join(app, 'src-main/local-editor-addon-development'));
    const {chromium, expect} = require(path.join(editor, 'node_modules/@playwright/test'));
    const Zip = require(path.join(editor, 'node_modules/@turbowarp/jszip'));
    const {project} = require(path.join(editor, 'test/e2e/extension-loader/project.cts'));
    const renderer = path.join(app, 'dist-renderer-webpack/editor/plus-gui');
    const pin = require(path.join(app, 'config/plus-renderer.json'));
    const info = JSON.parse(await fs.readFile(path.join(renderer, 'build-info.json'), 'utf8'));
    const {stdout} = await exec('git', ['-C', editor, 'rev-parse', 'HEAD']);
    assert.equal(info.editorRevision, pin.editorRevision);
    assert.equal(info.editorRevision, stdout.trim());
    if (packagedApp) {
      const pins = require(path.join(editor, 'site/source.json'));
      const {stdout: desktopSHA} = await exec('git', ['rev-parse', 'HEAD'], {cwd: path.resolve(__dirname, '..')});
      assert.equal(info.desktopDirty, false);
      assert.deepEqual([info.desktopRevision, info.guiRevision, info.vmRevision], [desktopSHA.trim(), pins.guiRevision, pins.vmRevision]);
    }

    const worktree = await fs.mkdtemp(path.join(tmpdir(), 'tw-local-extension-'));
    t.after(() => fs.rm(worktree, {recursive: true, force: true}));
    const folder = path.join(worktree, 'greeting-extension');
    const otherFolder = path.join(worktree, 'alternate-greeting-extension');
    for (const directory of [folder, otherFolder]) {
      await fs.mkdir(directory);
      const names = sourceMode ? ['src', 'extension-build.json', 'package.json', 'pnpm-lock.yaml'] :
        ['src', 'assets', 'vite.config.ts', 'package.json'];
      for (const name of names) await fs.cp(path.join(template, name), path.join(directory, name), {recursive: true});
      if (sourceMode) {
        // A build must work with no project dependencies, and any attempt to run project Vite config must fail.
        await fs.writeFile(path.join(directory, 'vite.config.ts'), 'throw new Error("This config must never execute");');
      } else {
        await fs.symlink(path.join(template, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
      }
    }
    const metadataPath = path.join(otherFolder, 'src/extension-config.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    await fs.writeFile(metadataPath, JSON.stringify({...metadata, id: 'alternategreeting', name: 'Alternate Greeting'}));
    const sourcePath = path.join(folder, 'src/extension.ts');
    const correctedSource = await fs.readFile(sourcePath, 'utf8');
    const throwLine = '    if (args.NAME === "diagnostic") throw new Error("fixture runtime failure");';
    let faultySource = correctedSource.replace('Hello, {name}!', 'Wrong, {name}!');
    if (expectRuntimeDiagnostic) faultySource = faultySource.replace(
      'public hello(args: {NAME: unknown}): string {\n', `public hello(args: {NAME: unknown}): string {\n${throwLine}\n`);
    assert.notEqual(faultySource, correctedSource);
    const build = async (source, directory = folder) => {
      await fs.writeFile(path.join(directory, 'src/extension.ts'), source);
      if (sourceMode) {
        const signal = new AbortController().signal;
        const snapshot = await sourceBuilder.read(await openDirectory(directory), signal, readDevelopmentFile);
        const files = await sourceBuilder.build(snapshot, signal);
        const marker = JSON.parse(files.get('extension-development.json'));
        return {id: marker.id, bytes: files.get(marker.bundle.file), sha256: marker.bundle.sha256,
          apiSHA256: marker.api.sha256, sourceMapSHA256: marker.sourceMap.sha256};
      }
      await exec(process.execPath, [path.join(directory, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'development'],
        {cwd: directory});
      return readDevelopmentBuild(await openDirectory(directory));
    };
    const [faulty, otherInitial] = await Promise.all([build(faultySource), build(faultySource, otherFolder)]);
    if (expectSourceMap) {
      assert.match(faulty.sourceMapSHA256, /^[a-f0-9]{64}$/u);
      assert.match(otherInitial.sourceMapSHA256, /^[a-f0-9]{64}$/u);
    }
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
    if (expectRuntimeDiagnostic) {
      Object.assign(blocks, {
        'diagnostic-start': {opcode: 'event_whenflagclicked', next: 'diagnostic-say', parent: null,
          inputs: {}, fields: {}, shadow: false, topLevel: true, x: 260, y: 40},
        'diagnostic-say': {opcode: 'looks_say', next: null, parent: 'diagnostic-start',
          inputs: {MESSAGE: [2, 'diagnostic-greeting']}, fields: {}, shadow: false, topLevel: false},
        'diagnostic-greeting': {opcode: `${faulty.id}_hello`, next: null, parent: 'diagnostic-say',
          inputs: {NAME: [1, [10, 'diagnostic']]}, fields: {}, shadow: false, topLevel: false}
      });
    }
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
    let closeDesktop;
    let closing = false;
    t.after(async () => {
      closing = true;
      closeDesktop?.();
      await browser.close();
    });
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
    const latestBuilds = new Map();
    page.on('pageerror', error => failures.push(error.message));
    page.on('dialog', async dialog => { failures.push(dialog.message()); await dialog.dismiss(); });

    const handlers = new Map();
    const webContents = new EventEmitter();
    webContents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
    const forTransport = value => value?.bytes ? {...value, bytes: [...value.bytes]} : value;
    webContents.send = (channel, value) => {
      if (channel === 'local-extension-build') {
        const {id, sha256, apiSHA256, sourceMapSHA256} = value;
        latestBuilds.set(id, {sha256, apiSHA256, sourceMapSHA256});
      }
      activity.push([channel, value?.sha256 ?? value?.code]);
      if (!closing && !page.isClosed()) void page.evaluate(([name, payload]) => window.deliverDesktopIPC(name, payload),
        [channel, forTransport(value)]).catch(error => { if (!closing) failures.push(error.message); });
    };
    const pickedFolders = [folder, otherFolder];
    const consent = [];
    installLocalExtensionDevelopment({on() {}, handle: (channel, handler) => handlers.set(channel, handler)}, webContents, {
      sourceBuilder,
      chooseDirectory: async () => pickedFolders.shift(),
      confirm: async (_root, id, mode) => { consent.push([id, mode]); return true; }
    });
    const addonFolder = path.join(worktree, 'turbo-style');
    const plusFolder = path.join(worktree, 'plus-style');
    await Promise.all([fs.mkdir(addonFolder), fs.mkdir(plusFolder)]);
    await Promise.all([
      fs.writeFile(path.join(addonFolder, 'addon.json'), JSON.stringify({name: 'Turbo Style',
        userstyles: [{url: 'main.css', matches: ['projects']}]})),
      fs.writeFile(path.join(plusFolder, 'package.json'), JSON.stringify({name: 'plus-style', displayName: 'Plus Style',
        turbowarpPlusEditor: {addon: {styles: ['main.css']}}})),
      fs.writeFile(path.join(addonFolder, 'main.css'), 'body { --turbo-style: first; }'),
      fs.writeFile(path.join(plusFolder, 'main.css'), 'body { --plus-style: first; }')
    ]);
    const styles = new Map();
    let styleKey = 0;
    webContents.isDestroyed = () => page.isClosed();
    webContents.insertCSS = async css => {
      const key = String(++styleKey);
      styles.set(key, await page.addStyleTag({content: css}));
      return key;
    };
    webContents.removeInsertedCSS = async key => {
      await styles.get(key)?.evaluate(node => node.remove());
      styles.delete(key);
    };
    const addonFolders = [addonFolder, plusFolder];
    installLocalEditorAddonDevelopment({on() {}, handle: (name, handler) => handlers.set(name, handler)}, webContents,
      {chooseDirectory: async () => addonFolders.shift(), confirm: async () => true, intervalMs: 75});
    closeDesktop = () => webContents.emit('destroyed');
    await page.exposeFunction('invokeDesktopIPC', async (name, ...args) => {
      const value = await handlers.get(name)({sender: webContents, senderFrame: webContents.mainFrame}, ...args);
      activity.push([name, value?.sha256 ?? value]);
      return forTransport(value);
    });
    await page.exposeFunction('recordDesktopAlert', message => { alerts.push(message); });
    await page.addInitScript(supportsSourceBuild => {
      const listeners = new Map();
      const subscribe = (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); };
      window.deliverDesktopIPC = (name, value) => listeners.get(name)?.(value);
      window.PromptsPreload = {alert: message => { void window.recordDesktopAlert(message); }, confirm: () => false};
      window.EditorPreload = {
        isInitiallyFullscreen: () => false, getInitialFile: async () => null,
        setExportForPackager() {}, setChanged() {}, closedFile() {}, dropPermissions() {}, setIsFullScreen() {},
        getAdvancedCustomizations: async () => ({}), getPreferredMediaDevices: async () => ({}),
        setLocale: () => ({strings: {'prompt.ok': 'OK', 'prompt.cancel': 'Cancel',
          'in-app-about.desktop-settings': 'Desktop Settings', 'in-app-about.privacy': 'Privacy Policy',
          'in-app-about.about': 'About', 'in-app-about.source-code': 'Source Code'}}),
        localEditorAddons: {
          list: () => window.invokeDesktopIPC('local-editor-addon-list'),
          start: () => window.invokeDesktopIPC('local-editor-addon-start'),
          setEnabled: (...args) => window.invokeDesktopIPC('local-editor-addon-set-enabled', ...args),
          setSettings: (...args) => window.invokeDesktopIPC('local-editor-addon-set-settings', ...args),
          remove: token => window.invokeDesktopIPC('local-editor-addon-remove', token),
          onChange: listener => subscribe('local-editor-addon-change', listener),
          onRuntime: listener => subscribe('local-editor-addon-runtime', listener),
          ready: () => window.invokeDesktopIPC('local-editor-addon-ready'),
          prepared: (...args) => window.invokeDesktopIPC('local-editor-addon-prepared', ...args)
        },
        localExtensions: {
          sourceBuild: supportsSourceBuild,
          start: mode => window.invokeDesktopIPC('local-extension-start', mode),
          cancelStart: () => window.invokeDesktopIPC('local-extension-cancel-start'),
          stop: (...args) => window.invokeDesktopIPC('local-extension-stop', ...args),
          setEnabled: (...args) => window.invokeDesktopIPC('local-extension-set-enabled', ...args),
          authorize: (...args) => window.invokeDesktopIPC('local-extension-authorize', ...args),
          retainDiagnostics: (...args) => window.invokeDesktopIPC('local-extension-retain-diagnostics', ...args),
          resolveDiagnostic: (...args) => window.invokeDesktopIPC('local-extension-resolve-diagnostic', ...args),
          onBuild: listener => subscribe('local-extension-build', listener),
          onArtifacts: listener => subscribe('local-extension-artifacts', listener),
          onStopped: listener => subscribe('local-extension-stopped', listener)
        }
      };
    }, sourceMode);
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
    const gear = page.getByRole('button', {name: 'Desktop menu', exact: true});
    const recorder = page.locator('[data-addon-stage-control="mediarecorder"]');
    await expect(recorder).toBeVisible();
    assert.ok((await gear.boundingBox()).x >= (await recorder.boundingBox()).x + (await recorder.boundingBox()).width);
    await expect(gear).toContainText('⚙️');
    const openDesktopMenu = async () => {
      await gear.click();
      const menu = page.getByRole('menu', {name: 'Desktop menu'});
      await expect(menu).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      return menu;
    };
    const openManager = async () => {
      const menu = await openDesktopMenu();
      await expect(menu.getByRole('menuitem')).toHaveText(['Extension Development Folders…', 'Editor Add-on Development Folders…']);
      await menu.getByRole('menuitem', {name: 'Extension Development Folders…'}).click();
    };
    await openManager();
    const manager = page.getByRole('dialog', {name: 'Extension Development Folders'});
    const addFolder = manager.getByRole('button', {name: sourceMode ?
      'Add Folder and Build TypeScript Automatically…' : 'Add Development Folder…'});
    await expect(manager.getByText('No development folders are registered.')).toBeVisible();
    assert.deepEqual(consent, []);
    await addFolder.click();
    await expect(manager.getByText('TurboWarp-Example-Extension', {exact: true})).toBeVisible();
    await addFolder.click();
    const firstRow = manager.locator('li').filter({hasText: faulty.id});
    const secondRow = manager.locator('li').filter({hasText: otherInitial.id});
    await expect(firstRow.getByRole('checkbox')).toBeChecked();
    await expect(secondRow.getByRole('checkbox')).toBeChecked();
    await expect(firstRow.locator('code:not([title])')).toHaveText(await fs.realpath(folder));
    await expect(secondRow.locator('code:not([title])')).toHaveText(await fs.realpath(otherFolder));
    assert.deepEqual(consent, [faulty.id, otherInitial.id].map(id => [id, sourceMode ? 'source' : 'artifact']));
    if (expectRuntimeDiagnostic) {
      await expect(firstRow.locator('code[title]')).toHaveAttribute('title', faulty.sha256);
      await expect(secondRow.locator('code[title]')).toHaveAttribute('title', otherInitial.sha256);
      await page.evaluate(() => { window.vm.greenFlag(); });
      const line = faultySource.split('\n').indexOf(throwLine) + 1;
      const column = throwLine.indexOf('new Error') + 1;
      try {
        await expect(firstRow.getByRole('status')).toHaveText(`Extension block runtime error src/extension.ts:${line}:${column}`);
      } catch (error) {
        t.diagnostic(JSON.stringify({
          diagnostics: activity.filter(([name]) => name.endsWith('diagnostics') || name.endsWith('diagnostic')),
          failures
        }));
        throw error;
      }
      await expect(secondRow.getByRole('status')).toHaveCount(0);
      t.diagnostic(`runtime exception resolved to src/extension.ts:${line}:${column}`);
    }
    await manager.getByText('Close', {exact: true}).click();

    try {
      await expect.poll(() => page.evaluate(id => vm.extensionManager.isExtensionLoaded(id), otherInitial.id)).toBe(true);
    } catch (error) {
      t.diagnostic(JSON.stringify({activity, alerts, failures, body: (await page.locator('body').innerText()).slice(0, 3500)}));
      throw error;
    }
    const runMenu = page.getByRole('button', {name: 'Run view opening options'});
    if (await runMenu.count()) await runMenu.click();
    else await page.getByRole('button', {name: 'Stage display options'}).click();
    const [view] = await Promise.all([page.waitForEvent('popup', {timeout: 8000}),
      page.getByText('Open the test run view', {exact: true}).click({timeout: 6000})]);
    const result = view.locator('.twpe-test-run__test').filter({hasText: testName});
    await view.getByRole('button', {name: 'Run all'}).click();
    await expect(result).toHaveAttribute('data-status', 'failed');
    await expect(result.locator('code')).toHaveText(['"Hello, Scratch!"', '"Wrong, Scratch!"']);
    await expect(result.getByRole('button', {name: 'Show block'})).toHaveAttribute('data-block-id', assertId);

    const installed = (id = faulty.id) => page.evaluate(extensionId => {
      try {
        return JSON.parse(window.vm.toJSON(undefined, {allowOptimization: false}))
          .turboWarpPlus.extensions.find(entry => entry.id === extensionId)?.sha256;
      } catch (error) {
        if (error.code !== 'PROJECT_BUSY') throw error;
      }
    }, id);
    let corrected;
    let otherCorrected;
    let fixedAt;
    if (sourceMode) {
      await openManager();
      await fs.writeFile(sourcePath, faultySource + '\nconst = ;\n');
      await expect(firstRow.getByText('The standard TypeScript build failed. Check the template settings and source.')).toBeVisible();
      assert.equal(await installed(), faulty.sha256);
      fixedAt = performance.now();
      await Promise.all([fs.writeFile(sourcePath, correctedSource), fs.writeFile(path.join(otherFolder, 'src/extension.ts'), correctedSource)]);
      await expect.poll(() => latestBuilds.get(faulty.id)?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      await expect.poll(() => latestBuilds.get(otherInitial.id)?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      corrected = latestBuilds.get(faulty.id);
      otherCorrected = latestBuilds.get(otherInitial.id);
      await expect(firstRow.getByText('The standard TypeScript build failed. Check the template settings and source.')).toHaveCount(0);
      await manager.getByText('Close', {exact: true}).click();
      for (const directory of [folder, otherFolder]) {
        await assert.rejects(fs.access(path.join(directory, 'dist')), {code: 'ENOENT'});
        await assert.rejects(fs.access(path.join(directory, 'node_modules')), {code: 'ENOENT'});
      }
      t.diagnostic('the Desktop source worker applied both folders with no external Vite process or local dependencies');
    } else {
      const watch = spawn(process.execPath,
        [path.join(folder, 'node_modules/vite/bin/vite.js'), 'build', '--watch', '--mode', 'development'],
        {cwd: folder, stdio: ['ignore', 'pipe', 'pipe']});
      const exited = once(watch, 'exit');
      const stopWatch = () => { if (watch.exitCode === null && watch.signalCode === null) watch.kill(); };
      t.after(async () => { stopWatch(); await exited.catch(() => {}); });
      let watchOutput = '';
      for (const stream of [watch.stdout, watch.stderr]) stream.setEncoding('utf8').on('data', chunk => { watchOutput += chunk; });
      await expect.poll(() => watchOutput, {timeout: 10_000}).toContain('built in');
      const previousOutput = watchOutput.length;
      await fs.writeFile(sourcePath, faultySource + '\nconst = ;\n');
      await expect.poll(() => watchOutput.slice(previousOutput), {timeout: 10_000}).toMatch(/(?:Transform failed|Build failed)/iu);
      assert.match(watchOutput.slice(previousOutput), /src[\/]extension\.ts:\d+:\d+/u);
      assert.equal(await installed(), faulty.sha256);
      const failedBuildOutput = watchOutput.length;
      fixedAt = performance.now();
      await fs.writeFile(sourcePath, correctedSource);
      otherCorrected = await build(correctedSource, otherFolder);
      await expect.poll(() => watchOutput.slice(failedBuildOutput), {timeout: 10_000}).toContain('built in');
      corrected = await readDevelopmentBuild(await openDirectory(folder));
      stopWatch();
      await exited;
    }
    assert.notEqual(faulty.sha256, corrected.sha256);
    assert.equal(faulty.apiSHA256, corrected.apiSHA256);
    if (expectSourceMap) assert.match(corrected.sourceMapSHA256, /^[a-f0-9]{64}$/u);
    try {
      await expect.poll(installed, {timeout: 10_000}).toBe(corrected.sha256);
      t.diagnostic(`one local sample from TypeScript write to a detected live update: ${Math.round(performance.now() - fixedAt)} ms`);
      await expect.poll(() => installed(otherInitial.id)).toBe(otherCorrected.sha256);
    } catch (error) {
      t.diagnostic(JSON.stringify({activity, alerts, failures, installed: await installed(), expected: corrected.sha256}));
      throw error;
    }
    await expect(review).toHaveCount(0);
    assert.deepEqual(consent, [faulty.id, otherInitial.id].map(id => [id, sourceMode ? 'source' : 'artifact']));
    assert.equal(await page.evaluate(() => window.vm.runtime.getTargetForStage().variables.unsaved.value), 'unchanged');
    await view.getByRole('button', {name: 'Run all'}).click();
    await expect(result).toHaveAttribute('data-status', 'passed');
    assert.deepEqual(failures, []);
    assert.deepEqual(alerts, []);
    assert.equal(await installed(), corrected.sha256);
    t.diagnostic(`same assertion ${assertId}: "Wrong, Scratch!" failed, "Hello, Scratch!" passed`);

    await openManager();
    await expect(firstRow.getByRole('checkbox')).toBeChecked();
    await expect(secondRow.getByRole('checkbox')).toBeChecked();
    const activeBuild = firstRow.locator('code[title]');
    await expect(activeBuild).toHaveAttribute('title', corrected.sha256);
    if (expectRuntimeDiagnostic) {
      await page.evaluate(() => {
        window.vm.runtime.once('SAY', (_target, _type, message) => { window.developmentDiagnosticGreeting = message; });
        window.vm.greenFlag();
      });
      await expect.poll(() => page.evaluate(() => window.developmentDiagnosticGreeting)).toBe('Hello, diagnostic!');
      await expect(firstRow.getByText(/Extension block runtime error/u)).toHaveCount(0);
    }
    if (!sourceMode) {
      const markerPath = path.join(folder, 'dist', 'extension-development.json');
      const completedMarker = await fs.readFile(markerPath);
      await fs.writeFile(markerPath, '{');
      await expect(firstRow.getByRole('status')).toHaveText('Waiting for a complete and verified build.');
      await expect(activeBuild).toHaveAttribute('title', corrected.sha256);
      await fs.writeFile(markerPath, completedMarker);
      await expect(firstRow.getByRole('status')).toHaveCount(0);
    }
    await firstRow.getByRole('checkbox').uncheck();
    await expect(secondRow.getByRole('checkbox')).toBeChecked();
    const changedAgain = correctedSource.replace('Hello, {name}!', 'Hello again, {name}!');
    const [firstPaused, otherUpdated] = await Promise.all([build(changedAgain), build(changedAgain, otherFolder)]);
    await expect.poll(() => installed(otherInitial.id)).toBe(otherUpdated.sha256);
    assert.equal(await installed(), corrected.sha256);
    await firstRow.getByRole('checkbox').click();
    await expect(firstRow.getByRole('checkbox')).toBeChecked();
    await expect.poll(() => installed()).toBe(firstPaused.sha256);

    const incompatible = await build(correctedSource.replace('opcode: block.opcode,', 'opcode: `${block.opcode}Changed`, '));
    assert.notEqual(incompatible.sha256, corrected.sha256);
    assert.equal(incompatible.apiSHA256, corrected.apiSHA256);
    await expect(firstRow.getByRole('alert')).toHaveText('The new build could not be applied. The previous build is still active.');
    assert.equal(await installed(), firstPaused.sha256);
    await build(changedAgain);
    await expect(firstRow.getByRole('alert')).toHaveCount(0);
    await expect(activeBuild).toHaveAttribute('title', firstPaused.sha256);
    await expect(secondRow.getByRole('checkbox')).toBeChecked();
    assert.deepEqual(consent, [faulty.id, otherInitial.id].map(id => [id, sourceMode ? 'source' : 'artifact']));
    t.diagnostic('an incompatible registered opcode was rejected, and the corrected build was restored');

    await manager.getByText('Close', {exact: true}).click();
    await (await openDesktopMenu()).getByRole('menuitem', {name: 'Editor Add-on Development Folders…'}).click();
    const addons = page.getByRole('dialog', {name: 'Editor Add-on Development Folders'});
    await expect(addons.getByText('New builds are loaded from checked folders. The list shows changes that require reloading the editor.',
      {exact: true})).toBeVisible();
    const addAddon = addons.getByRole('button', {name: 'Add Development Folder…'});
    await addAddon.click();
    const turboCheckbox = addons.getByRole('checkbox', {name: 'Turbo Style'});
    await expect(turboCheckbox).toBeChecked();
    await addAddon.click();
    const plusCheckbox = addons.getByRole('checkbox', {name: 'Plus Style'});
    await expect(plusCheckbox).toBeChecked();
    const property = name => page.evaluate(key => getComputedStyle(document.body).getPropertyValue(key).trim(), name);
    await expect.poll(() => property('--turbo-style')).toBe('first');
    await turboCheckbox.click();
    await expect(turboCheckbox).not.toBeChecked();
    await expect.poll(() => property('--turbo-style')).toBe('');
    await fs.writeFile(path.join(plusFolder, 'main.css'), 'body { --plus-style: second; }');
    await expect.poll(() => property('--plus-style')).toBe('second');
    await fs.writeFile(path.join(plusFolder, 'main.css'), 'body { --plus-style: incomplete');
    await expect(addons.getByRole('alert')).toHaveText('The build output could not be verified. The last applied version is still active.');
    assert.equal(await property('--plus-style'), 'second');
    await turboCheckbox.click();
    await expect(turboCheckbox).toBeChecked();
    await expect.poll(() => property('--turbo-style')).toBe('first');
    await addons.getByText('Close', {exact: true}).click();

    const reopening = page.evaluate(bytes => window.vm.loadProject(new Uint8Array(bytes)).catch(() => {}), [...sb3]);
    await expect(review).toBeVisible();
    await review.getByText('Do not run', {exact: true}).click();
    await reopening;
  });
