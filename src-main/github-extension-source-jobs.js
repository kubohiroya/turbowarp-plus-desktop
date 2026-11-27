const {randomUUID} = require('node:crypto');
const {readSourceBuild} = require('./local-extension-development');
const {validateDiagnostics} = require('./standard-extension-source-build');

const leases = new Set();
const repositoryName = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const sourceName = /^src\/(?:[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\/)*[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\.(?:ts|js|json)$/u;
const rootFiles = new Set(['package.json', 'extension-build.json', 'pnpm-lock.yaml']);
const failure = code => Object.assign(new Error(code), {code});
const unavailable = () => failure('GITHUB_EXTENSION_SOURCE_UNAVAILABLE');
const cancelled = () => failure('GITHUB_EXTENSION_SOURCE_CANCELLED');
const measureNames = ['inputBytes', 'outputBytes', 'payloadBytes', 'additionalRuntimeDownloadBytes',
  'cacheBytes', 'temporaryDiskBytes', 'sampledPeakResidentBytes', 'elapsedMs'];

function snapshotIdentity (snapshot, repository, expectedCommit) {
  if (snapshot?.source?.kind !== 'github' || snapshot.source.repository !== repository ||
      !/^[a-f0-9]{40}$/u.test(snapshot.source.commit) ||
      (expectedCommit !== undefined && snapshot.source.commit !== expectedCommit) ||
      !(snapshot.files instanceof Map) || snapshot.files.size > 128) throw unavailable();
  const files = new Map();
  let inputBytes = 0;
  for (const [name, bytes] of snapshot.files) {
    if (typeof name !== 'string' || name.length > 256 || (!rootFiles.has(name) && !sourceName.test(name)) ||
        !(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024) throw unavailable();
    inputBytes += bytes.byteLength;
    if (inputBytes > 4 * 1024 * 1024) throw unavailable();
    files.set(name, Buffer.from(bytes));
  }
  const parse = name => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(files.get(name)));
  const profile = parse('extension-build.json');
  if (typeof profile.settings !== 'string' || !sourceName.test(profile.settings)) throw unavailable();
  const {id, unsandboxed} = parse(profile.settings);
  if (typeof id !== 'string' || !/^[a-z][a-z0-9]{0,63}$/iu.test(id) || unsandboxed !== false) throw unavailable();
  const downloadBytes = snapshot.measurements?.downloadBytes;
  if (!Number.isSafeInteger(downloadBytes) || downloadBytes < 0 || downloadBytes > 16 * 1024 * 1024) throw unavailable();
  return {id, files, source: {kind: 'github', repository, commit: snapshot.source.commit},
    measurements: {downloadBytes, inputBytes, cacheBytes: 0, temporaryDiskBytes: 0}};
}

// This broker accepts repository identities and opaque jobs, never renderer paths, commands, headers or tokens.
function installGitHubExtensionSourceJobs (ipc, webContents, {builder, enabled = false, ttlMs = 120_000}) {
  let current;
  const available = enabled && typeof builder?.resolveGitHubSnapshot === 'function' && typeof builder?.buildResult === 'function';
  const trusted = event => event.sender === webContents && event.senderFrame === webContents.mainFrame &&
    event.senderFrame?.url?.split(/[?#]/u, 1)[0] === 'tw-editor://./plus-gui/gui.html';
  const clear = () => {
    if (!current) return;
    current.controller.abort();
    clearTimeout(current.timer);
    leases.delete(current);
    current.snapshot = null;
    current.output = null;
    current = null;
  };
  const view = job => ({job: job.token, status: job.status, ...(job.source && {source: {...job.source}}),
    ...(job.id && {id: job.id}), ...(job.measurements && {measurements: {...job.measurements}}),
    ...(job.code && {code: job.code}), ...(job.diagnostics?.length && {diagnostics: job.diagnostics})});
  const get = token => {
    if (typeof token !== 'string' || token !== current?.token) throw unavailable();
    return current;
  };
  const failed = (job, code, diagnostics) => {
    job.status = 'failed';
    job.code = code;
    job.diagnostics = diagnostics;
    job.snapshot = null;
    job.output = null;
    leases.delete(job);
    return view(job);
  };
  const handle = (name, operation) => ipc.handle('github-extension-source-' + name, (event, ...args) => {
    if (!available || !trusted(event)) throw unavailable();
    return operation(...args);
  });
  ipc.on('github-extension-source-enabled', event => { event.returnValue = Boolean(available && trusted(event)); });
  handle('prepare', async request => {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(key => !['repository', 'ref', 'expectedCommit'].includes(key)) ||
        typeof request.repository !== 'string' || !repositoryName.test(request.repository) ||
        (request.ref !== undefined && (typeof request.ref !== 'string' || !request.ref || request.ref.length > 128 || /[\u0000-\u0020\u007f]/u.test(request.ref))) ||
        (request.expectedCommit !== undefined && (typeof request.expectedCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(request.expectedCommit)))) throw unavailable();
    if (current?.status === 'failed') clear();
    if (current || leases.size >= 2) throw failure('GITHUB_EXTENSION_SOURCE_BUSY');
    const job = {token: randomUUID(), controller: new AbortController(), status: 'fetching'};
    current = job;
    leases.add(job);
    job.timer = setTimeout(() => { if (current === job) clear(); }, ttlMs);
    job.timer.unref();
    job.pending = (async () => {
      try {
        const {signal} = job.controller;
        const snapshot = await builder.resolveGitHubSnapshot(request.repository, {
          ref: request.ref ?? 'HEAD', expectedCommit: request.expectedCommit, signal
        });
        if (current !== job || signal.aborted) throw cancelled();
        const validated = snapshotIdentity(snapshot, request.repository, request.expectedCommit);
        job.snapshot = {files: validated.files, source: validated.source};
        Object.assign(job, {id: validated.id, source: validated.source, measurements: validated.measurements, status: 'prepared'});
        return view(job);
      } catch {
        if (current !== job || job.controller.signal.aborted) throw cancelled();
        return failed(job, 'GITHUB_EXTENSION_SOURCE_FETCH_FAILED');
      }
    })();
    return job.pending;
  });
  handle('build', async token => {
    const job = get(token);
    if (job.status !== 'prepared') throw unavailable();
    job.status = 'building';
    job.pending = (async () => {
      try {
        const result = await builder.buildResult(job.snapshot, job.controller.signal);
        if (current !== job || job.controller.signal.aborted) throw cancelled();
        const {build} = await readSourceBuild(result.files);
        if (current !== job || job.controller.signal.aborted) throw cancelled();
        const origin = result.receipt?.source;
        if (result.files.size !== 4 || !build.sourceMapSHA256 || build.id !== job.id || origin?.kind !== 'github' ||
            origin.repository !== job.source.repository || origin.commit !== job.source.commit || Object.keys(origin).length !== 3) throw unavailable();
        job.output = {files: [...result.files].map(([name, bytes]) => [name, new Uint8Array(bytes)]),
          receipt: result.receipt, sha256: build.sha256, apiSHA256: build.apiSHA256,
          sourceMapSHA256: build.sourceMapSHA256};
        const measured = Object.fromEntries(measureNames.filter(name => Number.isSafeInteger(result.measurements?.[name]) &&
          result.measurements[name] >= 0).map(name => [name, result.measurements[name]]));
        job.measurements = {...measured, ...job.measurements};
        job.snapshot = null;
        job.status = 'ready';
        return view(job);
      } catch (error) {
        if (current !== job || job.controller.signal.aborted) throw cancelled();
        const code = ['LOCAL_EXTENSION_SOURCE_LIMIT', 'LOCAL_EXTENSION_SOURCE_TIMEOUT',
          'LOCAL_EXTENSION_SOURCE_BUSY', 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'].includes(error.code) ? error.code : 'GITHUB_EXTENSION_SOURCE_BUILD_FAILED';
        return failed(job, code, validateDiagnostics(error.diagnostics));
      }
    })();
    return job.pending;
  });
  handle('status', token => view(get(token)));
  handle('result', token => {
    const job = get(token);
    if (job.status !== 'ready') throw unavailable();
    return {...view(job), ...job.output};
  });
  handle('cancel', async token => {
    if (token !== undefined) get(token);
    const pending = current?.pending;
    clear();
    await pending?.catch(() => {});
    return true;
  });
  webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) clear();
  });
  webContents.on('render-process-gone', clear);
  webContents.once('destroyed', clear);
}

module.exports = {installGitHubExtensionSourceJobs};
