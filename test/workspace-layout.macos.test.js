const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {macosTestSkip} = require('./macos-test');

const eventually = async (label, read) => {
  const end = Date.now() + 30000;
  let cause;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { cause = error; }
    await delay(120);
  }
  throw new Error('Timed out: ' + label, {cause});
};

const provider = 'twpeyamlsettings';
const title = id => 'settings.yml (' + provider + ' / ' + id + ')';
const workspace = page => page.locator('[data-multi-view] .dockview-theme-light');
const tab = (page, name) => workspace(page).getByRole('tab', {name, exact: true});
const panel = (page, id) => workspace(page).locator('.tw-plus-document-slot[data-document-id="' + id + '"]');
const text = (page, id) => panel(page, id).locator('textarea');
const nativeLayout = page => page.evaluate(() => JSON.parse(EditorPreload.workspaceLayout.read() ?? 'null'));
const groups = page => workspace(page).locator('.dv-groupview').evaluateAll(nodes => nodes.map(node => {
  const tabs = Array.from(node.querySelectorAll('.dv-tab'));
  const {x, y, width, height} = node.getBoundingClientRect();
  return {
    order: tabs.map(tab => tab.getAttribute('aria-label')),
    selected: tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label'),
    active: node.classList.contains('dv-active-group'),
    bounds: [x, y, width, height].map(Math.round)
  };
}).sort((a, b) => a.order.join().localeCompare(b.order.join())));
const shape = data => data.map(({bounds, ...state}) => state);
const pins = {
  TW_PLUS_DESKTOP_PROJECT_ISOLATION: '1',
  TW_PLUS_DESKTOP_JSON_TRANSFER: '1',
  TW_PLUS_DESKTOP_ASSET_TRANSFER: '1',
  TW_PLUS_DESKTOP_EXTERNAL_YAML: '1',
  TW_PLUS_DESKTOP_WORKSPACE_LAYOUT: '1'
};

async function pinSprites (page) {
  const pin = page.getByRole('button', {name: /^(Pin sprite list|スプライト一覧を固定表示)$/});
  if (!await pin.isVisible()) await page.getByRole('button', {name: /^(Reveal sprite list|スプライト一覧を展開)$/}).hover();
  if (await pin.getAttribute('aria-pressed') === 'false') await pin.click();
}

async function openDocument (page, stage, id) {
  await tab(page, stage).click();
  const icon = page.locator('[data-twpe-yaml-hat-icon]').nth(id === 'settings' ? 0 : 1);
  await icon.waitFor();
  await icon.focus();
  await page.keyboard.press('Enter');
  await text(page, id).waitFor();
}

async function arrange (page, stage, split, edge) {
  const other = split === 'settings' ? 'labels' : 'settings';
  await openDocument(page, stage, split);
  await openDocument(page, stage, other);
  await tab(page, title(other)).dragTo(tab(page, stage), {targetPosition: {x: 14, y: 12}});
  await eventually('changed tab order', async () => (await groups(page)).some(group =>
    group.order.includes(title(other)) && group.order.indexOf(title(other)) < group.order.indexOf(stage)));
  await tab(page, title(split)).click();
  const surface = panel(page, split);
  const box = await surface.boundingBox();
  assert(box);
  await tab(page, title(split)).dragTo(surface, {targetPosition: edge === 'right' ?
    {x: box.width - 12, y: box.height / 2} : {x: box.width / 2, y: box.height - 12}});
  await eventually('two split groups', async () => (await groups(page)).length === 2);
  await tab(page, title(other)).click();
  await tab(page, title(split)).click();
  const before = await groups(page);
  const sash = workspace(page).locator('.dv-sash:visible').first();
  const rect = await sash.boundingBox();
  assert(rect);
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  assert.equal(rect.height > rect.width, edge === 'right');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (edge === 'right' ? 74 : 0), y + (edge === 'below' ? 59 : 0), {steps: 8});
  await page.mouse.up();
  const result = await eventually('resized split', async () => {
    const after = await groups(page);
    return JSON.stringify(after) !== JSON.stringify(before) ? after : null;
  });
  await eventually('layout on disk', async () => {
    const stored = await nativeLayout(page);
    return Object.values(stored?.panels ?? {}).filter(item => item.kind === 'document').length === 2;
  });
  return result;
}

test('Desktop saves two SB3s and restores each Dockview layout after restarting both project processes', {
  skip: macosTestSkip('TW_D6_TEST_APP', 'TW_D6_TEST_SB3', 'TW_D6_PLAYWRIGHT'),
  timeout: 190000
}, async t => {
  const {chromium} = require(process.env.TW_D6_PLAYWRIGHT);
  const zip = require(path.join(path.dirname(process.env.TW_D6_PLAYWRIGHT), '@turbowarp/jszip'));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-d6-workspace-'));
  const profile = path.join(work, 'data');
  const names = ['D6 Alpha.sb3', 'D6 Bravo.sb3'];
  const files = names.map(name => path.join(work, name));
  await Promise.all(files.map(file => fs.copyFile(process.env.TW_D6_TEST_SB3, file)));
  const logPath = path.join(work, 'electron.log');
  const log = await fs.open(logPath, 'a');
  const picker = path.join(work, 'picker.json');
  const binary = path.join(process.env.TW_D6_TEST_APP, 'Contents', 'MacOS', 'TurboWarp');
  const processes = new Set();
  const sessions = new Set();
  t.after(async () => {
    for (const browser of sessions) await browser.close().catch(() => {});
    for (const pid of processes) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await log.close();
  });

  async function start (inputs, enabled = true) {
    const broker = spawn(binary, ['--remote-debugging-port=0', ...inputs], {
      cwd: work, stdio: ['ignore', log.fd, log.fd], detached: true,
      env: {...process.env, ...pins, TW_PLUS_DESKTOP_WORKSPACE_LAYOUT: enabled ? '1' : '0',
        TW_PLUS_DESKTOP_DATA_DIR: profile, TW_D3_TEST_DIALOG_PATH: picker}
    });
    processes.add(broker.pid);
    const root = path.join(profile, 'project-processes');
    const ports = await eventually('two separate renderer profiles', async () => {
      const profiles = await fs.readdir(root);
      if (profiles.length !== 2) return null;
      return Promise.all(profiles.map(async name => {
        const [port] = (await fs.readFile(path.join(root, name, 'DevToolsActivePort'), 'utf8')).split('\n');
        return 'http://127.0.0.1:' + port;
      }));
    });
    const records = await Promise.all((await fs.readdir(path.join(profile, 'project-locks')))
      .filter(file => file.endsWith('.json')).map(async file =>
        JSON.parse(await fs.readFile(path.join(profile, 'project-locks', file), 'utf8'))));
    assert.equal(new Set(records.map(item => item.pid)).size, 2);
    const windows = await Promise.all(ports.map(async port => {
      const browser = await chromium.connectOverCDP(port);
      sessions.add(browser);
      const context = browser.contexts()[0];
      context.setDefaultTimeout(12000);
      const page = await eventually('native project window', () => context.pages().find(page => page.url().startsWith('tw-editor:')));
      const review = page.locator('.twextsec-review');
      await review.waitFor();
      const unsandboxed = review.locator('input[name="execution-all"][value="unsandboxed"]');
      if (await unsandboxed.count()) await unsandboxed.click();
      await review.getByTestId('twextsec-complete').click();
      await review.waitFor({state: 'hidden'});
      await page.waitForFunction(() => window.vm?.runtime.extensionStorage.twpeyamlsettings?.documents);
      assert.equal(await page.evaluate(() => Boolean(EditorPreload.workspaceLayout)), enabled);
      const name = await page.evaluate(() => EditorPreload.getInitialFile().then(id => EditorPreload.getFile(id)).then(file => file.name));
      return {name, page, browser};
    }));
    return {broker, windows, pids: records.map(item => item.pid)};
  }

  async function stop ({broker, windows}) {
    for (const {page} of windows) await page.close();
    await eventually('workers closed and released both locks', async () =>
      !(await fs.readdir(path.join(profile, 'project-locks'))).some(file => file.endsWith('.json')));
    for (const {browser} of windows) {
      await browser.close().catch(() => {});
      sessions.delete(browser);
    }
    const exited = once(broker, 'exit');
    broker.kill('SIGTERM');
    await exited;
    processes.delete(broker.pid);
  }

  async function edit (page, value) {
    await page.bringToFront();
    await pinSprites(page);
    await page.getByRole('button', {name: /^(Backdrops|背景)$/}).click();
    const stage = await page.evaluate(() => vm.editingTarget.getName());
    await openDocument(page, stage, 'settings');
    await text(page, 'settings').fill(value);
    return stage;
  }

  async function save (page, name, value, file) {
    await page.bringToFront();
    await panel(page, 'settings').locator('.twpe-yaml-save').click();
    await panel(page, 'settings').waitFor({state: 'detached'});
    await page.getByText(/^(File|ファイル)$/, {exact: true}).first().click();
    const save = page.locator('[data-file-menu-icon="save"]').locator('..');
    assert((await save.textContent()).includes(name));
    await save.click();
    await eventually('the actual SB3 was saved with its own YAML', async () => {
      const archive = await zip.loadAsync(await fs.readFile(file));
      const json = JSON.parse(await archive.file('project.json').async('string'));
      return json.extensionStorage.twpeyamlsettings.documents.settings === value;
    });
  }

  const expectedValues = ['volume: 35\nmode: rehearsal\n', 'volume: 65\nmode: production\n'];
  try {
    const first = await start(files);
    const page = (run, index) => run.windows.find(item => item.name === names[index]).page;
    const A = page(first, 0), B = page(first, 1);
    const stageA = await edit(A, expectedValues[0]);
    const stageB = await edit(B, expectedValues[1]);
    assert.equal(await text(A, 'settings').inputValue(), expectedValues[0]);
    assert.equal(await text(B, 'settings').inputValue(), expectedValues[1]);
    await save(A, names[0], expectedValues[0], files[0]);
    await save(B, names[1], expectedValues[1], files[1]);
    t.diagnostic('Two simultaneous, independent edits were saved through the Editor File menu and verified inside each SB3.');
    await A.bringToFront();
    const layoutA = await arrange(A, stageA, 'settings', 'right');
    await B.bringToFront();
    const layoutB = await arrange(B, stageB, 'labels', 'below');
    assert.notDeepEqual(shape(layoutA), shape(layoutB));
    const external = path.join(work, 'external.yml');
    await fs.writeFile(external, 'kind: external\n');
    await fs.writeFile(picker, JSON.stringify({open: external}));
    await A.bringToFront();
    await A.getByText(/^(File|ファイル)$/, {exact: true}).first().click();
    await A.getByText(/^(Open external YAML file…|外部YAMLファイルを開く…)$/, {exact: true}).click();
    await panel(A, 1).locator('textarea').waitFor();
    assert.equal(await panel(A, 1).locator('textarea').inputValue(), 'kind: external\n');
    const stored = await Promise.all([nativeLayout(A), nativeLayout(B)]);
    assert.notDeepEqual(stored[0].grid.root, stored[1].grid.root);
    assert(!Object.values(stored[0].panels).some(item => item.providerId === 'file'));
    assert.equal((await fs.readdir(path.join(profile, 'workspace-layouts'))).filter(file => file.endsWith('.json')).length, 2);
    await stop(first);

    const reopened = await start([...files].reverse());
    assert(reopened.pids.every(pid => !first.pids.includes(pid)));
    for (const [index, baseline] of [layoutA, layoutB].entries()) {
      const current = page(reopened, index);
      await current.bringToFront();
      await eventually('same tabs, order, and selected group', async () =>
        JSON.stringify(shape(await groups(current))) === JSON.stringify(shape(baseline)));
      await pinSprites(current);
      await eventually('same split geometry', async () => {
        const actual = await groups(current);
        return actual.length === baseline.length && actual.every((group, i) =>
          group.bounds.every((value, dimension) => Math.abs(value - baseline[i].bounds[dimension]) <= 2));
      });
      assert.equal(await current.evaluate(() => vm.runtime.extensionStorage.twpeyamlsettings.documents.settings), expectedValues[index]);
      assert.equal(await workspace(current).locator('[data-provider-id="file"]').count(), 0);
      t.diagnostic(JSON.stringify({project: names[index], before: baseline, restored: await groups(current)}));
    }
    await stop(reopened);

    const rollback = await start(files, false);
    for (const {page} of rollback.windows) {
      await workspace(page).waitFor();
      assert.equal(await page.evaluate(() => Boolean(EditorPreload.externalYaml)), true);
      assert.equal(await workspace(page).locator('.tw-plus-document-slot').count(), 0);
    }
    assert.equal((await fs.readdir(path.join(profile, 'workspace-layouts'))).filter(file => file.endsWith('.json')).length, 2);
    t.diagnostic('External YAML stayed closed on restart. Disabling D6 kept D5 available and did not restore saved layouts.');
    await stop(rollback);
  } catch (error) {
    t.diagnostic((await fs.readFile(logPath, 'utf8')).slice(-5000));
    throw error;
  }
});
