const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs/promises');
const {createRequire} = require('node:module');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {setTimeout: delay} = require('node:timers/promises');
const {macosTestSkip} = require('./macos-test');

const repo = path.resolve(__dirname, '..');
// Git CLI must not refresh .git/index while the panel writes it: the panel would rightly report a change.
const gitEnv = {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
const eventually = async (label, read, ms = 30000) => {
  const end = Date.now() + ms;
  let cause;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { cause = error; }
    await delay(250);
  }
  throw new Error('Timed out: ' + label, {cause});
};

const skip = macosTestSkip('TW_PLUS_TEST_EDITOR_CHECKOUT');

test('the Plus renderer stages, commits and switches branches like Git CLI', {skip, timeout: 180000}, async t => {
  const editor = process.env.TW_PLUS_TEST_EDITOR_CHECKOUT;
  const buildInfo = JSON.parse(await fs.readFile(path.join(repo, 'dist-renderer-webpack/editor/plus-gui/build-info.json'), 'utf8'));
  assert.equal(buildInfo.editorRevision, require('../config/plus-renderer.json').editorRevision,
    'Build the Plus renderer from the pinned Editor with npm run webpack:plus');
  t.diagnostic(`Editor ${buildInfo.editorRevision}, Workbench ${buildInfo.editorWorkbench?.version}`);
  const {_electron} = createRequire(path.join(editor, 'package.json'))('playwright');

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-local-git-'));
  const worktree = path.join(work, 'repo');
  const git = (...args) => execFileSync('git', args, {cwd: worktree, encoding: 'utf8', env: gitEnv}).replace(/\n$/, '');
  try {
    await fs.mkdir(worktree);
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Desktop Local Git');
    git('config', 'user.email', 'desktop-local-git@example.invalid');
    await fs.writeFile(path.join(worktree, 'README.md'), '# Local Git\n');
    git('add', 'README.md');
    git('commit', '--quiet', '-m', 'Initial commit');
    const configBefore = await fs.readFile(path.join(worktree, '.git/config'));

    const app = await _electron.launch({
      executablePath: process.env.TW_PLUS_TEST_ELECTRON || require('electron'),
      cwd: repo,
      args: [path.join(__dirname, 'editor-popouts-app.js')],
      env: {
        ...process.env,
        TW_PLUS_DESKTOP_DATA_DIR: path.join(work, 'profile'),
        TW_PLUS_DESKTOP_RENDERER: '1',
        // Only exposes EditorPreload.localGit; nothing here connects to GitHub.
        TW_PLUS_DESKTOP_GIT_CLIENT_ID: 'Iv1_0000000000000000'
      }
    });
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.waitForFunction(() => Boolean(window.vm?.runtime.getTargetForStage()), null, {timeout: 90000});
      assert.equal(await page.evaluate(() => Boolean(window.EditorPreload?.localGit)), true, 'localGit is not exposed');

      // Hand the folder over as a drop does, through CDP only, and answer the directory picker with it.
      await page.evaluate(() => {
        let directory;
        for (const type of ['dragenter', 'dragover', 'drop']) {
          window.addEventListener(type, async event => {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (type === 'drop') directory = await event.dataTransfer.items[0].getAsFileSystemHandle();
          }, {capture: true});
        }
        Object.defineProperty(window, 'showDirectoryPicker', {configurable: true, value: async () => directory});
        Object.defineProperty(window, 'localGitTestReady', {configurable: true, get: () => directory?.kind === 'directory'});
      });
      const cdp = await page.context().newCDPSession(page);
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp.send('Input.dispatchDragEvent', {type, x: 200, y: 200, data: {items: [], files: [worktree], dragOperationsMask: 1}});
      }
      await page.waitForFunction(() => window.localGitTestReady);
      assert.equal(await page.evaluate(async () => (await window.showDirectoryPicker()).requestPermission({mode: 'readwrite'})), 'granted');

      const panel = page.locator('.twgit-panel');
      const button = name => panel.getByRole('button', {name});
      await page.locator('.twgit-branch-button').click();
      await page.getByRole('menuitem', {name: /^(Open Local Git|ローカル Git を開く)$/}).click();
      await button(/^(Choose Repository…|リポジトリを選択…)$/).click();
      // In the collapsed Git details.
      await panel.getByText(/^(Branch|ブランチ) · main$/).waitFor({state: 'attached'});

      // A change saved outside the Editor, staged and recorded from the panel.
      await fs.appendFile(path.join(worktree, 'README.md'), '\nWritten from the Desktop panel.\n');
      await button(/^(Refresh|再取得)$/).click();
      await panel.getByText(/^(Saved, not yet recorded|保存したが、まだ記録していない変更) · 1$/).waitFor();
      await button(/^(Add All Changes to Next Record|すべての変更を次の記録に入れる)$/).click();
      await panel.getByText(/^(Changes in the next record|次の記録に入る変更) · 1$/).waitFor();
      assert.equal(git('status', '--porcelain'), 'M  README.md');

      await panel.getByLabel(/^(Message for this record|この記録の説明)$/).fill('Record from Desktop');
      await button(/^(Record \(Commit\)|記録する（コミット）)$/).click();
      await eventually('commit', () => git('log', '-1', '--format=%s|%an|%ae') ===
        'Record from Desktop|Desktop Local Git|desktop-local-git@example.invalid');
      assert.equal(git('status', '--porcelain'), '');
      assert.match(git('show', 'HEAD:README.md'), /Written from the Desktop panel\./);

      // A branch made and switched to from the panel.
      await panel.getByLabel(/^\s*(New branch name|新しいブランチの名前)\s*$/).fill('desktop-branch');
      const switchAfter = panel.getByLabel(/^\s*(Switch to it|作ったら切り替える)\s*$/);
      if (!await switchAfter.isChecked()) await switchAfter.check();
      await button(/^(Create Branch|ブランチを作る)$/).click();
      await eventually('branch switch', () => git('branch', '--show-current') === 'desktop-branch');
      assert.equal(git('rev-parse', 'desktop-branch'), git('rev-parse', 'main'));
      assert.equal(git('status', '--porcelain'), '');

      git('fsck', '--no-progress', '--strict');
      assert.deepEqual(await fs.readFile(path.join(worktree, '.git/config')), configBefore, '.git/config changed');
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
    }
  } finally {
    await fs.rm(work, {recursive: true, force: true});
  }
});
