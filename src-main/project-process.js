const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {app, dialog} = require('electron');
const {projectIsolation, projectAssetTransfer} = require('../config/feature-flags');
const {ProjectAssets, validAssetInput} = require('./project-assets');
const {ProjectLocks, ProjectBusy, identify, isSB3, assertOwned} = require('./project-lock');

const dataRoot = process.env.TW_PLUS_DESKTOP_DATA_DIR ||
  path.join(app.getPath('appData'), 'TurboWarp Plus Desktop');
const worker = process.env.TW_PLUS_DESKTOP_PROJECT_ROLE === 'worker';
const profile = worker ? process.env.TW_PLUS_DESKTOP_PROJECT_PROFILE : dataRoot;

const resolveInput = (file, directory) => {
  if (/^https?:\/\//i.test(file)) return file;
  if (/^file:/i.test(file)) return require('node:url').fileURLToPath(file);
  return path.resolve(directory, file);
};

const parseArguments = argv => ({
  files: argv.slice(process.defaultApp ? 2 : 1).filter(arg => !arg.startsWith('-')),
  fullscreen: argv.includes('--fullscreen')
});

const focusWindow = window => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

const report = async error => {
  console.error(error.message);
  await app.whenReady();
  dialog.showErrorBox('TurboWarp Plus Desktop', error.message);
};

const launcher = () => {
  if (!app.requestSingleInstanceLock()) return app.exit();
  // Only this process can recover or replace records, including after launcher restart.
  const locks = new ProjectLocks(path.join(dataRoot, 'project-locks'));
  const assets = projectAssetTransfer && new ProjectAssets(path.join(dataRoot, 'project-transfers'));
  const children = new Map();
  const queued = [];
  let started = false;
  let lastWorker;
  const open = (files, fullscreen, directory) => {
    for (const file of files.length ? files : [null]) {
      try {
        const input = file === null ? null : resolveInput(file, directory);
        const local = input && !/^https?:\/\//i.test(input) ? identify(input) : null;
        const identity = local && (isSB3(input) || isSB3(local.path)) ? local : null;
        if (identity) locks.check(identity);
        const childProfile = fs.mkdtempSync(path.join(path.join(dataRoot, 'project-processes'), 'editor-'));
        const options = process.defaultApp ? [path.resolve(process.argv[1])] : [];
        if (app.commandLine.hasSwitch('remote-debugging-port')) options.push('--remote-debugging-port=0');
        const child = spawn(process.execPath, options, {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          serialization: assets ? 'advanced' : 'json',
          env: {...process.env, TW_PLUS_DESKTOP_PROJECT_ROLE: 'worker', TW_PLUS_DESKTOP_PROJECT_PROFILE: childProfile}
        });
        const leases = new Map();
        const discard = lease => {
          locks.release(lease);
          leases.delete(lease.token);
        };
        child.on('error', error => { void report(error); });
        child.once('exit', () => {
          children.delete(child.pid);
          for (const lease of leases.values()) {
            try { discard(lease); } catch (error) { console.error(error.message); }
          }
          try { fs.rmSync(childProfile, {recursive: true, force: true}); } catch (error) { console.error(error.message); }
        });
        if (!child.pid) continue;
        children.set(child.pid, child);
        lastWorker = child;
        try {
          const lease = identity && locks.acquire(identity, child.pid);
          if (lease) leases.set(lease.token, lease);
          let active = lease;
          const transferOwner = Symbol();
          child.on('message', async message => {
            const {id, command, args} = message;
            const reply = (result, error) => {
              if (child.connected) child.send({id, result, error}, () => {});
            };
            try {
              if (command === 'open') {
                open(args.files, false, process.cwd());
                reply(true);
              } else if (command === 'reserve') {
                if (!isSB3(args.path) || !path.isAbsolute(args.path)) throw new Error('Select an SB3 destination.');
                const destination = identify(args.path, true);
                if (active?.key === destination.key) return reply(active);
                // A single save picker may be outstanding for each editor.
                for (const lease of leases.values()) {
                  if (lease !== active) throw new Error('Another project save is in progress.');
                }
                const reserved = locks.acquire(destination, child.pid);
                leases.set(reserved.token, reserved);
                reply(reserved);
              } else if (command === 'commit') {
                const next = leases.get(args.token);
                if (!next) throw new Error('No project lock for this destination.');
                const previous = active;
                active = next;
                if (previous && previous !== active) discard(previous);
                reply(true);
              } else if (command === 'cancel') {
                const reserved = leases.get(args.token);
                if (reserved && reserved !== active) discard(reserved);
                reply(true);
              } else if (command === 'detach') {
                if (active?.token === args.token) {
                  discard(active);
                  active = null;
                }
                reply(true);
              } else if (assets && command === 'stage-transfer-asset') {
                reply(await assets.stage(transferOwner, args.kind, args.bytes));
              } else if (assets && command === 'read-transfer-asset') {
                reply(await assets.read(args.transferId, args.asset));
              } else if (assets && command === 'discard-transfer-asset') {
                reply(await assets.discard(transferOwner, args.transferId));
              }
            } catch (error) {
              reply(null, error.message);
              const owner = error instanceof ProjectBusy && children.get(error.owner.pid);
              if (owner?.connected) owner.send({focus: true}, () => {});
            }
          });
          child.send({start: true, file: lease?.path ?? input, fullscreen, lease}, error => {
            if (error) child.kill();
          });
        } catch (error) {
          child.kill();
          throw error;
        }
      } catch (error) {
        const owner = error instanceof ProjectBusy && children.get(error.owner.pid);
        if (owner?.connected) owner.send({focus: true}, () => {});
        else void report(error);
      }
    }
  };

  fs.mkdirSync(path.join(dataRoot, 'project-processes'), {recursive: true, mode: 0o700});
  if (assets) {
    const sweep = () => assets.sweep().catch(error => { console.error(error.message); });
    void sweep();
    setInterval(sweep, 60_000).unref();
  }
  app.on('open-file', (event, file) => {
    event.preventDefault();
    if (started) open([file], false, process.cwd());
    else queued.push({files: [file], fullscreen: false, directory: process.cwd()});
  });
  app.on('second-instance', (event, argv, directory) => {
    const {files, fullscreen} = parseArguments(argv);
    if (started) open(files, fullscreen, directory);
    else queued.push({files, fullscreen, directory});
  });
  app.on('activate', () => {
    if (!started) return;
    if (lastWorker?.connected) lastWorker.send({focus: true}, () => {});
    else if (!children.size) open([], false, process.cwd());
  });
  app.on('window-all-closed', () => {});
  if (process.platform === 'darwin') app.dock?.hide();
  void app.whenReady().then(() => {
    const {files, fullscreen} = parseArguments(process.argv);
    started = true;
    if (files.length || !queued.length) open(files, fullscreen, process.cwd());
    for (const job of queued) open(job.files, job.fullscreen, job.directory);
  });
};

let start;
let editor;
let activeLease;
let resolveStart;
const ready = new Promise(resolve => { resolveStart = resolve; });
const replies = new Map();
let nextId = 0;
const request = (command, args) => new Promise((resolve, reject) => {
  if (!process.connected) return reject(new Error('The project launcher is unavailable.'));
  const id = ++nextId;
  replies.set(id, {resolve, reject});
  process.send({id, command, args}, error => {
    if (error && replies.delete(id)) reject(error);
  });
});

const open = files => request('open', {files}).catch(error => { void report(error); });
const reserve = file => request('reserve', {path: file});
const cancel = lease => lease && lease !== activeLease && request('cancel', {token: lease.token});
const commit = async lease => {
  if (lease === activeLease) return;
  await request('commit', {token: lease.token});
  activeLease = lease;
};
const detach = async () => {
  const lease = activeLease;
  if (!lease) return;
  await request('detach', {token: lease.token});
  if (activeLease === lease) activeLease = null;
};
const verify = lease => {
  if (!process.connected) throw new Error('The project launcher is unavailable.');
  assertOwned(lease);
};

const bootstrap = runEditor => {
  app.setName('TurboWarp Plus Desktop');
  if (!profile || (worker && (!projectIsolation || !process.connected))) return app.exit(1);
  fs.mkdirSync(profile, {recursive: true, mode: 0o700});
  app.setPath('userData', profile);
  if (!projectIsolation) return runEditor();
  if (!worker) return launcher();
  process.on('message', message => {
    if (message.start && !start) {
      start = message;
      activeLease = message.lease;
      try {
        if (activeLease) verify(activeLease);
        resolveStart(start);
      } catch (error) {
        console.error(error.message);
        app.exit(1);
      }
    } else if (message.focus) {
      focusWindow(editor?.window);
    } else {
      const reply = replies.get(message.id);
      if (reply && replies.delete(message.id)) {
        if (message.error) reply.reject(new Error(message.error));
        else reply.resolve(message.result);
      }
    }
  });
  process.once('disconnect', () => {
    for (const reply of replies.values()) reply.reject(new Error('The project launcher exited.'));
    replies.clear();
    if (start) app.quit();
    else app.exit(1);
  });
  return runEditor();
};

const stageTransferAsset = (kind, bytes) => {
  if (!validAssetInput(kind, bytes)) throw new Error('Invalid project transfer asset.');
  return request('stage-transfer-asset', {kind, bytes});
};

module.exports = {
  bootstrap, worker, open, reserve, cancel, commit, detach, verify, ready, stageTransferAsset,
  readTransferAsset: (transferId, asset) => request('read-transfer-asset', {transferId, asset}),
  discardTransferAsset: transferId => request('discard-transfer-asset', {transferId}),
  initialLease: () => activeLease,
  setEditor: window => { editor = window; }
};
