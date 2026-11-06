const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const {createRequire} = require('node:module');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');

const editor = process.env.TW_PLUS_TEST_EDITOR_CHECKOUT;
const fixture = process.env.TW_PLUS_TEST_SB3;
const repo = path.resolve(__dirname, '..');
const windowRoute = /\/plus-gui\/backpack-popout\.html#[0-9a-f-]+$/;

const opens = (page, kind, url = 'about:blank') => page.evaluate(
  ({name, url}) => window.open(url, name) !== null,
  {name: `tw-plus-${kind}-${randomUUID()}`, url}
);

test('the Backpack opens only through a reservation and the child has isolated window controls', {
  skip: process.platform !== 'darwin' || !editor || !fixture,
  timeout: 65000
}, async () => {
  const {_electron} = createRequire(path.join(editor, 'package.json'))('playwright');
  const executablePath = process.env.TW_PLUS_TEST_ELECTRON || require('electron');
  const launch = async (popout, verify) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-backpack-popout-'));
    try {
      const app = await _electron.launch({
        executablePath,
        cwd: repo,
        args: [path.join(repo, 'src-main/entrypoint.js'), fixture],
        env: {
          ...process.env,
          TW_PLUS_DESKTOP_DATA_DIR: profile,
          TW_PLUS_DESKTOP_RENDERER: '1',
          TW_PLUS_DESKTOP_PROJECT_ISOLATION: '0',
          TW_PLUS_DESKTOP_BACKPACK_POPOUT: popout ? '1' : '0'
        }
      });
      try {
        const page = await app.firstWindow();
        page.setDefaultTimeout(8000);
        await page.waitForFunction(() => window.ReduxStore?.getState().scratchGui.vm.runtime.targets
          .some(target => target.getName() === 'Sprite1'));
        await verify(app, page);
      } finally {
        await app.close();
      }
    } finally {
      await fs.rm(profile, {recursive: true, force: true});
    }
  };

  await launch(false, async (app, page) => {
    assert.equal(await page.evaluate(() => typeof EditorPreload.reserveBackpackPopout), 'undefined');
    assert.equal(await opens(page, 'backpack'), false);
    assert.equal(app.windows().length, 1);
  });

  await launch(true, async (app, page) => {
    assert.equal(await opens(page, 'backpack'), false);
    assert.equal(await opens(page, 'stage'), false);
    assert.equal(await opens(page, 'backpack', 'tw-editor://./plus-gui/backpack-popout.html'), false);
    assert.equal(await page.evaluate(() => EditorPreload.reserveBackpackPopout('invalid')), false);
    const frameURL = 'data:text/html,isolated-frame';
    await page.evaluate(url => {
      const frame = document.createElement('iframe');
      frame.src = url;
      document.body.append(frame);
    }, frameURL);
    await page.frameLocator(`iframe[src="${frameURL}"]`).locator('body').waitFor();
    const frame = page.frames().find(item => item.url() === frameURL);
    assert.equal(await frame.evaluate(() => typeof window.EditorPreload), 'undefined');
    assert.equal(await opens(frame, 'backpack'), false);

    await page.getByRole('button', {name: /Reveal Backpack|バックパックを展開/}).press('Enter');
    await page.getByRole('button', {name: /Undock Backpack|バックパックを別画面で開く/}).press('Enter');
    const titleBar = page.locator('.tw-window-titlebar').filter({hasText: /Backpack|バックパック/});
    await titleBar.getByRole('button', {name: /Window layout|レイアウト変更/}).press('Enter');
    const [child] = await Promise.all([
      app.waitForEvent('window', {timeout: 10000}),
      page.getByRole('button', {name: /Open in a separate window|別窓で開く/}).press('Enter')
    ]);
    await child.waitForURL(windowRoute, {timeout: 10000});
    await child.waitForFunction(() => window.opener === null && document.querySelector('#mount')?.children.length);
    assert.deepEqual(await child.evaluate(() => ({
      node: typeof window.require,
      process: typeof window.process,
      editor: typeof window.EditorPreload,
      ipc: typeof window.ipcRenderer,
      controls: Object.keys(window.TwPlusWindowControls).sort()
    })), {node: 'undefined', process: 'undefined', editor: 'undefined', ipc: 'undefined',
      controls: ['change', 'mode', 'onMode']});
    const childWindow = await app.browserWindow(child);
    assert.deepEqual(await childWindow.evaluate(window => {
      const {nodeIntegration, contextIsolation, sandbox, webSecurity} = window.webContents.getLastWebPreferences();
      return {nodeIntegration, contextIsolation, sandbox, webSecurity};
    }), {nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true});
    const ticket = new URL(child.url()).hash.slice(1);
    assert.equal(await page.evaluate(value => window.open('about:blank', 'tw-plus-backpack-' + value) !== null, ticket), false);
    assert.equal(await child.evaluate(() => window.open('about:blank') !== null), false);
    assert.equal(await child.evaluate(() => TwPlusWindowControls.change('close')), undefined);
    await child.evaluate(() => TwPlusWindowControls.change('maximize'));
    await child.waitForFunction(async () => await TwPlusWindowControls.mode() === 'maximized');
    await child.evaluate(() => TwPlusWindowControls.change('restore'));
    await child.waitForFunction(async () => await TwPlusWindowControls.mode() === 'normal');
    await child.evaluate(() => TwPlusWindowControls.change('minimize'));
    await child.waitForFunction(async () => await TwPlusWindowControls.mode() === 'minimized', null, {polling: 100});
    await child.evaluate(() => TwPlusWindowControls.change('restore'));
    await child.waitForFunction(async () => await TwPlusWindowControls.mode() === 'normal', null, {polling: 100});
    await childWindow.evaluate(window => {
      globalThis.blockedChildNavigation = new Promise(resolve => {
        const timeout = setTimeout(() => resolve(false), 4000);
        window.webContents.once('will-navigate', event => {
          clearTimeout(timeout);
          resolve(event.defaultPrevented);
        });
      });
    });
    await child.evaluate(() => { location.href = 'tw-editor://./plus-gui/gui.html'; });
    assert.equal(await app.evaluate(() => globalThis.blockedChildNavigation), true);
    await Promise.all([child.waitForEvent('close'), page.reload()]);
    assert.equal(app.windows().length, 1);
  });
});
