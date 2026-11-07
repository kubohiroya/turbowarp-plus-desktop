const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const {createRequire} = require('node:module');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');

const editor = process.env.TW_PLUS_TEST_EDITOR_CHECKOUT;
const fixture = process.env.TW_PLUS_TEST_SB3;
const headed = process.env.TW_PLUS_TEST_SHOW_WINDOWS === '1';
const repo = path.resolve(__dirname, '..');
const kinds = ['backpack', 'stage', 'sprite-list', 'sprite-properties', 'code'];
const layoutLabel = /^(Window layout|レイアウト変更)$/;
const separateLabel = /Open in a separate window|別窓で開く|別ウィンドウで開く/;
const openLabel = /^(Open in another window|別画面で開く)$/;
const flags = ['BACKPACK', 'STAGE', 'TARGET_PANELS', 'CODE'];

const opens = (page, kind, url = 'about:blank') => page.evaluate(
  ({name, url}) => window.open(url, name) !== null,
  {name: `tw-plus-${kind}-${randomUUID()}`, url}
);

test('editor popouts require a reservation and isolate each child', {
  skip: process.platform !== 'darwin' || !editor || !fixture,
  timeout: 90000
}, async t => {
  const editorRevision = process.env.E2E_EXPECT_SITE_REVISION;
  assert.match(editorRevision || '', /^[a-f0-9]{40}$/, 'Set E2E_EXPECT_SITE_REVISION to a full Editor SHA');
  const renderer = path.join(repo, 'dist-renderer-webpack/editor/plus-gui/build-info.json');
  let buildInfo;
  try {
    buildInfo = JSON.parse(await fs.readFile(renderer, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot verify Editor revision at ${renderer}: expected ${editorRevision}, actual unavailable`, {cause: error});
  }
  const evidence = `Editor revision at ${renderer}: expected ${editorRevision}, actual ${buildInfo?.editorRevision ?? 'missing'}`;
  assert.equal(buildInfo?.editorRevision, editorRevision, evidence);
  assert.equal(require('../config/plus-renderer.json').editorRevision, editorRevision,
    'Desktop renderer pin differs from the expected Editor revision');
  const checkoutRevision = execFileSync('git', ['-C', editor, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  assert.equal(checkoutRevision, editorRevision, 'Editor checkout differs from the expected Editor revision');
  t.diagnostic(evidence);
  const {_electron} = createRequire(path.join(editor, 'package.json'))('playwright');
  const executablePath = process.env.TW_PLUS_TEST_ELECTRON || require('electron');
  const launch = async (popout, verify) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-editor-popouts-'));
    try {
      const env = {
        ...process.env,
        TW_PLUS_DESKTOP_DATA_DIR: profile,
        TW_PLUS_DESKTOP_RENDERER: '1',
        TW_PLUS_DESKTOP_PROJECT_ISOLATION: '0'
      };
      for (const flag of flags) {
        const key = `TW_PLUS_DESKTOP_${flag}_POPOUT`;
        if (popout) env[key] = '1';
        else delete env[key];
      }
      const entrypoint = headed ? path.join(repo, 'src-main/entrypoint.js') : path.join(__dirname, 'editor-popouts-app.js');
      const app = await _electron.launch({
        executablePath,
        cwd: repo,
        args: [entrypoint, fixture],
        env
      });
      try {
        const page = await app.firstWindow();
        page.setDefaultTimeout(8000);
        await page.waitForFunction(() => window.ReduxStore?.getState().scratchGui.vm.runtime.targets
          .some(target => target.getName() === 'Sprite1'));
        assert.equal(await app.evaluate(() => process.versions.electron), buildInfo.electronVersion);
        const servedRevision = await page.evaluate(async () => (await (await fetch('build-info.json')).json()).editorRevision);
        assert.equal(servedRevision, editorRevision);
        const window = await app.browserWindow(page);
        assert.equal(await window.evaluate(win => win.isVisible()), headed);
        if (!headed) assert.equal(await window.evaluate(win => win.isFocused()), false);
        await verify(app, page);
      } finally {
        await app.close();
      }
    } finally {
      await fs.rm(profile, {recursive: true, force: true});
    }
  };

  await launch(false, async (app, page) => {
    const pin = page.getByRole('button', {name: /^(Pin sprite list|スプライト一覧を固定表示)$/});
    await pin.waitFor({state: 'visible'});
    assert.equal(await pin.getAttribute('aria-pressed'), 'true');
    await page.locator('[data-backdrop-placement] img').first().waitFor({state: 'visible'});
    await page.getByRole('button', {name: /^(Reveal sprite list|スプライト一覧を展開)$/}).waitFor({state: 'hidden'});
    assert.equal(await page.evaluate(() => typeof EditorPreload.reservePopout), 'undefined');
    for (const kind of kinds) assert.equal(await opens(page, kind), false);
    assert.equal(app.windows().length, 1);
  });

  await launch(true, async (app, page) => {
    for (const kind of kinds) assert.equal(await opens(page, kind), false);
    assert.equal(await page.evaluate(() => EditorPreload.reservePopout('backpack', 'invalid')), false);
    const ticket = randomUUID();
    assert.deepEqual(await page.evaluate(value => [
      EditorPreload.reservePopout('unknown', value),
      EditorPreload.reservePopout('backpack', value),
      window.open('about:blank', 'tw-plus-stage-' + value) !== null,
      window.open('tw-editor://./plus-gui/backpack-popout.html', 'tw-plus-backpack-' + value) !== null
    ], ticket), [false, true, false, false]);
    await page.reload();
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

    const button = (name, within = page) => within.getByRole('button', {name});
    const click = locator => locator.dispatchEvent('click');
    const press = (name, within = page) => click(button(name, within));
    const reveal = async name => {
      const trigger = button(name);
      await click(trigger);
      // The drawer focuses its panel on the next frame. Wait before opening its menu.
      await trigger.locator('xpath=following-sibling::*[1]').and(page.locator(':focus')).waitFor({state: 'attached'});
    };
    const internalToExternal = title => async () => {
      const panel = page.getByRole('region', {name: title});
      await press(layoutLabel, panel);
      await press(separateLabel, panel);
    };
    const open = async (kind, action) => {
      t.diagnostic(`Opening ${kind}`);
      const [child] = await Promise.all([app.waitForEvent('window', {timeout: 15000}), action()]);
      await child.waitForURL(new RegExp(`/plus-gui/${kind}-popout\\.html#[0-9a-f-]+$`), {timeout: 12000});
      await child.waitForFunction(() => window.opener === null && document.querySelector('#mount')?.children.length);
      return child;
    };
    const focusWindow = async (target, browserWindow) => {
      await browserWindow.evaluate(window => {
        window.focus();
        window.webContents.focus();
      });
      await target.waitForFunction(() => document.hasFocus(), null, {polling: 100});
      assert.equal(await browserWindow.evaluate(window => window.isFocused()), true);
    };
    const verifyWindowControls = async (child, childWindow) => {
      await child.waitForFunction(() => document.hasFocus(), null, {polling: 100});
      assert.equal(await childWindow.evaluate(window => window.isFocused()), true);
      await focusWindow(page, await app.browserWindow(page));
      assert.equal(await childWindow.evaluate(window => window.isFocused()), false);
      await focusWindow(child, childWindow);

      const change = async (action, event, mode) => {
        await childWindow.evaluate((window, event) => {
          globalThis.popoutWindowState = new Promise(resolve => {
            const timeout = setTimeout(() => resolve(null), 4000);
            window.once(event, () => {
              clearTimeout(timeout);
              resolve([window.isMaximized(), window.isMinimized()]);
            });
          });
        }, event);
        await child.evaluate(action => TwPlusWindowControls.change(action), action);
        assert.deepEqual(await app.evaluate(() => globalThis.popoutWindowState),
          [mode === 'maximized', mode === 'minimized'], `Native state after ${event}`);
      };
      await change('maximize', 'maximize', 'maximized');
      await change('restore', 'unmaximize', 'normal');
      await change('minimize', 'minimize', 'minimized');
      await change('restore', 'restore', 'normal');
      assert.equal(await childWindow.evaluate(window => window.isVisible()), true);
    };
    const verifyChild = async (kind, child) => {
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
        return {nodeIntegration, contextIsolation, sandbox, webSecurity, visible: window.isVisible()};
      }), {
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, visible: headed
      });
      if (headed) {
        await verifyWindowControls(child, childWindow);
      } else {
        assert.equal(await childWindow.evaluate(window => window.isFocused()), false);
      }
      const ticket = new URL(child.url()).hash.slice(1);
      assert.equal(await page.evaluate(name => window.open('about:blank', name) !== null, `tw-plus-${kind}-${ticket}`), false);
      assert.equal(await child.evaluate(() => window.open('about:blank') !== null), false);
      assert.equal(await child.evaluate(() => TwPlusWindowControls.change('close')), undefined);
      assert.equal(await child.evaluate(() => TwPlusWindowControls.mode()), 'normal');
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
    };

    await press(/Layout options|配置メニュー/);
    await click(page.getByRole('menuitemcheckbox', {name: /Show undock buttons|アンドックボタンを表示/}));

    const backpack = await open('backpack', async () => {
      await press(/Reveal Backpack|バックパックを展開/);
      await press(/Undock Backpack|バックパックを別画面で開く/);
      await internalToExternal(/^(Backpack|バックパック)$/)();
    });
    await verifyChild('backpack', backpack);
    await backpack.close();

    const stage = await open('stage', async () => {
      const displayLabel = /^(Stage display|ステージの表示)$/;
      await reveal(/Reveal stage|ステージを展開/);
      await press(displayLabel);
      await click(page.getByRole('menu', {name: displayLabel}).getByRole('menuitem', {name: separateLabel}));
    });
    await verifyChild('stage', stage);
    await stage.close();

    const list = await open('sprite-list', async () => {
      await press(/^(Undock sprite list|アンドック)$/);
      await internalToExternal(/^(Sprite list|スプライト一覧)$/)();
    });
    await verifyChild('sprite-list', list);
    await list.close();

    const properties = await open('sprite-properties', async () => {
      const toggle = button(/^(Sprite|スプライト)$/);
      await click(toggle);
      await press(openLabel, toggle.locator('..'));
      await internalToExternal(/^(Sprite|スプライト)$/)();
    });
    await verifyChild('sprite-properties', properties);
    await properties.close();

    const child = await open('code', async () => {
      const tab = page.getByRole('tab', {name: /^(Code|コード)$/});
      await tab.focus();
      await press(openLabel, page.getByRole('tabpanel', {name: 'Sprite1', exact: true}));
    });
    await verifyChild('code', child);
    if (headed) {
      await focusWindow(child, await app.browserWindow(child));
      const duplicate = target => target.getByRole('menuitem', {
        name: /^(Open another view of this editor|この編集画面をもう一枚開く（別のビューを開く）)$/
      });
      await child.waitForFunction(() => Boolean(document.querySelector('#code-target')?.value));
      const target = await child.locator('#code-target').inputValue();
      const second = await open('code', async () => {
        await press(layoutLabel, child);
        assert.equal(await duplicate(child).isEnabled(), true);
        await click(duplicate(child));
      });
      assert.notEqual(second.url(), child.url());
      await second.waitForFunction(target => document.querySelector('#code-target')?.value === target, target);
      await verifyChild('code', second);
      await press(layoutLabel, second);
      assert.equal(await duplicate(second).isDisabled(), true);
      assert.equal(await page.evaluate(ticket => EditorPreload.reservePopout('code', ticket), randomUUID()), false);
      const dock = second.getByRole('menuitem', {name: /Return to the editor|元の画面に戻す/});
      await Promise.all([second.waitForEvent('close'), click(dock)]);
      await focusWindow(child, await app.browserWindow(child));
      await press(layoutLabel, child);
      assert.equal(await duplicate(child).isEnabled(), true);
    } else {
      assert.deepEqual(await page.evaluate(tickets => tickets.map(ticket => EditorPreload.reservePopout('code', ticket)),
        [randomUUID(), randomUUID()]), [true, false]);
    }
    await Promise.all([
      page.waitForEvent('framenavigated', frame => frame === page.mainFrame()),
      page.evaluate(() => history.pushState('modal-state', '', location.href))
    ]);
    assert.equal(await child.evaluate(() => Boolean(document.querySelector('#mount')?.children.length)), true);
    await Promise.all([child.waitForEvent('close'), page.reload()]);
    assert.equal(app.windows().length, 1);
  });
});
