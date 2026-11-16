const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const {createAgentStore, createAiAgents, readBranch, launchPlan, FILE_NAME} = require('../src-main/ai-agents');

async function setup (t, {platform = 'linux', confirm = true} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-ai-agents-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const app = path.join(root, 'agent');
  await fs.writeFile(app, '#!/bin/sh\n', {mode: 0o755});
  const repository = path.join(root, 'repo');
  const project = path.join(repository, 'Project with spaces');
  await fs.mkdir(path.join(repository, '.git'), {recursive: true});
  await fs.writeFile(path.join(repository, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  await fs.mkdir(project);
  const calls = {spawn: [], confirm: [], file: [], directory: []};
  const answers = {file: app, directory: project, confirm};
  const spawn = (command, args, options) => {
    calls.spawn.push({command, args, options});
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => {
      if (answers.spawnError) child.emit('error', new Error('ENOENT'));
      else {
        child.emit('spawn');
        child.emit('exit', answers.exitCode ?? 0);
      }
    });
    return child;
  };
  const agents = createAiAgents({
    store: createAgentStore(path.join(root, 'data')),
    spawn,
    platform,
    env: {PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', TW_PLUS_DESKTOP_AI_AGENTS: '1'},
    locale: () => 'ja',
    dialogs: {
      chooseFile: async title => { calls.file.push(title); return answers.file; },
      chooseDirectory: async title => { calls.directory.push(title); return answers.directory; },
      confirm: async request => { calls.confirm.push(request); return answers.confirm; }
    }
  });
  return {root, app, repository, project, agents, calls, answers};
}

const value = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};

async function addEntry (agents, draft = {}) {
  const {revision} = value(await agents.list());
  const {selection} = value(await agents.chooseApp());
  return value(await agents.save(revision, [{id: 'claude', name: 'Claude', args: ['--folder', '{projectFolder}', '{branch}'],
    cwd: '', selection, ...draft}]));
}

test('an application chosen in the OS dialog is saved only after the OS confirmation', async t => {
  const {agents, calls, answers, app, root} = await setup(t);
  assert.deepEqual(value(await agents.list()), {revision: null, entries: []});
  const chosen = value(await agents.chooseApp());
  assert.equal(chosen.application, app);
  assert.equal(calls.file[0], '起動するアプリを選択');

  answers.confirm = false;
  const draft = {id: 'claude', name: 'Claude', args: ['{projectFolder}'], cwd: '', selection: chosen.selection};
  assert.deepEqual(await agents.save(null, [draft]), {ok: false, code: 'cancelled'});
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0].detail, /Claude\nアプリ: .*agent\n引数: \["\{projectFolder\}"\]\n作業ディレクトリ: \{projectFolder\}/u);
  await assert.rejects(fs.access(path.join(root, 'data', FILE_NAME)));

  answers.confirm = true;
  const saved = value(await agents.save(null, [draft]));
  assert.match(saved.revision, /^[0-9a-f]{64}$/u);
  assert.deepEqual(saved.entries, [{id: 'claude', name: 'Claude', application: app, args: ['{projectFolder}'], cwd: ''}]);
  const file = JSON.parse(await fs.readFile(path.join(root, 'data', FILE_NAME), 'utf8'));
  assert.equal(file.version, 1);
  // A selection token is used once.
  assert.deepEqual(await agents.save(saved.revision, [{...draft, id: 'again'}]), {ok: false, code: 'invalid'});
});

test('the renderer cannot name an application, and changing what runs asks again', async t => {
  const {agents, calls} = await setup(t);
  // Without a selection, a new entry has no application.
  assert.deepEqual(await agents.save(null, [{id: 'x', name: 'X', args: [], cwd: '', application: '/bin/sh'}]),
    {ok: false, code: 'invalid'});
  assert.deepEqual(await agents.save(null, [{id: 'x', name: 'X', args: [], cwd: '', selection: 'made-up'}]),
    {ok: false, code: 'invalid'});
  const saved = await addEntry(agents);
  assert.equal(calls.confirm.length, 1);

  // Renaming, reordering and the fallback website do not change what runs.
  const [entry] = saved.entries;
  const renamed = value(await agents.save(saved.revision, [{...entry, name: 'Claude app', url: 'https://claude.ai/new',
    application: '/bin/sh'}]));
  assert.equal(calls.confirm.length, 1);
  assert.equal(renamed.entries[0].application, entry.application);
  assert.equal(renamed.entries[0].url, 'https://claude.ai/new');

  const changed = value(await agents.save(renamed.revision, [{...renamed.entries[0], args: ['--danger']}]));
  assert.equal(calls.confirm.length, 2);
  assert.deepEqual(changed.entries[0].args, ['--danger']);
});

test('saving checks the revision and the fallback website', async t => {
  const {agents} = await setup(t);
  const saved = await addEntry(agents);
  const [entry] = saved.entries;
  assert.deepEqual(await agents.save(null, [entry]), {ok: false, code: 'conflict'});
  assert.deepEqual(await agents.save(saved.revision, [{...entry, url: 'http://example.com/'}]), {ok: false, code: 'invalid-url'});
  assert.deepEqual(await agents.save(saved.revision, [{...entry, url: 'javascript:alert(1)'}]), {ok: false, code: 'invalid-url'});
  assert.deepEqual(await agents.save(saved.revision, [entry, entry]), {ok: false, code: 'invalid'});
  assert.deepEqual(await agents.save(saved.revision, [{...entry, args: ['a\0b']}]), {ok: false, code: 'invalid'});
  assert.deepEqual(value(await agents.save(saved.revision, [])).entries, []);
});

test('launching expands the placeholders and passes the arguments without a shell', async t => {
  const {agents, calls, app, project, repository} = await setup(t);
  await addEntry(agents);
  assert.deepEqual(await agents.launch('claude'), {ok: false, code: 'missing-context'});
  assert.equal(calls.spawn.length, 0);

  const context = value(await agents.chooseContext('project'));
  assert.deepEqual(context, {projectFolder: project, repository, branch: 'feature/x'});
  assert.equal(calls.directory[0], 'プロジェクトフォルダを選択');
  assert.deepEqual(value(await agents.context()), context);

  assert.deepEqual(await agents.launch('claude'), {ok: true, value: null});
  const [{command, args, options}] = calls.spawn;
  assert.equal(command, app);
  assert.deepEqual(args, ['--folder', project, 'feature/x']);
  assert.equal(options.cwd, project);
  assert.equal(options.shell, false);
  assert.equal(options.detached, true);
  assert.deepEqual(options.env, {PATH: '/bin'});

  assert.deepEqual(await agents.launch('missing'), {ok: false, code: 'unknown'});
});

test('a detached HEAD has no branch, so an entry that uses {branch} does not start', async t => {
  const {agents, repository, calls} = await setup(t);
  await addEntry(agents);
  value(await agents.chooseContext('project'));
  await fs.writeFile(path.join(repository, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  assert.equal(value(await agents.context()).branch, null);
  assert.deepEqual(await agents.launch('claude'), {ok: false, code: 'missing-context'});
  assert.equal(calls.spawn.length, 0);
});

test('a missing application, working directory or failed start is reported', async t => {
  const {agents, app, answers, root} = await setup(t);
  await addEntry(agents, {args: [], cwd: path.join(root, 'nowhere')});
  assert.deepEqual(await agents.launch('claude'), {ok: false, code: 'invalid-directory'});

  const saved = value(await agents.list());
  value(await agents.save(saved.revision, [{...saved.entries[0], cwd: root}]));
  answers.spawnError = true;
  assert.deepEqual(await agents.launch('claude'), {ok: false, code: 'launch-failed'});
  await fs.rm(app);
  assert.deepEqual(await agents.launch('claude'), {ok: false, code: 'app-missing'});
});

test('the repository is chosen only at the root of a work tree, and worktree files are read', async t => {
  const {agents, answers, project, repository, root} = await setup(t);
  answers.directory = project;
  assert.deepEqual(await agents.chooseContext('repository'), {ok: false, code: 'invalid-directory'});
  answers.directory = repository;
  assert.equal(value(await agents.chooseContext('repository')).repository, repository);
  answers.directory = null;
  assert.equal(value(await agents.chooseContext('project')), null);
  assert.deepEqual(await agents.chooseContext('anything'), {ok: false, code: 'invalid'});

  const linked = path.join(root, 'linked');
  await fs.mkdir(linked);
  await fs.mkdir(path.join(repository, '.git', 'worktrees', 'linked'), {recursive: true});
  await fs.writeFile(path.join(repository, '.git', 'worktrees', 'linked', 'HEAD'), 'ref: refs/heads/topic\n');
  await fs.writeFile(path.join(linked, '.git'), `gitdir: ${path.join(repository, '.git', 'worktrees', 'linked')}\n`);
  assert.equal(readBranch(linked), 'topic');
  assert.equal(readBranch(path.join(root, 'none')), null);
});

test('one dialog or launch runs at a time, while reading stays available', async t => {
  const {agents, answers} = await setup(t);
  let release;
  answers.file = new Promise(resolve => { release = resolve; });
  const choosing = agents.chooseApp();
  assert.deepEqual(await agents.chooseApp(), {ok: false, code: 'busy'});
  assert.equal((await agents.list()).ok, true);
  release(null);
  assert.deepEqual(await choosing, {ok: true, value: null});
});

test('only applications that start without a shell are accepted', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-ai-plan-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const bundle = path.join(root, 'Claude.app');
  await fs.mkdir(bundle);
  const script = path.join(root, 'run.cmd');
  await fs.writeFile(script, '');
  const exe = path.join(root, 'Claude.exe');
  await fs.writeFile(exe, '');
  const plain = path.join(root, 'notes.txt');
  await fs.writeFile(plain, '', {mode: 0o644});
  assert.deepEqual(launchPlan('darwin', bundle), {kind: 'bundle'});
  assert.equal(launchPlan('linux', bundle), null);
  assert.deepEqual(launchPlan('win32', exe), {kind: 'executable'});
  assert.equal(launchPlan('win32', script), null);
  assert.equal(launchPlan('linux', plain), null);
  assert.equal(launchPlan('linux', 'relative/app'), null);
});

test('a macOS bundle starts through open with the arguments after --args', async t => {
  const {agents, root, calls, answers} = await setup(t, {platform: 'darwin'});
  const bundle = path.join(root, 'Claude.app');
  await fs.mkdir(bundle);
  answers.file = bundle;
  await addEntry(agents, {args: ['--new'], cwd: root});
  assert.deepEqual(await agents.launch('claude'), {ok: true, value: null});
  assert.equal(calls.spawn[0].command, '/usr/bin/open');
  assert.deepEqual(calls.spawn[0].args, ['-a', bundle, '--args', '--new']);
  answers.exitCode = 1;
  assert.deepEqual(await agents.launch('claude'), {ok: false, code: 'launch-failed'});
});

test('a damaged settings file lists nothing and keeps a revision for the next save', async t => {
  const {agents, root} = await setup(t);
  await fs.mkdir(path.join(root, 'data'), {recursive: true});
  await fs.writeFile(path.join(root, 'data', FILE_NAME), '{"version":1,"entries":[{"id":"x"}]');
  const listed = value(await agents.list());
  assert.deepEqual(listed.entries, []);
  assert.match(listed.revision, /^[0-9a-f]{64}$/u);
  assert.deepEqual(value(await agents.save(listed.revision, [])).entries, []);
});
