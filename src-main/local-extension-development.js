const {constants} = require('node:fs');
const fs = require('node:fs/promises');
const {createHash, randomUUID} = require('node:crypto');
const {SourceMap} = require('node:module');
const path = require('node:path');

const descriptorName = 'extension-development.json';
const digest = /^[0-9a-f]{64}$/u;
const projectSource = /^src\/(?:[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\/)*[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\.(?:[cm]?[jt]s|[jt]sx)$/iu;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const failure = code => Object.assign(new Error(code), {code});
const json = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const coordinate = value => Number.isSafeInteger(value) && value > 0 && value <= 9999999;

const directory = async name => {
  const stat = await fs.lstat(name);
  if (!stat.isDirectory() || await fs.realpath(name) !== name) throw failure('LOCAL_EXTENSION_BOUNDARY');
  return stat;
};

const readFile = async (name, limit, limitCode = 'LOCAL_EXTENSION_INCOMPLETE') => {
  const stat = await fs.lstat(name);
  if (!stat.isFile() || await fs.realpath(name) !== name) throw failure('LOCAL_EXTENSION_BOUNDARY');
  const handle = await fs.open(name, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1) throw failure('LOCAL_EXTENSION_BOUNDARY');
    // An atomic rename can unlink the open inode while a new build is being published.
    if (before.nlink === 0 || !sameFile(stat, before)) throw failure('LOCAL_EXTENSION_INCOMPLETE');
    if (before.size > limit) throw failure(limitCode);
    if (before.size < 1 && limitCode === 'LOCAL_EXTENSION_INCOMPLETE') throw failure(limitCode);
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

const assertSourceMap = (bytes, bundleFile) => {
  const map = json(bytes);
  if (map?.version !== 3 || (map.file !== undefined && map.file !== bundleFile) ||
      (map.sourceRoot != null && map.sourceRoot !== '') || map.sourcesContent != null || map.sections !== undefined ||
      !Array.isArray(map.sources) || map.sources.length > 1024 || map.sources.some(source =>
        typeof source !== 'string' || (source !== '[external]' && !projectSource.test(source))) ||
      !Array.isArray(map.names) || map.names.some(name => typeof name !== 'string') ||
      typeof map.mappings !== 'string' || !/^[a-z\d+/;,]*$/iu.test(map.mappings)) {
    throw failure('LOCAL_EXTENSION_DESCRIPTOR');
  }
  return map;
};

const readCompletedBuild = async read => {
  const marker = await read(descriptorName, 8192);
  const spec = json(marker);
  if (spec?.formatVersion !== 1 || typeof spec.id !== 'string' || !/^[a-z0-9]{1,64}$/iu.test(spec.id) ||
      typeof spec.bundle?.file !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,119}\.js$/iu.test(spec.bundle.file) ||
      spec.api?.file !== 'extension-manifest.json' || typeof spec.api.sha256 !== 'string' || !digest.test(spec.api.sha256) ||
      typeof spec.bundle.sha256 !== 'string' || !digest.test(spec.bundle.sha256)) throw failure('LOCAL_EXTENSION_DESCRIPTOR');
  const sourceMap = spec.sourceMap;
  if (sourceMap !== undefined && (sourceMap?.file !== spec.bundle.file + '.map' ||
      typeof sourceMap.sha256 !== 'string' || !digest.test(sourceMap.sha256))) throw failure('LOCAL_EXTENSION_DESCRIPTOR');
  const [bytes, manifest, map] = await Promise.all([
    read(spec.bundle.file, 4 * 1024 * 1024),
    read(spec.api.file, 128 * 1024),
    sourceMap && read(sourceMap.file, 2 * 1024 * 1024)
  ]);
  if (!marker.equals(await read(descriptorName, 8192)) || sha256(bytes) !== spec.bundle.sha256 ||
      sha256(manifest) !== spec.api.sha256 ||
      (map && sha256(map) !== sourceMap.sha256)) throw failure('LOCAL_EXTENSION_INCOMPLETE');
  const sourceMapPayload = map && assertSourceMap(map, spec.bundle.file);
  const api = json(manifest);
  if (api?.id !== spec.id || api.formatVersion !== 1 || !Array.isArray(api.blocks) || !Array.isArray(api.menus)) {
    throw failure('LOCAL_EXTENSION_DESCRIPTOR');
  }
  const build = {id: spec.id, sha256: spec.bundle.sha256, apiSHA256: spec.api.sha256, bytes: new Uint8Array(bytes),
    ...(sourceMap && {sourceMapSHA256: sourceMap.sha256})};
  return {build, diagnostic: {sha256: build.sha256, sourceMapSHA256: build.sourceMapSHA256, sourceMapPayload}};
};

const readSnapshot = async ({root, identity}) => {
  if (!sameFile(identity, await directory(root))) throw failure('LOCAL_EXTENSION_BOUNDARY');
  const dist = path.join(root, 'dist');
  const distIdentity = await directory(dist);
  const snapshot = await readCompletedBuild((name, limit) => readFile(path.join(dist, name), limit));
  if (!sameFile(identity, await directory(root))) throw failure('LOCAL_EXTENSION_BOUNDARY');
  if (!sameFile(distIdentity, await directory(dist))) throw failure('LOCAL_EXTENSION_INCOMPLETE');
  return snapshot;
};

const buildFromSource = async (builder, source, signal) => {
  const files = await builder.build(source, signal);
  return readCompletedBuild((name, limit) => {
    const bytes = files.get(name);
    if (!bytes || bytes.length > limit) throw failure('LOCAL_EXTENSION_SOURCE_LIMIT');
    return bytes;
  });
};

const sourceErrors = new Set([
  'LOCAL_EXTENSION_SOURCE_UNAVAILABLE', 'LOCAL_EXTENSION_SOURCE_LIMIT', 'LOCAL_EXTENSION_SOURCE_TIMEOUT',
  'LOCAL_EXTENSION_SOURCE_FAILED', 'LOCAL_EXTENSION_SOURCE_CANCELLED', 'LOCAL_EXTENSION_SOURCE_BUSY'
]);
const sourceError = error => sourceErrors.has(error.code) ? error.code : 'LOCAL_EXTENSION_SOURCE_FAILED';

const readDevelopmentBuild = async target => (await readSnapshot(target)).build;
const matchBuild = (snapshot, sha256, sourceMapSHA256) =>
  snapshot?.sha256 === sha256 && snapshot.sourceMapSHA256 === sourceMapSHA256;

function installLocalExtensionDevelopment (ipc, webContents, {chooseDirectory, confirm, sourceBuilder, intervalMs = 350}) {
  const leases = new Map();
  let opening = null;
  const trusted = event => event.sender === webContents && event.senderFrame === webContents.mainFrame &&
    event.senderFrame?.url?.split(/[?#]/u, 1)[0] === 'tw-editor://./plus-gui/gui.html';
  const stop = session => {
    const current = leases.get(session);
    clearTimeout(current?.timer);
    current?.controller?.abort();
    leases.delete(session);
  };
  const close = () => {
    for (const session of leases.keys()) stop(session);
    opening?.controller.abort();
    opening = null;
  };
  const isCurrent = (current, generation) => leases.get(current.session) === current && current.generation === generation;
  const publishArtifacts = (current, waiting, code) => {
    if (current.waiting === waiting && current.buildError === code) return;
    current.waiting = waiting;
    current.buildError = code;
    webContents.send('local-extension-artifacts', {session: current.session, waiting, ...(code && {code})});
  };
  const pause = current => {
    current.enabled = false;
    current.waiting = false;
    current.missed = false;
    current.generation++;
    clearTimeout(current.timer);
    current.controller?.abort();
  };
  const checkCompatible = (snapshot, current) => {
    if (snapshot.build.id !== current.id || snapshot.build.apiSHA256 !== current.apiSHA256) {
      throw failure('LOCAL_EXTENSION_INCOMPATIBLE');
    }
    return snapshot;
  };
  const readCompatible = async current => {
    if (current.mode !== 'source') return checkCompatible(await readSnapshot(current.directory), current);
    const {signal} = current.controller;
    const source = await sourceBuilder.read(current.directory, signal, readFile);
    if (source.id !== current.id) throw failure('LOCAL_EXTENSION_INCOMPATIBLE');
    if (source.digest === current.failedSource?.digest) throw failure(current.failedSource.code);
    if (source.digest === current.sourceDigest) return current.snapshot;
    let next;
    try {
      next = await buildFromSource(sourceBuilder, source, signal);
    } catch (error) {
      if (!signal.aborted && error.code !== 'LOCAL_EXTENSION_SOURCE_BUSY') {
        current.failedSource = {digest: source.digest, code: sourceError(error)};
      }
      throw error;
    }
    signal.throwIfAborted();
    checkCompatible(next, current);
    current.sourceDigest = source.digest;
    current.snapshot = next;
    current.failedSource = undefined;
    return next;
  };
  const schedule = current => {
    if (!current.enabled) return;
    const {generation} = current;
    if (!isCurrent(current, generation)) return;
    current.timer = setTimeout(async () => {
      try {
        const snapshot = await readCompatible(current);
        const {build: next, diagnostic} = snapshot;
        if (!isCurrent(current, generation)) return;
        current.missed = false;
        publishArtifacts(current, false);
        if (next.sha256 !== current.sha256 || next.sourceMapSHA256 !== current.sourceMapSHA256) {
          Object.assign(current, {sha256: next.sha256, sourceMapSHA256: next.sourceMapSHA256, diagnostic});
          webContents.send('local-extension-build', {...next, session: current.session});
        }
      } catch (error) {
        if (!isCurrent(current, generation)) return;
        if (error.code === 'LOCAL_EXTENSION_SOURCE_BUSY') return;
        if (['LOCAL_EXTENSION_BOUNDARY', 'LOCAL_EXTENSION_INCOMPATIBLE'].includes(error.code)) {
          pause(current);
          webContents.send('local-extension-stopped', {session: current.session, code: error.code});
        } else if (current.mode === 'source') {
          publishArtifacts(current, false, sourceError(error));
        } else if (current.missed) {
          // The producer may be publishing files. Report a gap only after two failed reads.
          publishArtifacts(current, true);
        } else {
          current.missed = true;
        }
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
  ipc.on('local-extension-source-build-enabled', event => { event.returnValue = trusted(event) && Boolean(sourceBuilder); });
  handle('cancel-start', () => {
    opening?.controller.abort();
    opening = null;
  });
  handle('start', async (mode = 'artifact') => {
    if (mode !== 'artifact' && (mode !== 'source' || !sourceBuilder)) throw failure('LOCAL_EXTENSION_SOURCE_UNAVAILABLE');
    if (opening) throw failure('LOCAL_EXTENSION_BUSY');
    const ticket = {controller: new AbortController()};
    const {signal} = ticket.controller;
    opening = ticket;
    try {
      const selected = await chooseDirectory();
      if (!selected || opening !== ticket) return null;
      const selectedDirectory = await openDirectory(selected);
      const source = mode === 'source' ? await sourceBuilder.read(selectedDirectory, signal, readFile) : null;
      let snapshot = source ? null : await readSnapshot(selectedDirectory);
      const id = source?.id ?? snapshot.build.id;
      if (opening !== ticket) return null;
      if (Array.from(leases.values()).some(current => current.id === id ||
          sameFile(current.directory.identity, selectedDirectory.identity))) {
        throw failure('LOCAL_EXTENSION_ALREADY_WATCHING');
      }
      if (!(await confirm(selectedDirectory.root, id, mode)) || opening !== ticket) return null;
      if (source) snapshot = await buildFromSource(sourceBuilder, source, signal);
      if (opening !== ticket) return null;
      const {build, diagnostic} = snapshot;
      if (build.id !== id) throw failure('LOCAL_EXTENSION_INCOMPATIBLE');
      const session = randomUUID();
      const current = {directory: selectedDirectory, id, mode, controller: ticket.controller,
        sourceDigest: source?.digest, snapshot: source ? snapshot : null, apiSHA256: build.apiSHA256,
        sha256: build.sha256, sourceMapSHA256: build.sourceMapSHA256, session, enabled: true, generation: 0,
        waiting: false, missed: false, diagnostic, staged: null, applied: null};
      leases.set(session, current);
      schedule(current);
      return {...build, session, mode, directory: selectedDirectory.root};
    } catch (error) {
      if (opening !== ticket) return null;
      if (['LOCAL_EXTENSION_BOUNDARY', 'LOCAL_EXTENSION_ALREADY_WATCHING', 'LOCAL_EXTENSION_INCOMPATIBLE'].includes(error.code)) throw error;
      throw failure(mode === 'source' ? sourceError(error) : 'LOCAL_EXTENSION_BUILD_REQUIRED');
    } finally {
      if (opening === ticket) opening = null;
    }
  });
  handle('authorize', (session, id, digest) => {
    const current = leases.get(session);
    return Boolean(current?.enabled && current.id === id && current.sha256 === digest);
  });
  handle('retain-diagnostics', (session, sha256, mapSHA256, applied) => {
    const current = leases.get(session);
    if (!current?.enabled || typeof sha256 !== 'string' || !digest.test(sha256) || typeof applied !== 'boolean' ||
        (mapSHA256 !== undefined && (typeof mapSHA256 !== 'string' || !digest.test(mapSHA256)))) return false;
    if (!applied) {
      if (!matchBuild(current.diagnostic, sha256, mapSHA256)) return false;
      current.staged = current.diagnostic;
    } else {
      if (!matchBuild(current.staged, sha256, mapSHA256)) return false;
      current.applied = current.staged.sourceMapPayload ? current.staged : null;
      current.staged = null;
    }
    return true;
  });
  handle('resolve-diagnostic', (session, sha256, mapSHA256, line, column) => {
    const current = leases.get(session);
    if (!current || typeof sha256 !== 'string' || typeof mapSHA256 !== 'string' ||
        !coordinate(line) || !coordinate(column) || !matchBuild(current.applied, sha256, mapSHA256)) return null;
    try {
      const map = current.applied;
      map.index ??= new SourceMap(map.sourceMapPayload);
      const {originalSource: file, originalLine, originalColumn, generatedLine} = map.index.findEntry(line - 1, column - 1);
      if (generatedLine !== line - 1 || typeof file !== 'string' || !projectSource.test(file) ||
          !coordinate(originalLine + 1) || !coordinate(originalColumn + 1)) return null;
      return {file, line: originalLine + 1, column: originalColumn + 1};
    } catch {
      return null;
    }
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
    current.controller?.abort();
    current.controller = new AbortController();
    current.failedSource = undefined;
    let snapshot;
    try {
      snapshot = await readCompatible(current);
    } catch (error) {
      if (!isCurrent(current, generation)) return null;
      if (['LOCAL_EXTENSION_BOUNDARY', 'LOCAL_EXTENSION_INCOMPATIBLE'].includes(error.code)) throw error;
      throw failure(current.mode === 'source' ? sourceError(error) : 'LOCAL_EXTENSION_BUILD_REQUIRED');
    }
    if (!isCurrent(current, generation)) return null;
    const {build, diagnostic} = snapshot;
    Object.assign(current, {enabled: true, buildError: undefined, sha256: build.sha256, sourceMapSHA256: build.sourceMapSHA256, diagnostic});
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

module.exports = {installLocalExtensionDevelopment, openDirectory, readDevelopmentBuild, readDevelopmentFile: readFile};
