const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {createProjectFolderRename} = require('../src-main/project-folder-rename');

async function workspace (t, ...names) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-folder-rename-')));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  for (const name of names) {
    await fs.mkdir(path.join(parent, name, '.git'), {recursive: true});
    await fs.writeFile(path.join(parent, name, 'project.source.json'), '{}');
  }
  return parent;
}

function renamer (picked, locale = 'ja') {
  const prompts = [];
  const service = createProjectFolderRename({
    locale: () => locale,
    dialogs: {chooseDirectory: async prompt => { prompts.push(prompt); return picked; }}
  });
  return {service, prompts};
}

test('renames the folder the user picks in the dialog when it carries the open folder name', async t => {
  const parent = await workspace(t, 'urashima');
  const {service, prompts} = renamer(path.join(parent, 'urashima'));
  assert.deepEqual(await service.rename('urashima', 'my-urashima'), {renamed: true, name: 'my-urashima'});
  assert.deepEqual(await fs.readdir(path.join(parent, 'my-urashima')), ['.git', 'project.source.json']);
  await assert.rejects(fs.stat(path.join(parent, 'urashima')), {code: 'ENOENT'});
  assert.match(prompts[0].message, /「my-urashima」.*「urashima」/u);
  assert.equal(prompts[0].buttonLabel, '名前を変える');
});

test('leaves the file system alone when the dialog is canceled, another folder is picked or the name is taken', async t => {
  const parent = await workspace(t, 'urashima', 'other', 'taken');
  assert.deepEqual(await renamer(null).service.rename('urashima', 'renamed'), {renamed: false, reason: 'canceled'});
  assert.deepEqual(await renamer(path.join(parent, 'other')).service.rename('urashima', 'renamed'),
    {renamed: false, reason: 'mismatch'});
  assert.deepEqual(await renamer(path.join(parent, 'urashima')).service.rename('urashima', 'taken'),
    {renamed: false, reason: 'exists'});
  assert.deepEqual((await fs.readdir(parent)).sort(), ['other', 'taken', 'urashima']);
});

test('rejects invalid names before showing a dialog', async t => {
  const parent = await workspace(t, 'urashima');
  const {service, prompts} = renamer(path.join(parent, 'urashima'), 'en');
  for (const [current, next] of [['urashima', '浦島'], ['urashima', '../x'], ['urashima', 'a.git'], ['urashima', ''],
    ['../urashima', 'renamed'], ['', 'renamed']]) {
    assert.deepEqual(await service.rename(current, next), {renamed: false, reason: 'invalid'}, current + ' → ' + next);
  }
  assert.equal(prompts.length, 0);
  assert.deepEqual(await renamer('relative/path').service.rename('urashima', 'renamed'), {renamed: false, reason: 'invalid'});
});
