const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');

const eventually = async (label, read) => {
  const until = Date.now() + 25000;
  let error;
  while (Date.now() < until) {
    try {
      const value = await read();
      if (value) return value;
    } catch (cause) {
      error = cause;
    }
    await delay(100);
  }
  throw new Error('Timed out: ' + label, {cause: error});
};

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

async function cdp (url, method, params) {
  const socket = new WebSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP timed out: ' + method)), 4000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({id: 1, method, params})));
      socket.addEventListener('message', message => {
        const data = JSON.parse(message.data);
        if (data.id === 1) {
          clearTimeout(timeout);
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
        }
      });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP connection failed')); });
    });
  } finally {
    socket.close();
  }
}

async function evaluate (page, expression) {
  const reply = await cdp(page, 'Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
}

const writeViaPreload = async (page, fileId, abort) => evaluate(page, `(async () => {
  const current = await EditorPreload.getInitialFile();
  const {data} = await EditorPreload.getFile(current);
  const {port1, port2} = new MessageChannel();
  let messageId = 0;
  const send = message => new Promise((resolve, reject) => {
    const id = ++messageId;
    port1.onmessage = ({data}) => {
      if (data.error) reject(data.error);
      else if (data.response?.id === id) resolve(data.response.result);
    };
    port1.postMessage({...message, id});
  });
  window.postMessage({ipcStartWriteStream: ${JSON.stringify(fileId)}}, window.origin, [port2]);
  try {
    await send({write: data});
    if (${abort}) await send({abort: true}).catch(error => {
      if (!String(error).includes("Aborted by renderer")) throw error;
    });
    else {
      await send({finish: true});
      await EditorPreload.openedFile(${JSON.stringify(fileId)});
    }
  } finally {
    port1.close();
  }
})()`);

test('real Electron isolates two SB3s, prevents duplicate launch, and recovers a stale lock', {
  skip: process.platform !== 'darwin' || !process.env.TW_D3_TEST_APP,
  timeout: 120000
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-plus-d3-profile-'));
  const data = path.join(dir, 'data');
  const first = path.join(dir, 'Alpha.sb3');
  const second = path.join(dir, 'Bravo.sb3');
  const third = path.join(dir, 'Charlie.sb3');
  const cancelled = path.join(dir, 'Aborted.sb3');
  const protectedDestination = path.join(dir, 'Plus.sb3');
  const alias = path.join(dir, 'Alias.sb2');
  const dialogPath = path.join(dir, 'test-dialog.json');
  const select = values => fs.writeFile(dialogPath, JSON.stringify(values));
  const application = path.join(process.env.TW_D3_TEST_APP, 'Contents', 'MacOS', 'TurboWarp');
  const logPath = path.join(dir, 'electron.log');
  const log = await fs.open(logPath, 'a');
  const launchers = new Set();
  const start = (...args) => {
    const processHandle = spawn(application, ['--remote-debugging-port=0', ...args], {
      cwd: dir, stdio: ['ignore', log.fd, log.fd], detached: true,
      env: {...process.env, TW_PLUS_DESKTOP_PROJECT_ISOLATION: '1', TW_PLUS_DESKTOP_DATA_DIR: data,
        TW_D3_TEST_DIALOG_PATH: dialogPath}
    });
    launchers.add(processHandle.pid);
    return processHandle;
  };
  t.after(async () => {
    for (const pid of launchers) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await log.close();
    t.diagnostic('Electron log: ' + logPath);
  });
  await fs.copyFile(process.env.TW_D3_TEST_SB3, first);
  await fs.copyFile(process.env.TW_D3_TEST_SB3, second);
  await fs.copyFile(process.env.TW_D3_TEST_SB3, third);
  await fs.symlink(first, alias);
  const original = await fs.readFile(first);

  const locks = async () => {
    const root = path.join(data, 'project-locks');
    return Promise.all((await fs.readdir(root)).filter(name => name.endsWith('.json')).map(async name => {
      const file = path.join(root, name);
      return {...JSON.parse(await fs.readFile(file, 'utf8')), file};
    }));
  };
  const lockFor = async file => (await locks()).find(lease => path.basename(lease.path) === path.basename(file));
  const browsers = async () => {
    const root = path.join(data, 'project-processes');
    const profiles = await fs.readdir(root);
    const endpoints = await Promise.all(profiles.map(async profile => {
      const portFile = path.join(root, profile, 'DevToolsActivePort');
      const [port, endpoint] = (await fs.readFile(portFile, 'utf8')).trim().split('\n');
      const origin = 'http://127.0.0.1:' + port;
      const tabs = (await (await fetch(origin + '/json/list')).json()).filter(target => target.type === 'page');
      if (tabs.length !== 1 || !tabs[0].url.startsWith('tw-editor:')) return;
      const reply = await cdp(tabs[0].webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: 'EditorPreload.getInitialFile().then(id => EditorPreload.getFile(id)).then(file => file.name)',
        awaitPromise: true, returnByValue: true
      });
      if (!reply.result.value) return;
      return {name: reply.result.value, browser: 'ws://127.0.0.1:' + port + endpoint, page: tabs[0].webSocketDebuggerUrl,
        targetId: tabs[0].id};
    }).map(pending => pending.catch(() => undefined)));
    return endpoints.filter(Boolean);
  };

  try {
    const broker = start(first, second);
    const owners = await eventually('two project locks', async () => {
      const result = await locks();
      return result.length === 2 && result;
    });
    assert.equal(new Set(owners.map(owner => owner.pid)).size, 2);
    assert(owners.every(owner => owner.pid !== broker.pid && alive(owner.pid)));
    const endpoints = await eventually('two editor windows with the respective SB3', async () => {
      const result = await browsers();
      return result.length === 2 && result;
    });
    assert.deepEqual(endpoints.map(endpoint => endpoint.name).sort(), ['Alpha.sb3', 'Bravo.sb3']);

    const duplicates = Array.from({length: 8}, (_, index) => start(index % 2 ? 'Alias.sb2' : 'alpha.sb3'));
    await Promise.all(duplicates.map(child => new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        launchers.delete(child.pid);
        code === 0 && !signal ? resolve() : reject(new Error('Duplicate launcher exit: ' + code + ' ' + signal));
      });
    })));
    assert.deepEqual((await locks()).map(owner => owner.token).sort(), owners.map(owner => owner.token).sort());
    assert.equal((await browsers()).length, 2);

    const alpha = endpoints.find(endpoint => endpoint.name === 'Alpha.sb3');
    await select({open: third});
    assert.equal(await evaluate(alpha.page, 'EditorPreload.showOpenFilePicker()'), null);
    const charlie = await eventually('the in-app file picker opened Charlie in its own editor', async () =>
      (await browsers()).find(endpoint => endpoint.name === 'Charlie.sb3'));
    assert.notEqual((await lockFor(third)).pid, (await lockFor(first)).pid);
    await cdp(charlie.browser, 'Browser.close').catch(() => {});
    await eventually('Charlie closed', async () => !(await lockFor(third)));

    await select({save: second});
    assert.equal(await evaluate(alpha.page, 'EditorPreload.showSaveFilePicker("Bravo.sb3")'), null);
    const firstOwner = await lockFor(first);
    await select({save: cancelled});
    const abandoned = await evaluate(alpha.page, 'EditorPreload.showSaveFilePicker("Aborted.sb3")');
    assert.equal((await lockFor(cancelled)).pid, firstOwner.pid);
    await writeViaPreload(alpha.page, abandoned.id, true);
    await eventually('failed write released only the Save As reservation', async () => !(await lockFor(cancelled)));
    assert.equal((await lockFor(first)).token, firstOwner.token);
    await assert.rejects(fs.stat(cancelled), {code: 'ENOENT'});

    const plusMetadata = JSON.stringify({targets: [], turboWarpPlusProject: {}});
    await fs.writeFile(protectedDestination, plusMetadata);
    await select({save: protectedDestination});
    const protectedSave = await evaluate(alpha.page, 'EditorPreload.showSaveFilePicker("Plus.sb3")');
    assert.equal((await lockFor(protectedDestination)).pid, firstOwner.pid);
    await assert.rejects(writeViaPreload(alpha.page, protectedSave.id, false), /cannot overwrite a TurboWarp Plus project/);
    await eventually('protected write released the Save As reservation', async () => !(await lockFor(protectedDestination)));
    assert.equal((await lockFor(first)).token, firstOwner.token);
    assert.equal(await fs.readFile(protectedDestination, 'utf8'), plusMetadata);

    await select({save: third});
    const destination = await evaluate(alpha.page, 'EditorPreload.showSaveFilePicker("Charlie.sb3")');
    assert.equal((await lockFor(third)).pid, firstOwner.pid);
    assert.equal((await lockFor(first)).token, firstOwner.token);
    await writeViaPreload(alpha.page, destination.id, false);
    assert.equal(await lockFor(first), undefined);
    assert.equal((await lockFor(third)).pid, firstOwner.pid);
    assert.deepEqual(await fs.readFile(third), original);
    await select({save: first});
    const back = await evaluate(alpha.page, 'EditorPreload.showSaveFilePicker("Alpha.sb3")');
    await writeViaPreload(alpha.page, back.id, false);
    assert.equal(await lockFor(third), undefined);

    const beforeClose = await lockFor(first);
    await cdp(alpha.browser, 'Target.closeTarget', {targetId: alpha.targetId}).catch(() => {});
    await eventually('normal close released only Alpha', async () => !(await lockFor(first)) && await lockFor(second));
    assert.equal(alive(beforeClose.pid), false);
    start(first);
    const workerCrash = await eventually('Alpha reopened with a new lock', () => lockFor(first));
    assert.notEqual(workerCrash.token, beforeClose.token);
    await eventually('Alpha reopened with an editor', async () => (await browsers()).find(endpoint => endpoint.name === 'Alpha.sb3'));

    process.kill(workerCrash.pid, 'SIGKILL');
    await eventually('the surviving launcher released the dead worker lock', async () => !(await lockFor(first)));
    start(first);
    const beforeCrash = await eventually('Alpha reopened after the worker crash', () => lockFor(first));
    await eventually('Alpha reopened with an editor', async () => (await browsers()).find(endpoint => endpoint.name === 'Alpha.sb3'));

    process.kill(broker.pid, 'SIGKILL');
    if (alive(beforeCrash.pid)) process.kill(beforeCrash.pid, 'SIGKILL');
    const bravo = await lockFor(second);
    if (alive(bravo.pid)) process.kill(bravo.pid, 'SIGKILL');
    await eventually('launcher and project process stopped', () => !alive(broker.pid) && !alive(beforeCrash.pid));
    assert.equal((await lockFor(first)).token, beforeCrash.token);
    const restarted = start(first);
    const recovered = await eventually('a restarted launcher reclaimed the stale lock', async () => {
      const lease = await lockFor(first);
      return lease?.token !== beforeCrash.token && lease;
    });
    assert.notEqual(recovered.pid, restarted.pid);
    assert(alive(recovered.pid));
    await eventually('Alpha recovered with an editor and readable SB3', async () =>
      (await browsers()).find(endpoint => endpoint.name === 'Alpha.sb3'));
    assert.deepEqual(await fs.readFile(first), original);

    const legacyData = path.join(dir, 'legacy-data');
    const legacyFirst = path.join(dir, 'Legacy Alpha.sb3');
    const legacySecond = path.join(dir, 'Legacy Bravo.sb3');
    await fs.copyFile(first, legacyFirst);
    await fs.copyFile(second, legacySecond);
    const legacy = spawn(application, ['--remote-debugging-port=0', legacyFirst, legacySecond], {
      cwd: dir, stdio: ['ignore', log.fd, log.fd], detached: true,
      env: {...process.env, TW_PLUS_DESKTOP_PROJECT_ISOLATION: '0', TW_PLUS_DESKTOP_DATA_DIR: legacyData}
    });
    launchers.add(legacy.pid);
    await eventually('the rollback mode uses one main process with two editor windows', async () => {
      const [port] = (await fs.readFile(path.join(legacyData, 'DevToolsActivePort'), 'utf8')).split('\n');
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      return targets.filter(target => target.type === 'page' && target.url.startsWith('tw-editor:')).length === 2;
    });
    await assert.rejects(fs.stat(path.join(legacyData, 'project-locks')), {code: 'ENOENT'});
  } catch (error) {
    t.diagnostic((await fs.readFile(logPath, 'utf8')).slice(-7000));
    throw error;
  }
});
