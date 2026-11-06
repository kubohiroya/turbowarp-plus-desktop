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
  const buildInfo = require('../dist-renderer-webpack/editor/plus-gui/build-info.json');
  const editorRevision = execFileSync('git', ['-C', editor, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  assert.equal(buildInfo.editorRevision, editorRevision);
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
      const app = await _electron.launch({
        executablePath,
        cwd: repo,
        args: [path.join(__dirname, 'editor-popouts-app.js'), fixture],
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
        assert.equal(await window.evaluate(win => win.isVisible() || win.isFocused()), false);
        await verify(app, page);
      } finally {
        await app.close();
      }
    } finally {
      await fs.rm(profile, {recursive: true, force: true});
    }
  };

  await launch(false, async (app, page) => {
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
        return {nodeIntegration, contextIsolation, sandbox, webSecurity, visible: window.isVisible(), focused: window.isFocused()};
      }), {
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, visible: false, focused: false
      });
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

    const revealSprites = /Reveal sprite list|スプライト一覧を展開/;
    const list = await open('sprite-list', async () => {
      await reveal(revealSprites);
      await press(/^(Undock sprite list|アンドック)$/);
      await internalToExternal(/^(Sprite list|スプライト一覧)$/)();
    });
    await verifyChild('sprite-list', list);
    await list.close();

    await press(/Layout options|配置メニュー/);
    await click(page.getByRole('menuitemcheckbox', {name: /Show undock buttons|アンドックボタンを表示/}));
    const properties = await open('sprite-properties', async () => {
      await reveal(revealSprites);
      const toggle = button(/^(Sprite|スプライト)$/);
      await click(toggle);
      await press(openLabel, toggle.locator('..'));
      await internalToExternal(/^(Sprite|スプライト)$/)();
    });
    await verifyChild('sprite-properties', properties);
    await properties.close();

    const child = await open('code', async () => {
      await button(revealSprites).dispatchEvent('keydown', {key: 'Escape'});
      const tab = page.getByRole('tab', {name: /^(Code|コード)$/});
      await tab.focus();
      await press(openLabel);
    });
    await verifyChild('code', child);
    assert.deepEqual(await page.evaluate(tickets => tickets.map(ticket => EditorPreload.reservePopout('code', ticket)),
      [randomUUID(), randomUUID()]), [true, false]);
    await Promise.all([child.waitForEvent('close'), page.reload()]);
    assert.equal(app.windows().length, 1);
  });
});
