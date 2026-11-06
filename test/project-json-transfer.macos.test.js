const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');

const blockType = 'application/x.turbowarp.blocks3+json';
const yamlType = 'application/x.turbowarp.yaml+json';
const expectEventually = async (label, read) => {
  const until = Date.now() + 25000;
  let cause;
  while (Date.now() < until) {
    try {
      const result = await read();
      if (result) return result;
    } catch (error) { cause = error; }
    await delay(100);
  }
  throw new Error('Timed out: ' + label, {cause});
};

async function allowExtension (page) {
  const review = page.locator('.twextsec-review');
  await review.waitFor({timeout: 20000});
  const unsandboxed = review.locator('input[name="execution-all"][value="unsandboxed"]');
  if (await unsandboxed.count()) await unsandboxed.click();
  await review.getByTestId('twextsec-complete').click();
  await review.waitFor({state: 'hidden'});
}

async function selectBackdrop (page) {
  const pin = page.getByRole('button', {name: /^(Pin sprite list|スプライト一覧を固定表示)$/});
  if (!await pin.isVisible()) await page.getByRole('button', {name: /^(Reveal sprite list|スプライト一覧を展開)$/}).hover();
  if (await pin.getAttribute('aria-pressed') === 'false') await pin.click();
  await page.getByRole('button', {name: /^(Backdrops|背景)$/}).click();
}

async function openYaml (page) {
  await selectBackdrop(page);
  const hats = page.locator('[data-twpe-yaml-hat-icon]');
  await hats.first().waitFor();
  await hats.first().focus();
  await page.keyboard.press('Enter');
  const pane = page.locator('.twpe-yaml-dialog[open]');
  await pane.getByRole('button', {name: /^(Copy or drag YAML|YAML をコピー／ドラッグ)$/}).waitFor();
  return pane;
}

async function browserDrag (page, handle) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.setInterceptDrags', {enabled: true});
    await handle.hover({timeout: 4500});
    const rect = await handle.boundingBox();
    assert(rect);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const intercept = new Promise(resolve => cdp.once('Input.dragIntercepted', resolve));
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
    await cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x, y});
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1, x: x - 4, y: y + 4});
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1, x: x - 18, y: y + 22});
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1, x: x - 25, y: y + 30});
    const {data} = await Promise.race([intercept, delay(5000).then(() => { throw new Error('Drag not intercepted'); })]);
    await cdp.send('Input.dispatchDragEvent', {type: 'dragCancel', x, y, data});
    return data;
  } finally {
    await cdp.detach();
  }
}

async function browserDrop (page, surface, data) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const rect = await surface.boundingBox();
    assert(rect);
    const x = rect.x + rect.width * 0.4, y = rect.y + rect.height * 0.7;
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', {type, x, y, data});
  } finally {
    await cdp.detach();
  }
}

function sampleWav () {
  const sample = Buffer.alloc(44 + 1600);
  sample.write('RIFF', 0);
  sample.writeUInt32LE(sample.length - 8, 4);
  sample.write('WAVEfmt ', 8);
  sample.writeUInt32LE(16, 16);
  sample.writeUInt16LE(1, 20);
  sample.writeUInt16LE(1, 22);
  sample.writeUInt32LE(8000, 24);
  sample.writeUInt32LE(16000, 28);
  sample.writeUInt16LE(2, 32);
  sample.writeUInt16LE(16, 34);
  sample.write('data', 36);
  sample.writeUInt32LE(sample.length - 44, 40);
  return sample;
}

async function checkAssetVault (t, source, destination, profile, sourcePid) {
  const sample = sampleWav();
  const staged = await source.evaluate(async sampleBytes => {
    const costume = vm.editingTarget.getCostumes()[0];
    const sourceBytes = costume.asset.data;
    const transfer = EditorPreload.projectAssetTransfer;
    const make = async (kind, bytes, payload) =>
      ({version: 1, kind, ...await transfer.stage(kind, bytes), payload});
    return {
      costume: await make('costume', sourceBytes, {
        name: 'D5 transferred costume', format: costume.asset.dataFormat,
        rotationCenterX: costume.rotationCenterX, rotationCenterY: costume.rotationCenterY
      }),
      sound: await make('sound', Uint8Array.from(sampleBytes), {name: 'D5 transferred sound', format: 'wav'}),
      cancelled: await make('sound', Uint8Array.from([1]), {})
    };
  }, Array.from(sample));
  for (const envelope of [staged.costume, staged.sound]) {
    const asset = envelope.assets[0];
    const stored = await fs.readFile(path.join(profile, 'project-transfers', envelope.transferId + '.' + asset.kind));
    assert.equal(stored.length, asset.size);
    assert.equal(createHash('sha256').update(stored).digest('hex'), asset.sha256);
    assert(!JSON.stringify(envelope).includes(stored.toString('base64')));
    if (asset.kind === 'sound') assert.deepEqual(stored, sample);
  }
  assert.equal(await destination.evaluate(id => EditorPreload.projectAssetTransfer.discard(id),
    staged.cancelled.transferId), false);
  assert.equal(await source.evaluate(id => EditorPreload.projectAssetTransfer.discard(id),
    staged.cancelled.transferId), true);
  await source.close();
  await expectEventually('source process exited', () => {
    try {
      process.kill(sourcePid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  });
  const counts = () => destination.evaluate(() => [
    vm.editingTarget.getCostumes().length, vm.editingTarget.getSounds().length
  ]);
  const before = await counts();
  for (const envelope of [staged.cancelled, {...staged.costume, assets: [{...staged.costume.assets[0], sha256: '0'.repeat(64)}]}]) {
    await assert.rejects(destination.evaluate(envelope =>
      EditorPreload.projectAssetTransfer.read(envelope.transferId, envelope.assets[0]), envelope), /missing, expired, or invalid/);
    assert.deepEqual(await counts(), before);
  }
  const loaded = await destination.evaluate(async ({costume, sound}) => {
    const target = vm.editingTarget;
    const {storage, renderer} = vm.runtime;
    const transfer = EditorPreload.projectAssetTransfer;
    const importAsset = async (envelope, type) => {
      const bytes = await transfer.read(envelope.transferId, envelope.assets[0]);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      const {name, format, rotationCenterX, rotationCenterY} = envelope.payload;
      const asset = storage.createAsset(type, format, bytes, null, true);
      const md5 = asset.assetId + '.' + format;
      const item = {name, asset, assetId: asset.assetId, md5, dataFormat: format, rotationCenterX, rotationCenterY};
      if (envelope.kind === 'costume') await vm.addCostume(md5, item, target.id);
      else await vm.addSound(item, target.id);
      return digest;
    };
    const costumeDigest = await importAsset(costume, storage.AssetType.ImageVector);
    const soundDigest = await importAsset(sound, storage.AssetType.Sound);
    const importedCostume = target.getCostumes().at(-1);
    const importedSound = target.getSounds().at(-1);
    return {costumeDigest, soundDigest, skin: renderer.getSkinSize(importedCostume.skinId),
      samples: vm.getSoundBuffer(target.getSounds().length - 1)?.length,
      broken: Boolean(importedCostume.broken || importedSound.broken)};
  }, staged);
  assert.equal(loaded.costumeDigest, staged.costume.assets[0].sha256);
  assert.equal(loaded.soundDigest, staged.sound.assets[0].sha256);
  assert(loaded.skin.every(size => size > 0));
  assert(loaded.samples > 0);
  assert.equal(loaded.broken, false);
  assert.deepEqual(await counts(), before.map(count => count + 1));
  t.diagnostic('Two project processes exchanged and decoded real SVG and WAV assets after closing the source window.');
}

async function permitClipboard (context) {
  const prompt = context.pages().find(page => page.url().startsWith('tw-security-prompt:'));
  if (prompt) await prompt.locator('.allow:enabled').click({timeout: 6000});
  return Boolean(prompt);
}

const assetTabs = [
  ['costume', /^(Costumes|コスチューム)$/],
  ['sound', /^(Sounds|音)$/]
];

async function checkAssetPanels (t, source, destination) {
  const sourceNames = {costume: 'D5 clipboard costume', sound: 'D5 clipboard sound'};
  await source.evaluate(async ({sample, names}) => {
    vm.renameCostume(0, names.costume);
    const {storage} = vm.runtime;
    const asset = storage.createAsset(storage.AssetType.Sound, 'wav', Uint8Array.from(sample), null, true);
    await vm.addSound({name: names.sound, asset, assetId: asset.assetId,
      md5: asset.assetId + '.wav', dataFormat: 'wav'}, vm.editingTarget.id);
  }, {sample: Array.from(sampleWav()), names: sourceNames});
  const assets = (page, kind) => page.evaluate(async kind => {
    const target = vm.editingTarget;
    const items = kind === 'costume' ? target.getCostumes() : target.getSounds();
    return Promise.all(items.map(async (item, index) => ({
      hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', item.asset.data))).join(','),
      decoded: !item.broken && (kind === 'costume' ?
        vm.runtime.renderer.getSkinSize(item.skinId).every(size => size > 0) : vm.getSoundBuffer(index)?.length > 0)
    })));
  }, kind);
  for (const [kind, label] of assetTabs) {
    const panel = async page => {
      await page.bringToFront();
      await page.getByRole('tab', {name: label}).click();
      const node = page.locator('[data-project-asset-transfer="' + kind + '"]');
      await node.waitFor();
      return node;
    };
    const from = await panel(source);
    const original = (await assets(source, kind))[0];
    assert(original.decoded);
    await from.getByRole('button', {name: /^(Copy asset|素材をコピー)$/}).click();
    await expectEventually('real OS asset clipboard', async () => {
      await permitClipboard(source.context());
      return execFileSync('pbpaste', {encoding: 'utf8'}).trim() === sourceNames[kind];
    });
    const to = await panel(destination);
    const before = (await assets(destination, kind)).length;
    await to.getByRole('button', {name: /^(Paste asset|素材を貼り付け)$/}).click();
    await expectEventually('clipboard asset decoded in destination', async () => {
      await permitClipboard(destination.context());
      const current = await assets(destination, kind);
      return current.length === before + 1 && current.at(-1).hash === original.hash && current.at(-1).decoded;
    });
    await source.bringToFront();
    const prepare = from.getByRole('button', {name: /^(Prepare asset drag|ドラッグを準備)$/});
    const drag = from.getByRole('button', {name: /^(Drag asset|素材をドラッグ)$/});
    await prepare.click();
    await drag.waitFor();
    await from.getByRole('button', {name: /^(Cancel asset drag|準備を取り消す)$/}).click();
    await drag.waitFor({state: 'hidden'});
    assert.equal((await assets(destination, kind)).length, before + 1);
    await prepare.click();
    const packet = await browserDrag(source, drag);
    const mime = 'application/x.turbowarp.' + kind + '+json';
    const data = packet.items.find(item => item.mimeType === mime);
    assert(data, 'The drag contains the kind-specific JSON MIME.');
    const envelope = JSON.parse(data.data);
    assert.equal(envelope.kind, kind);
    assert.match(envelope.assets[0].sha256, /^[a-f0-9]{64}$/);
    await destination.bringToFront();
    const invalid = {...envelope, assets: [{...envelope.assets[0], sha256: '0'.repeat(64)}]};
    await browserDrop(destination, to, {...packet, items: [{mimeType: mime, data: JSON.stringify(invalid)}]});
    await expectEventually('tampered asset rejected', async () =>
      (await to.getByRole('status').textContent()).includes('missing, expired, or invalid'));
    assert.equal((await assets(destination, kind)).length, before + 1);
    await browserDrop(destination, to, packet);
    await expectEventually('drag asset decoded in destination', async () => {
      const current = await assets(destination, kind);
      return current.length === before + 2 && current.at(-1).hash === original.hash && current.at(-1).decoded;
    });
    assert.deepEqual((await assets(source, kind))[0], original);
    t.diagnostic(kind + ': OS clipboard and cross-process drag imported matching, decoded bytes.');
  }
}

async function checkExternalYaml (t, source, destination, work, picker) {
  const left = path.join(work, 'left');
  const right = path.join(work, 'right');
  await Promise.all([fs.mkdir(left), fs.mkdir(right)]);
  const first = path.join(left, 'settings.yaml');
  const second = path.join(right, 'settings.yaml');
  const alias = path.join(work, 'alias.yml');
  await fs.writeFile(first, 'marker: external-first\n');
  await fs.writeFile(second, 'marker: external-second\n');
  await fs.symlink(first, alias);
  const pane = (page, number) => page.locator(
    '.tw-plus-document-slot[data-provider-id="file"][data-document-id="' + number + '"]');
  const tab = (page, number) => page.getByRole('tab', {name: 'settings.yaml (file / ' + number + ')', exact: true});
  const open = async (page, file) => {
    await fs.writeFile(picker, JSON.stringify({open: file}));
    await page.bringToFront();
    await page.getByText(/^(File|ファイル)$/, {exact: true}).first().click();
    await page.getByText(/^(Open external YAML file…|外部YAMLファイルを開く…)$/, {exact: true}).click();
  };
  await open(source, first);
  await pane(source, 1).locator('textarea').waitFor();
  await open(source, first);
  assert.equal(await tab(source, 1).count(), 1);
  assert.equal(await tab(source, 2).count(), 0);
  await open(source, second);
  await pane(source, 2).locator('textarea').waitFor();
  const leftPane = pane(source, 2);
  const firstPane = pane(source, 1);
  await tab(source, 1).click();
  const firstBox = await firstPane.boundingBox();
  assert(firstBox);
  await tab(source, 1).dragTo(firstPane, {
    targetPosition: {x: firstBox.width - 12, y: firstBox.height / 2}
  });
  await tab(source, 2).click();
  await expectEventually('both YAML tabs are visible in separate groups', async () => {
    if (!await leftPane.isVisible() || !await firstPane.isVisible()) return false;
    const [one, two] = await Promise.all([firstPane.boundingBox(), leftPane.boundingBox()]);
    return one.x >= two.x + two.width - 4;
  });
  const firstText = firstPane.locator('textarea');
  const secondText = leftPane.locator('textarea');
  await firstText.fill('marker: saved-to-external-file\n');
  await secondText.fill('marker: [broken\n');
  await leftPane.locator('.twpe-yaml-save').click();
  await expectEventually('invalid YAML rejected', async () => (await leftPane.locator('.twpe-yaml-error').textContent()).length > 0);
  assert.equal(await fs.readFile(second, 'utf8'), 'marker: external-second\n');
  await secondText.fill('marker: unsaved-other-pane\n');
  await firstPane.locator('.twpe-yaml-save').click();
  await expectEventually('edited YAML saved to its original file', async () =>
    await fs.readFile(first, 'utf8') === 'marker: saved-to-external-file\n');
  assert.equal(await secondText.inputValue(), 'marker: unsaved-other-pane\n');
  await expectEventually('saved tab remains open with the committed content', async () =>
    await firstText.inputValue() === 'marker: saved-to-external-file\n');
  t.diagnostic('Same-named YAML tabs split side by side, independently edited and saved in place.');

  await open(destination, alias);
  const busy = destination.getByRole('alertdialog');
  await busy.waitFor();
  assert.match(await busy.textContent(), /already open in another project window/);
  await busy.getByRole('button', {name: 'OK', exact: true}).click();
  assert.equal(await pane(destination, 1).count(), 0);
  await firstText.fill('marker: stale-draft\n');
  await fs.writeFile(first, 'marker: change-from-outside\n');
  await firstPane.locator('.twpe-yaml-save').click();
  await expectEventually('external edit detected at save', async () =>
    (await firstPane.locator('.twpe-yaml-error').textContent()).includes('changed on disk'));
  assert.equal(await firstText.inputValue(), 'marker: stale-draft\n');
  assert.equal(await fs.readFile(first, 'utf8'), 'marker: change-from-outside\n');
  await tab(source, 1).locator('.dv-default-tab-action').click();
  const confirmation = source.locator('.twpe-yaml-confirmation:modal');
  await confirmation.getByRole('button', {name: /^(Discard changes|破棄して閉じる)$/}).click();
  await tab(source, 1).waitFor({state: 'detached'});
  await expectEventually('YAML lease released after closing tab', async () => {
    const locks = await fs.readdir(path.join(work, 'data', 'yaml-locks'));
    return locks.filter(file => file.endsWith('.json')).length === 1;
  });
  await open(destination, alias);
  await pane(destination, 1).locator('textarea').waitFor();
  assert.equal(await pane(destination, 1).locator('textarea').inputValue(), 'marker: change-from-outside\n');
  await source.bringToFront();
  await tab(source, 2).click();
  const upperBox = await leftPane.boundingBox();
  assert(upperBox);
  await tab(source, 2).dragTo(leftPane, {
    targetPosition: {x: upperBox.width / 2, y: upperBox.height - 12}
  });
  await expectEventually('the second YAML tab moved into a lower split', async () =>
    (await leftPane.boundingBox())?.y > upperBox.y + 32);
  assert.equal(await secondText.inputValue(), 'marker: unsaved-other-pane\n');
  const zip = require(path.join(path.dirname(process.env.TW_D4_PLAYWRIGHT), '@turbowarp/jszip'));
  const savedBytes = await source.evaluate(async () =>
    Array.from(new Uint8Array(await (await vm.saveProjectSb3()).arrayBuffer())));
  const project = await zip.loadAsync(Buffer.from(savedBytes));
  const projectJson = await project.file('project.json').async('string');
  assert(!/saved-to-external-file|unsaved-other-pane|change-from-outside|stale-draft/.test(projectJson));
  assert(!Object.keys(project.files).some(name => /\.ya?ml$/i.test(name)));
  t.diagnostic('A symlink conflicted across processes, stale saves and a vertical split preserved drafts, and SB3 serialization excluded external files.');
}

test(process.env.TW_D5_TEST_EXTERNAL_YAML === '1' ? 'Desktop opens external YAML tabs with cross-project file locks' :
  process.env.TW_D5_TEST_UI === 'rollback' ? 'Desktop asset tabs remain available with D5 disabled' :
  process.env.TW_D5_TEST_UI === '1' ? 'Desktop asset panels transfer costumes and sounds' :
  process.env.TW_D5_TEST_ASSETS === '1' ? 'Desktop project processes resolve a shared binary asset' :
  'two Desktop projects transfer scripts and YAML via the OS clipboard and cross-process drag data', {
  skip: process.platform !== 'darwin' || !process.env.TW_D4_TEST_APP,
  timeout: 155000
}, async t => {
  const {chromium} = require(process.env.TW_D4_PLAYWRIGHT);
  const enabled = process.env.TW_D4_TEST_ENABLED !== '0';
  const externalYaml = process.env.TW_D5_TEST_EXTERNAL_YAML === '1';
  const assetPanels = enabled && process.env.TW_D5_TEST_UI === '1';
  const assetRollback = enabled && process.env.TW_D5_TEST_UI === 'rollback';
  const assets = assetPanels || (enabled && process.env.TW_D5_TEST_ASSETS === '1');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-d4-transfer-'));
  const profile = path.join(work, 'data');
  const first = path.join(work, 'D4 Source.sb3');
  const second = path.join(work, 'D4 Destination.sb3');
  const clipboard = path.join(work, 'clipboard.json');
  const logPath = path.join(work, 'electron.log');
  const log = await fs.open(logPath, 'a');
  const snapshot = operation => execFileSync('swift', [path.join(__dirname, 'clipboard-snapshot.swift'), operation, clipboard]);
  const picker = path.join(work, 'picker.json');
  const usesClipboard = !externalYaml && !assetRollback && (!assets || assetPanels);
  if (usesClipboard) snapshot('save');
  const sessions = [];
  let broker;
  t.after(async () => {
    for (const browser of sessions) await browser.close().catch(() => {});
    if (broker) {
      try { process.kill(-broker.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (usesClipboard) snapshot('restore');
    await fs.rm(clipboard, {force: true});
    await log.close();
  });
  await fs.copyFile(process.env.TW_D4_TEST_SB3, first);
  await fs.copyFile(process.env.TW_D4_TEST_SB3, second);
  const binary = path.join(process.env.TW_D4_TEST_APP, 'Contents', 'MacOS', 'TurboWarp');
  broker = spawn(binary, ['--remote-debugging-port=0', first, second], {
    cwd: work, stdio: ['ignore', log.fd, log.fd], detached: true,
    env: {...process.env, TW_PLUS_DESKTOP_PROJECT_ISOLATION: '1', TW_PLUS_DESKTOP_JSON_TRANSFER: enabled ? '1' : '0',
      TW_PLUS_DESKTOP_ASSET_TRANSFER: assets ? '1' : '0', TW_PLUS_DESKTOP_EXTERNAL_YAML: externalYaml ? '1' : '0',
      ...(externalYaml && {TW_D3_TEST_DIALOG_PATH: picker}), TW_PLUS_DESKTOP_DATA_DIR: profile}
  });
  const nameOf = page => page.evaluate(() => EditorPreload.getInitialFile()
    .then(id => EditorPreload.getFile(id)).then(file => file.name));
  try {
    const root = path.join(profile, 'project-processes');
    const ports = await expectEventually('two Electron project debug endpoints', async () => {
      const profiles = await fs.readdir(root);
      if (profiles.length !== 2) return null;
      return await Promise.all(profiles.map(async name => {
        const [port] = (await fs.readFile(path.join(root, name, 'DevToolsActivePort'), 'utf8')).split('\n');
        return 'http://127.0.0.1:' + port;
      }));
    });
    const lockRoot = path.join(profile, 'project-locks');
    const records = await Promise.all((await fs.readdir(lockRoot)).filter(name => name.endsWith('.json'))
      .map(async name => JSON.parse(await fs.readFile(path.join(lockRoot, name), 'utf8'))));
    assert.equal(new Set(records.map(record => record.pid)).size, 2);
    sessions.push(...await Promise.all(ports.map(port => chromium.connectOverCDP(port))));
    const pages = await Promise.all(sessions.map(async browser => {
      const context = browser.contexts()[0];
      context.setDefaultTimeout(10000);
      const page = await expectEventually('native editor window', () => context.pages().find(page => page.url().startsWith('tw-editor:')));
      page.on('dialog', dialog => { t.diagnostic(dialog.message()); void dialog.dismiss(); });
      await allowExtension(page);
      await page.waitForFunction(() => window.vm?.runtime.extensionStorage.twpeyamlsettings?.documents &&
        window.ScratchBlocks?.getMainWorkspace() && !vm.editingTarget?.isStage);
      assert.equal(await page.evaluate(() => EditorPreload.projectJSONTransfer), enabled);
      assert.equal(await page.evaluate(() => Boolean(EditorPreload.projectAssetTransfer)), assets);
      assert.equal(await page.evaluate(() => Boolean(EditorPreload.externalYaml)), externalYaml);
      return {page, context, name: await nameOf(page)};
    }));
    const {page: A, context: sender} = pages.find(item => item.name === 'D4 Source.sb3');
    const {page: B, context: recipient} = pages.find(item => item.name === 'D4 Destination.sb3');
    if (!enabled) {
      assert.equal(await A.locator('.tw-plus-script-transfer-drag').count(), 0);
      await selectBackdrop(B);
      const hat = B.locator('[data-twpe-yaml-hat-icon]').first();
      await hat.focus();
      await B.keyboard.press('Enter');
      const pane = B.locator('.twpe-yaml-dialog[open]');
      await pane.waitFor();
      assert.equal(await pane.getByRole('button', {name: /^(Paste YAML|YAML を貼り付け)$/}).count(), 0);
      return;
    }
    if (externalYaml) {
      await checkExternalYaml(t, A, B, work, picker);
      return;
    }
    if (assetRollback) {
      for (const [, label] of assetTabs) {
        const tab = B.getByRole('tab', {name: label});
        await tab.click();
        assert.equal(await tab.getAttribute('aria-selected'), 'true');
        assert.equal(await B.locator('[data-project-asset-transfer]').count(), 0);
      }
      return;
    }
    if (assetPanels) {
      await checkAssetPanels(t, A, B);
      return;
    }
    if (assets) {
      const sourceLock = records.find(record => path.basename(record.path) === path.basename(first));
      assert(sourceLock);
      await checkAssetVault(t, A, B, profile, sourceLock.pid);
      return;
    }
    await A.bringToFront();
    await A.evaluate(() => {
      const target = vm.editingTarget;
      target.createVariable('d4-counter', 'D4 counter', '');
      target.variables['d4-counter'].value = 37;
      target.blocks.createBlock({id: 'd4-script', opcode: 'data_changevariableby', topLevel: true,
        shadow: false, parent: null, next: null, x: 250, y: 150,
        fields: {VARIABLE: {name: 'VARIABLE', id: 'd4-counter', value: 'D4 counter'}},
        inputs: {VALUE: {name: 'VALUE', block: 'd4-number', shadow: 'd4-number'}}});
      target.blocks.createBlock({id: 'd4-number', opcode: 'math_number', topLevel: false,
        shadow: true, parent: 'd4-script', next: null,
        fields: {NUM: {name: 'NUM', value: '1'}}, inputs: {}});
      vm.refreshWorkspace();
    });
    await A.waitForFunction(() => ScratchBlocks.getMainWorkspace().getBlockById('d4-script'));
    const selectScript = () => A.evaluate(() => ScratchBlocks.getMainWorkspace().getBlockById('d4-script').select());
    await selectScript();
    assert.equal(await A.locator('.tw-plus-script-transfer-drag').count(), 1);
    const clipboardContains = async (context, text) => {
      await permitClipboard(context);
      return execFileSync('pbpaste', {encoding: 'utf8'}).includes(text);
    };
    await A.evaluate(() => document.activeElement?.blur());
    await A.keyboard.press('Meta+c');
    await expectEventually('native clipboard text', () => clipboardContains(sender, 'D4 counter'));

    await B.bringToFront();
    await B.evaluate(() => document.activeElement?.blur());
    await B.keyboard.press('Meta+v');
    await expectEventually('the existing native clipboard permission dialog', () => permitClipboard(recipient));
    const scripts = page => page.evaluate(() => Object.values(vm.editingTarget.blocks._blocks)
      .filter(block => block.opcode === 'data_changevariableby').length);
    await expectEventually('the destination imported the OS clipboard script', async () => await scripts(B) === 1);
    assert.equal(await B.evaluate(() => Object.values(vm.editingTarget.variables).find(item => item.name === 'D4 counter')?.value), 37);
    t.diagnostic('OS clipboard imported a block and its variable into a separate process.');

    await A.bringToFront();
    await selectScript();
    const scriptDrag = await browserDrag(A, A.getByRole('button', {name: /^(Drag selected script|選択したスクリプトをドラッグ)$/}));
    assert(scriptDrag.items.some(item => item.mimeType === blockType || item.mimeType === 'text/plain'));
    assert.equal(await scripts(B), 1);
    await B.bringToFront();
    await browserDrop(B, B.locator('.blocklySvg').first(), scriptDrag);
    await expectEventually('one additional script arrived by drop', async () => await scripts(B) === 2);
    assert.equal(await scripts(A), 1);
    t.diagnostic('Block drag data imported once without modifying the source project.');

    await A.evaluate(() => { vm.runtime.extensionStorage.twpeyamlsettings.documents.settings = 'volume: 75\nmode: production\n# D4 source\n'; });
    await A.bringToFront();
    const sourceYaml = await openYaml(A);
    const copyYaml = sourceYaml.getByRole('button', {name: /^(Copy or drag YAML|YAML をコピー／ドラッグ)$/});
    await copyYaml.click();
    await expectEventually('native clipboard YAML text', () => clipboardContains(sender, '# D4 source'));
    await B.bringToFront();
    const destYaml = await openYaml(B);
    const preview = destYaml.locator('textarea');
    const committed = () => B.evaluate(() => vm.runtime.extensionStorage.twpeyamlsettings.documents.settings);
    await destYaml.getByRole('button', {name: /^(Paste YAML|YAML を貼り付け)$/}).click();
    await expectEventually('destination YAML draft from the clipboard', async () => (await preview.inputValue()).includes('# D4 source'));
    assert.equal(await committed(), 'volume: 50\nmode: rehearsal\n');
    await destYaml.getByRole('button', {name: /^(Cancel|キャンセル)$/}).click();
    await destYaml.waitFor({state: 'hidden'});
    assert.equal(await committed(), 'volume: 50\nmode: rehearsal\n');

    t.diagnostic('The OS clipboard loaded a YAML draft, and Cancel preserved the project.');

    await A.bringToFront();
    const yamlDrag = await browserDrag(A, copyYaml);
    const yamlPlain = yamlDrag.items.filter(item => item.mimeType === 'text/plain');
    assert.equal(yamlPlain.length, 1);
    assert.equal(JSON.parse(yamlPlain[0].data).format, 'turbowarp-yaml');
    await B.bringToFront();
    const reopen = await openYaml(B);
    const yamlText = reopen.locator('textarea');
    const invalid = {items: [{mimeType: yamlType,
      data: JSON.stringify({format: 'turbowarp-yaml', version: 1, source: 'volume: 150\nmode: production\n'})}], dragOperationsMask: 1};
    await browserDrop(B, yamlText, invalid);
    await expectEventually('invalid YAML rejected by the destination schema', async () =>
      (await reopen.locator('.twpe-yaml-error').textContent()).includes('JSON Schema validation failed'));
    assert.equal(await committed(), 'volume: 50\nmode: rehearsal\n');
    await browserDrop(B, yamlText, {...yamlDrag, items: yamlPlain});
    await expectEventually('the destination YAML draft arrived by drop', async () => (await yamlText.inputValue()).includes('# D4 source'));
    await reopen.locator('.twpe-yaml-save').click();
    await expectEventually('the destination provider committed YAML', async () => (await committed()).includes('# D4 source'));
    assert.equal(await A.evaluate(() => vm.runtime.extensionStorage.twpeyamlsettings.documents.settings),
      'volume: 75\nmode: production\n# D4 source\n');
    t.diagnostic('YAML drop rejected invalid schema data and imported the JSON text fallback.');
    assert.equal(await B.evaluate(() => localStorage.getItem('tw-plus-script-clipboard-v1')), null);

    await B.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'd4-ordinary-text';
      document.body.append(input);
      input.focus();
    });
    execFileSync('pbcopy', {input: 'D4 ordinary clipboard text'});
    await B.keyboard.press('Meta+v');
    await expectEventually('plain OS clipboard text retained native paste behavior', async () =>
      await B.locator('#d4-ordinary-text').inputValue() === 'D4 ordinary clipboard text');
  } catch (error) {
    t.diagnostic((await fs.readFile(logPath, 'utf8')).slice(-6000));
    throw error;
  }
});
