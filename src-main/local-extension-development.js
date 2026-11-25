const {constants} = require('node:fs');
const fs = require('node:fs/promises');
const {createHash, randomUUID} = require('node:crypto');
const path = require('node:path');

const descriptorName = 'extension-development.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const failure = code => Object.assign(new Error(code), {code});
const json = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));

const directory = async name => {
  const stat = await fs.lstat(name);
  if (!stat.isDirectory() || await fs.realpath(name) !== name) throw failure('LOCAL_EXTENSION_BOUNDARY');
  return stat;
};

const readFile = async (name, limit) => {
  const stat = await fs.lstat(name);
  if (!stat.isFile() || await fs.realpath(name) !== name) throw failure('LOCAL_EXTENSION_BOUNDARY');
  const handle = await fs.open(name, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw failure('LOCAL_EXTENSION_BOUNDARY');
    if (!sameFile(stat, before)) throw failure('LOCAL_EXTENSION_INCOMPLETE');
    if (before.size < 1 || before.size > limit) throw failure('LOCAL_EXTENSION_INCOMPLETE');
    const bytes = Buffer.alloc(before.size);
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const named = await fs.lstat(name);
    if (!named.isFile() || await fs.realpath(name) !== name) throw failure('LOCAL_EXTENSION_BOUNDARY');
    if (!sameFile(after, named)) throw failure('LOCAL_EXTENSION_INCOMPLETE');
    if (bytesRead !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) throw failure('LOCAL_EXTENSION_INCOMPLETE');
    return bytes;
  } finally {
    await handle.close();
  }
};

const openDirectory = async selected => {
  const root = await fs.realpath(selected);
  return {root, identity: await directory(root)};
};

const readDevelopmentBuild = async ({root, identity}) => {
  if (!sameFile(identity, await directory(root))) throw failure('LOCAL_EXTENSION_BOUNDARY');
  const dist = path.join(root, 'dist');
  const distIdentity = await directory(dist);
  const descriptorPath = path.join(dist, descriptorName);
  const marker = await readFile(descriptorPath, 8192);
  const spec = json(marker);
  const digest = /^[0-9a-f]{64}$/u;
  if (spec?.formatVersion !== 1 || typeof spec.id !== 'string' || !/^[a-z0-9]{1,64}$/iu.test(spec.id) ||
      typeof spec.bundle?.file !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,119}\.js$/iu.test(spec.bundle.file) ||
      spec.api?.file !== 'extension-manifest.json' || typeof spec.api.sha256 !== 'string' || !digest.test(spec.api.sha256) ||
      typeof spec.bundle.sha256 !== 'string' || !digest.test(spec.bundle.sha256)) throw failure('LOCAL_EXTENSION_DESCRIPTOR');
  const [bytes, manifest] = await Promise.all([
    readFile(path.join(dist, spec.bundle.file), 4 * 1024 * 1024),
    readFile(path.join(dist, spec.api.file), 128 * 1024)
  ]);
  if (!sameFile(identity, await directory(root))) throw failure('LOCAL_EXTENSION_BOUNDARY');
  if (!sameFile(distIdentity, await directory(dist))) throw failure('LOCAL_EXTENSION_INCOMPLETE');
  if (!marker.equals(await readFile(descriptorPath, 8192)) || sha256(bytes) !== spec.bundle.sha256 ||
      sha256(manifest) !== spec.api.sha256) throw failure('LOCAL_EXTENSION_INCOMPLETE');
  const api = json(manifest);
  if (api?.id !== spec.id || api.formatVersion !== 1 || !Array.isArray(api.blocks) || !Array.isArray(api.menus)) {
    throw failure('LOCAL_EXTENSION_DESCRIPTOR');
  }
  return {id: spec.id, sha256: spec.bundle.sha256, apiSHA256: spec.api.sha256, bytes: new Uint8Array(bytes)};
};

function installLocalExtensionDevelopment (ipc, webContents, {chooseDirectory, confirm, intervalMs = 350}) {
  const leases = new Map();
  let opening = null;
  const trusted = event => event.sender === webContents && event.senderFrame === webContents.mainFrame &&
    event.senderFrame?.url?.split(/[?#]/u, 1)[0] === 'tw-editor://./plus-gui/gui.html';
  const stop = session => {
    clearTimeout(leases.get(session)?.timer);
    leases.delete(session);
  };
  const close = () => {
    for (const session of leases.keys()) stop(session);
    opening = null;
  };
  const isCurrent = (current, generation) => leases.get(current.session) === current && current.generation === generation;
  const pause = current => {
    current.enabled = false;
    current.generation++;
    clearTimeout(current.timer);
  };
  const readCompatible = async current => {
    const next = await readDevelopmentBuild(current.directory);
    if (next.id !== current.id || next.apiSHA256 !== current.apiSHA256) throw failure('LOCAL_EXTENSION_INCOMPATIBLE');
    return next;
  };
  const schedule = current => {
    if (!current.enabled) return;
    const {generation} = current;
    if (!isCurrent(current, generation)) return;
    current.timer = setTimeout(async () => {
      try {
        const next = await readCompatible(current);
        if (!isCurrent(current, generation)) return;
        if (next.sha256 !== current.sha256) {
          current.sha256 = next.sha256;
          webContents.send('local-extension-build', {...next, session: current.session});
        }
      } catch (error) {
        if (isCurrent(current, generation) && ['LOCAL_EXTENSION_BOUNDARY', 'LOCAL_EXTENSION_INCOMPATIBLE'].includes(error.code)) {
          pause(current);
          webContents.send('local-extension-stopped', {session: current.session, code: error.code});
        }
        // The producer writes the descriptor last. Ignore missing, unreadable or incomplete generations.
      } finally {
        if (isCurrent(current, generation)) schedule(current);
      }
    }, intervalMs);
    current.timer.unref();
  };
  ipc.on('local-extension-development-enabled', event => { event.returnValue = trusted(event); });
  const handle = (name, operation) => ipc.handle('local-extension-' + name, (event, ...args) => {
    if (!trusted(event)) throw failure('LOCAL_EXTENSION_UNAVAILABLE');
    return operation(...args);
  });
  handle('start', async () => {
    if (opening) throw failure('LOCAL_EXTENSION_BUSY');
    const ticket = {};
    opening = ticket;
    try {
      const selected = await chooseDirectory();
      if (!selected || opening !== ticket) return null;
      const selectedDirectory = await openDirectory(selected);
      const build = await readDevelopmentBuild(selectedDirectory);
      if (opening !== ticket) return null;
      if (Array.from(leases.values()).some(current => current.id === build.id ||
          sameFile(current.directory.identity, selectedDirectory.identity))) {
        throw failure('LOCAL_EXTENSION_ALREADY_WATCHING');
      }
      if (!(await confirm(selectedDirectory.root, build.id)) || opening !== ticket) return null;
      const session = randomUUID();
      const current = {directory: selectedDirectory, id: build.id, apiSHA256: build.apiSHA256,
        sha256: build.sha256, session, enabled: true, generation: 0};
      leases.set(session, current);
      schedule(current);
      return {...build, session, directory: selectedDirectory.root};
    } catch (error) {
      if (['LOCAL_EXTENSION_BOUNDARY', 'LOCAL_EXTENSION_ALREADY_WATCHING'].includes(error.code)) throw error;
      throw failure('LOCAL_EXTENSION_BUILD_REQUIRED');
    } finally {
      if (opening === ticket) opening = null;
    }
  });
  handle('authorize', (session, id, digest) => {
    const current = leases.get(session);
    return Boolean(current?.enabled && current.id === id && current.sha256 === digest);
  });
  handle('set-enabled', async (session, enabled) => {
    const current = leases.get(session);
    if (!current || typeof enabled !== 'boolean') throw failure('LOCAL_EXTENSION_UNAVAILABLE');
    if (!enabled) {
      pause(current);
      return null;
    }
    if (current.enabled) throw failure('LOCAL_EXTENSION_BUSY');
    const generation = ++current.generation;
    let build;
    try {
      build = await readCompatible(current);
    } catch (error) {
      if (['LOCAL_EXTENSION_BOUNDARY', 'LOCAL_EXTENSION_INCOMPATIBLE'].includes(error.code)) throw error;
      throw failure('LOCAL_EXTENSION_BUILD_REQUIRED');
    }
    if (!isCurrent(current, generation)) return null;
    current.enabled = true;
    current.sha256 = build.sha256;
    schedule(current);
    return {...build, session};
  });
  handle('stop', session => session === undefined ? close() : stop(session));
  webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) close();
  });
  webContents.on('render-process-gone', close);
  webContents.once('destroyed', close);
}

module.exports = {installLocalExtensionDevelopment, openDirectory, readDevelopmentBuild};
