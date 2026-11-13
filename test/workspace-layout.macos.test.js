const assert = require('node:assert/strict');
const {execFileSync, spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const {createRequire} = require('node:module');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');

const editor = process.env.TW_PLUS_TEST_EDITOR_CHECKOUT;
const fixture = process.env.TW_PLUS_TEST_SB3;
const repo = path.resolve(__dirname, '..');
const groups = page => page.locator('[data-workspace-layout] .dv-groupview');
const tab = (page, name) => groups(page).getByRole('tab', {name, exact: true});
const readLayout = page => groups(page).evaluateAll(nodes => nodes.map(node => {
  const {x, y, width, height} = node.getBoundingClientRect();
  const tabs = [...node.querySelectorAll('.dv-tab')];
  return {
    order: tabs.map(item => item.getAttribute('aria-label')),
    selected: tabs.find(item => item.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label'),
    bounds: [x, y, width, height].map(Math.round)
  };
}));
const storedLayout = (page, key) => page.evaluate(key => EditorPreload.workspaceLayouts.read(key), key);

test('restores separate Dockview layouts when the Desktop project processes restart', {
  skip: process.platform !== 'darwin' || !editor || !fixture,
  timeout: 120000
}, async t => {
  const revision = directory => execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  const pin = require('../config/plus-renderer.json').editorRevision;
  const build = require('../dist-renderer-webpack/editor/plus-gui/build-info.json');
  assert.equal(pin, revision(editor));
  assert.equal(build.editorRevision, pin);
  assert.equal(build.desktopRevision, revision(repo));
  const editorRequire = createRequire(path.join(editor, 'package.json'));
  const {chromium, expect} = editorRequire('@playwright/test');
  const Zip = editorRequire('@turbowarp/jszip');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-desktop-workspace-'));
  const profile = path.join(root, 'profile');
  const profiles = path.join(profile, 'project-processes');
  const log = await fs.open(path.join(root, 'electron.log'), 'a');
  t.diagnostic(JSON.stringify({platform: os.platform(), os: os.release(), arch: os.arch(), root,
    desktop: build.desktopRevision, editor: pin, workbench: build.editorWorkbench.version, electron: build.electronVersion}));
  t.after(() => log.close());

  // Use identical project contents and file names to exercise the Desktop file identity.
  const archive = await Zip.loadAsync(await fs.readFile(fixture));
  const project = JSON.parse(await archive.file('project.json').async('string'));
  assert.equal(project.extensions?.length ?? 0, 0);
  const sprite = project.targets.find(item => !item.isStage);
  assert(sprite);
  project.targets = [project.targets.find(item => item.isStage),
    ...['Alpha', 'Beta', 'Gamma'].map((name, layerOrder) => ({...sprite, name, layerOrder: layerOrder + 1}))];
  archive.file('project.json', JSON.stringify(project));
  const bytes = await archive.generateAsync({type: 'nodebuffer'});
  const files = await Promise.all(['A', 'B'].map(async name => {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    const file = path.join(directory, 'Workspace.sb3');
    await fs.writeFile(file, bytes);
    return file;
  }));
  const keys = files.map(require('../src-main/workspace-project-key').workspaceProjectKey);
  assert.notEqual(keys[0], keys[1]);

  async function run (inputs, inspect) {
    const broker = spawn(require('electron'), [
      path.join(__dirname, 'editor-popouts-app.js'), '--remote-debugging-port=0', ...inputs
    ], {cwd: repo, detached: true, stdio: ['ignore', log.fd, log.fd], env: {...process.env,
      TW_PLUS_DESKTOP_DATA_DIR: profile, TW_PLUS_DESKTOP_RENDERER: '1',
      TW_PLUS_DESKTOP_PROJECT_ISOLATION: '1', TW_PLUS_DESKTOP_EXTERNAL_YAML: '1'}});
    const exited = once(broker, 'exit');
    const browsers = [];
    try {
      const endpoints = new Map();
      await expect.poll(async () => {
        for (const worker of await fs.readdir(profiles).catch(() => [])) {
          const port = (await fs.readFile(path.join(profiles, worker, 'DevToolsActivePort'), 'utf8')
            .catch(() => '')).split('\n')[0];
          if (/^\d+$/.test(port)) endpoints.set(worker, 'http://127.0.0.1:' + port);
        }
        return endpoints.size;
      }, {timeout: 30000}).toBe(2);
      const windows = new Map();
      for (const endpoint of endpoints.values()) {
        const browser = await chromium.connectOverCDP(endpoint, {timeout: 10000});
        browsers.push(browser);
        const context = browser.contexts()[0];
        const editorPage = () => context.pages().find(candidate => candidate.url().includes('/plus-gui/'));
        await expect.poll(() => editorPage()?.url(), {timeout: 15000}).toContain('/plus-gui/');
        const page = editorPage();
        page.setDefaultTimeout(8000);
        assert(page);
        await expect(tab(page, 'Gamma')).toBeVisible({timeout: 20000});
        await expect(page.locator('[data-workspace-layout]')).toHaveAttribute('data-workspace-layout', 'settled');
        const actual = await page.evaluate(async () => ({
          build: await (await fetch('build-info.json')).json(),
          key: EditorPreload.workspaceProjectKey(await EditorPreload.getInitialFile())
        }));
        assert.equal(actual.build.editorRevision, pin);
        assert.equal(actual.build.desktopRevision, build.desktopRevision);
        assert.equal(actual.build.editorWorkbench.version, build.editorWorkbench.version);
        assert(keys.includes(actual.key));
        windows.set(actual.key, page);
      }
      assert.equal(windows.size, 2);
      await inspect(windows);
      await Promise.all([...windows.values()].map(page => page.close()));
      await expect.poll(() => fs.readdir(profiles), {timeout: 15000}).toEqual([]);
    } finally {
      for (const browser of browsers) await browser.close().catch(() => {});
      if (broker.exitCode === null && broker.signalCode === null) {
        try { process.kill(-broker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await exited;
    }
  }

  async function arrange (page, key, moved, anchor, selected, direction) {
    const initial = await readLayout(page);
    await expect(groups(page)).toHaveCount(1);
    const target = tab(page, anchor);
    const tabBounds = await target.boundingBox();
    assert(tabBounds);
    await tab(page, moved).dragTo(target, {targetPosition: {x: tabBounds.width / 3, y: tabBounds.height / 2}});
    await expect.poll(async () => (await readLayout(page))[0].order).not.toEqual(initial[0].order);
    await expect(groups(page)).toHaveCount(1);
    await tab(page, selected).click();
    await expect(tab(page, selected)).toHaveAttribute('aria-selected', 'true');
    await groups(page).first().getByRole('button', {name: /Editor panel layout|編集パネルのレイアウト/})
      .dispatchEvent('click');
    await page.getByRole('menuitem', {name: direction}).dispatchEvent('click');
    await expect(groups(page)).toHaveCount(2);
    const split = await readLayout(page);
    const sash = await page.locator('[data-workspace-layout] .dv-sash:visible').first().boundingBox();
    assert(sash);
    const x = sash.x + sash.width / 2, y = sash.y + sash.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (sash.height > sash.width ? 67 : 0), y + (sash.width > sash.height ? 43 : 0), {steps: 8});
    await page.mouse.up();
    await expect.poll(() => readLayout(page)).not.toEqual(split);
    await expect(page.locator('[data-workspace-layout]')).toHaveAttribute('data-workspace-layout', 'settled');
    assert.equal(JSON.parse(await storedLayout(page, key)).version, 1);
    return readLayout(page);
  }

  const saved = [];
  await run(files, async windows => {
    saved.push(await arrange(windows.get(keys[0]), keys[0], 'Gamma', 'Beta', 'Alpha', /^(Split right|パネルを横に分割)$/));
    saved.push(await arrange(windows.get(keys[1]), keys[1], 'Alpha', 'Gamma', 'Beta', /^(Split below|パネルを縦に分割)$/));
    assert.notDeepEqual(saved[0], saved[1]);
    const first = windows.get(keys[0]);
    await assert.rejects(storedLayout(first, keys[1]), /No project lock for this layout/);
    await assert.rejects(first.evaluate(key => EditorPreload.workspaceLayouts.write(key, '{}'), keys[1]),
      /No project lock for this layout/);
    for (const [index, key] of keys.entries()) {
      const page = windows.get(key);
      await page.reload();
      await expect(page.locator('[data-workspace-layout]')).toHaveAttribute('data-workspace-layout', 'settled');
      await expect.poll(() => readLayout(page)).toEqual(saved[index]);
    }
    t.diagnostic('Both layouts survived a renderer reload in the same project process.');
  });
  let restored;
  await run([...files].reverse(), async windows => {
    restored = await Promise.all(keys.map(key => readLayout(windows.get(key))));
    for (const key of keys) assert.equal(JSON.parse(await storedLayout(windows.get(key), key)).version, 1);
  });
  t.diagnostic(JSON.stringify({saved, restored}));
  assert.deepEqual(restored, saved);
});
