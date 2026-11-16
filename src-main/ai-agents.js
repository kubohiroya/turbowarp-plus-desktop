// Desktop applications that the AI agent menu of the Plus Editor launches.
// The renderer only names saved entries by ID. It cannot register or change what runs without the user
// choosing the application in the OS file dialog and confirming the change in an OS dialog.

const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const FILE_NAME = 'ai-agents.json';
const DEFAULT_DIRECTORY = '{projectFolder}';
const VARIABLES = /\{(projectFolder|repository|branch)\}/gu;
const LIMITS = {entries: 32, id: 64, name: 120, args: 64, arg: 4096, cwd: 1024, url: 2048};

class AgentError extends Error {
  constructor (code) {
    super(code);
    this.code = code;
  }
}

const fail = code => { throw new AgentError(code); };
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');

function checkUrl (value) {
  if (value === undefined) return undefined;
  if (!text(value, LIMITS.url)) fail('invalid-url');
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    if (new URL(trimmed).protocol === 'https:') return trimmed;
  } catch {
    // fall through
  }
  fail('invalid-url');
}

/** Validates a draft from the renderer. Nothing here is trusted until the OS dialog confirms it. */
function checkDraft (draft) {
  if (!draft || typeof draft !== 'object') fail('invalid');
  const {id, name, args, cwd, selection, url} = draft;
  if (!text(id, LIMITS.id) || !/^[\w-]+$/u.test(id)) fail('invalid');
  if (!text(name, LIMITS.name) || !name.trim()) fail('invalid');
  if (!Array.isArray(args) || args.length > LIMITS.args || !args.every(arg => text(arg, LIMITS.arg))) fail('invalid');
  if (!text(cwd, LIMITS.cwd)) fail('invalid');
  if (selection !== undefined && !text(selection, LIMITS.id)) fail('invalid');
  return {id, name: name.trim(), args: [...args], cwd, selection, url: checkUrl(url)};
}

const publicEntry = ({id, name, application, args, cwd, url}) =>
  ({id, name, application, args: [...args], cwd, ...(url ? {url} : {})});

const sameLaunch = (a, b) => a.application === b.application && a.cwd === b.cwd &&
  JSON.stringify(a.args) === JSON.stringify(b.args);

/** How to start an application on this platform, or null when it cannot be started without a shell. */
function launchPlan (platform, application) {
  if (!path.isAbsolute(application)) return null;
  let stat;
  try {
    stat = fs.statSync(application);
  } catch {
    return null;
  }
  if (platform === 'darwin' && /\.app$/iu.test(application)) {
    // `open` hands the arguments to the bundle. It does not take a working directory.
    return stat.isDirectory() ? {kind: 'bundle'} : null;
  }
  if (!stat.isFile()) return null;
  if (platform === 'win32') return /\.exe$/iu.test(application) ? {kind: 'executable'} : null;
  try {
    fs.accessSync(application, fs.constants.X_OK);
  } catch {
    return null;
  }
  return {kind: 'executable'};
}

/** The enclosing Git work tree of a folder, or null. A `.git` file marks a linked worktree. */
function findRepository (folder) {
  for (let current = folder; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return null;
  }
}

function gitDirectory (repository) {
  const marker = path.join(repository, '.git');
  const stat = fs.statSync(marker);
  if (stat.isDirectory()) return marker;
  const match = /^gitdir:\s*(.+?)\s*$/mu.exec(fs.readFileSync(marker, 'utf8'));
  if (!match) throw new Error('Not a Git work tree.');
  return path.resolve(repository, match[1]);
}

/** The checked out branch, or null for a detached HEAD or an unreadable repository. */
function readBranch (repository) {
  if (!repository) return null;
  try {
    const head = fs.readFileSync(path.join(gitDirectory(repository), 'HEAD'), 'utf8');
    const match = /^ref: refs\/heads\/(.+?)\s*$/u.exec(head);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Replaces the placeholders, or fails when a value that the entry uses is not chosen. */
function expand (value, context) {
  return value.replace(VARIABLES, (match, key) => context[key] ?? fail('missing-context'));
}

// Variables that only make sense inside this app are not handed to the launched application.
const childEnvironment = env => Object.fromEntries(Object.entries(env)
  .filter(([key]) => !/^(ELECTRON_|TW_PLUS_|CHROME_|GOOGLE_API_KEY)/u.test(key)));

const messages = {
  en: {
    confirmTitle: 'Save desktop applications',
    confirm: 'Allow TurboWarp Plus Desktop to launch these applications from the AI agent menu?',
    allow: 'Allow and save',
    cancel: 'Cancel',
    application: 'Application',
    args: 'Arguments',
    cwd: 'Working directory',
    none: '(none)',
    chooseApp: 'Choose an application to launch',
    chooseProject: 'Choose the project folder',
    chooseRepository: 'Choose the Git repository'
  },
  ja: {
    confirmTitle: 'デスクトップアプリの保存',
    confirm: 'AI エージェントのメニューから、次のアプリを起動できるようにしますか？',
    allow: '許可して保存',
    cancel: 'キャンセル',
    application: 'アプリ',
    args: '引数',
    cwd: '作業ディレクトリ',
    none: '（なし）',
    chooseApp: '起動するアプリを選択',
    chooseProject: 'プロジェクトフォルダを選択',
    chooseRepository: 'Git リポジトリを選択'
  }
};
const strings = locale => messages[/^ja(?:-|$)/iu.test(locale ?? '') ? 'ja' : 'en'];

/**
 * The settings shared by every editor window. Each editor process writes the file atomically and checks the
 * revision first, so two windows cannot overwrite each other's change silently.
 */
function createAgentStore (directory) {
  const file = path.join(directory, FILE_NAME);
  let tail = Promise.resolve();
  const serial = operation => {
    const result = tail.then(operation);
    tail = result.then(() => {}, () => {});
    return result;
  };
  const read = async () => {
    let source;
    try {
      source = await files.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return {revision: null, entries: []};
      throw error;
    }
    const revision = createHash('sha256').update(source).digest('hex');
    let entries = [];
    try {
      const data = JSON.parse(source);
      if (data?.version === 1 && Array.isArray(data.entries)) {
        entries = data.entries.filter(entry => {
          try {
            checkDraft(entry);
            return text(entry.application, 4096) && path.isAbsolute(entry.application);
          } catch {
            return false;
          }
        }).map(publicEntry);
      }
    } catch {
      // A damaged file lists nothing. The next save replaces it after the user confirms.
    }
    return {revision, entries};
  };
  const write = async entries => {
    await files.mkdir(directory, {recursive: true});
    const temporary = `${file}.${randomUUID()}.tmp`;
    await files.writeFile(temporary, `${JSON.stringify({version: 1, entries: entries.map(publicEntry)}, null, 2)}\n`,
      {mode: 0o600});
    await files.rename(temporary, file);
  };
  return {read, write, serial};
}

/**
 * The port of one editor window. `dialogs` and `spawn` are injected so that tests do not need Electron.
 * - dialogs.chooseFile(title) / dialogs.chooseDirectory(title): an absolute path or null.
 * - dialogs.confirm({title, message, detail, allow, cancel}): true when the user allows.
 */
function createAiAgents ({store, dialogs, spawn, platform = process.platform, env = process.env, locale = () => 'en'}) {
  const selections = new Map();
  const context = {projectFolder: null, repository: null};
  let busy = false;

  const currentContext = () => ({...context, branch: readBranch(context.repository)});

  const respond = async operation => {
    try {
      return {ok: true, value: await operation()};
    } catch (error) {
      if (error instanceof AgentError) return {ok: false, code: error.code};
      console.error(error);
      return {ok: false, code: 'unavailable'};
    }
  };
  // Reading never waits for a dialog. Dialogs, saving and launching run one at a time.
  const reading = operation => (...args) => respond(() => operation(...args));
  const exclusive = operation => async (...args) => {
    if (busy) return {ok: false, code: 'busy'};
    busy = true;
    try {
      return await respond(() => operation(...args));
    } finally {
      busy = false;
    }
  };

  const start = (entry, plan, args, cwd) => new Promise(resolve => {
    const [command, commandArgs] = plan.kind === 'bundle'
      ? ['/usr/bin/open', ['-a', entry.application, ...(args.length ? ['--args', ...args] : [])]]
      : [entry.application, args];
    let child;
    try {
      child = spawn(command, commandArgs, {
        cwd, detached: plan.kind !== 'bundle', stdio: 'ignore', shell: false, windowsHide: false, env: childEnvironment(env)
      });
    } catch {
      resolve('launch-failed');
      return;
    }
    child.once('error', () => resolve('launch-failed'));
    if (plan.kind === 'bundle') {
      child.once('exit', code => resolve(code === 0 ? null : 'launch-failed'));
    } else {
      child.once('spawn', () => {
        child.unref();
        resolve(null);
      });
    }
  });

  return {
    list: reading(() => store.read()),

    context: reading(async () => currentContext()),

    chooseContext: exclusive(async kind => {
      if (kind !== 'project' && kind !== 'repository') fail('invalid');
      const words = strings(locale());
      const folder = await dialogs.chooseDirectory(kind === 'project' ? words.chooseProject : words.chooseRepository);
      if (!folder) return null;
      if (!path.isAbsolute(folder) || !fs.statSync(folder, {throwIfNoEntry: false})?.isDirectory()) {
        fail('invalid-directory');
      }
      if (kind === 'repository') {
        const repository = findRepository(folder);
        if (repository !== folder) fail('invalid-directory');
        context.repository = repository;
      } else {
        context.projectFolder = folder;
        // A project folder inside a work tree also chooses that repository.
        context.repository = findRepository(folder) ?? context.repository;
      }
      return currentContext();
    }),

    chooseApp: exclusive(async () => {
      const application = await dialogs.chooseFile(strings(locale()).chooseApp);
      if (!application) return null;
      if (!launchPlan(platform, application)) fail('app-missing');
      const selection = randomUUID();
      selections.set(selection, application);
      return {selection, application};
    }),

    save: exclusive((revision, drafts) => store.serial(async () => {
      if (!Array.isArray(drafts) || drafts.length > LIMITS.entries) fail('invalid');
      const checked = drafts.map(checkDraft);
      if (new Set(checked.map(entry => entry.id)).size !== checked.length) fail('invalid');
      const saved = await store.read();
      if (revision !== saved.revision) fail('conflict');
      const previous = new Map(saved.entries.map(entry => [entry.id, entry]));
      const entries = checked.map(({selection, ...entry}) => {
        const application = selection === undefined ? previous.get(entry.id)?.application : selections.get(selection);
        if (!application) fail('invalid');
        return {...entry, application};
      });
      const changed = entries.filter(entry => !previous.has(entry.id) || !sameLaunch(entry, previous.get(entry.id)));
      if (changed.length) {
        const words = strings(locale());
        const detail = changed.map(entry => [
          entry.name,
          `${words.application}: ${entry.application}`,
          `${words.args}: ${entry.args.length ? JSON.stringify(entry.args) : words.none}`,
          `${words.cwd}: ${entry.cwd.trim() || DEFAULT_DIRECTORY}`
        ].join('\n')).join('\n\n');
        const allowed = await dialogs.confirm({
          title: words.confirmTitle, message: words.confirm, detail, allow: words.allow, cancel: words.cancel
        });
        if (!allowed) fail('cancelled');
      }
      await store.write(entries);
      for (const {selection} of checked) if (selection !== undefined) selections.delete(selection);
      return store.read();
    })),

    launch: exclusive(async id => {
      if (!text(id, LIMITS.id)) fail('unknown');
      const entry = (await store.read()).entries.find(item => item.id === id);
      if (!entry) fail('unknown');
      const values = currentContext();
      const args = entry.args.map(arg => expand(arg, values));
      const cwd = expand(entry.cwd.trim() || DEFAULT_DIRECTORY, values);
      if (!path.isAbsolute(cwd) || !fs.statSync(cwd, {throwIfNoEntry: false})?.isDirectory()) fail('invalid-directory');
      const plan = launchPlan(platform, entry.application);
      if (!plan) fail('app-missing');
      const failure = await start(entry, plan, args, cwd);
      if (failure) fail(failure);
      return null;
    })
  };
}

module.exports = {createAgentStore, createAiAgents, readBranch, launchPlan, FILE_NAME};
