const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const AdmZip = require('adm-zip');
const {assertStandardRendererCanOverwrite, denialCode} = require('../src-main/standard-renderer-save');

const project = {targets: [{blocks: {}}], extensions: ['example']};
const archive = (metadata, entry) => {
  const zip = new AdmZip();
  if (metadata) zip.addFile('project.json', Buffer.from(JSON.stringify(metadata)));
  if (entry) zip.addFile(entry, Buffer.from('asset'));
  return zip.toBuffer();
};

test('a new destination and standard project files can be written', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-standard-save-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'project.sb3');
  await assertStandardRendererCanOverwrite(file);
  await fs.writeFile(file, archive(project, 'costume.svg'));
  await assertStandardRendererCanOverwrite(file);
  await fs.writeFile(file, JSON.stringify(project));
  await assertStandardRendererCanOverwrite(file);
});

test('Plus archives, legacy documents and aliases are protected', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-plus-save-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'project.sb3');
  const alias = path.join(dir, 'alias.sb3');
  await fs.symlink('project.sb3', alias);
  const fixtures = [
    ...['turboWarpPlus', 'turboWarpPlusLock', 'turboWarpPlusProject', 'turboWarpPlusPayloads']
      .map(key => archive({...project, [key]: {}})),
    archive(project, 'extensions/example.js'),
    archive(project, 'plus-payloads/yaml-0.bin'),
    archive({...project, targets: [{blocks: {hat: {fields: {DOCUMENT: ['tw-embedded-yaml:1:owner:document']}}}}]}),
    archive({...project, extensionStorage: {owner: {documentSourceLocations: {urls: {}}}}}),
    archive({...project, extensionStorage: {twpeyamlsettings: {documents: {settings: 'volume: 50'}}}}),
    Buffer.from(JSON.stringify({...project, turboWarpPlusProject: {}}))
  ];
  for (const contents of fixtures) {
    await fs.writeFile(file, contents);
    await assert.rejects(assertStandardRendererCanOverwrite(alias), {code: denialCode, message: /TurboWarp Plus/});
    assert.deepEqual(await fs.readFile(file), contents);
  }
});

test('an existing file whose format cannot be verified is protected', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-unverified-save-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'project.sb3');
  for (const contents of [Buffer.from('PK'), Buffer.from('{'), archive(null, 'costume.svg')]) {
    await fs.writeFile(file, contents);
    await assert.rejects(assertStandardRendererCanOverwrite(file), {code: denialCode, message: /could not be checked/});
  }
});
