const {execFile, spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const {existsSync, realpathSync} = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const {verifyPayload, verifyBuildReceipt} = require('./standard-extension-payload');

const MiB = 1024 * 1024;
const maximumParallelBuilds = 2;
let activeBuilds = 0;
const sourceName = /^src\/(?:[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\/)*[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\.(?:ts|js|json)$/u;
const failure = code => Object.assign(new Error(code), {code});
const limit = () => failure('LOCAL_EXTENSION_SOURCE_LIMIT');
const cancelled = () => failure('LOCAL_EXTENSION_SOURCE_CANCELLED');
const boundary = () => failure('LOCAL_EXTENSION_BOUNDARY');

async function readSourceSnapshot ({root, identity}, signal, readFile) {
  const files = new Map();
  let size = 0;
  let entries = 0;
  const checkDirectory = async name => {
    signal.throwIfAborted();
    const stat = await fs.lstat(name);
    if (!stat.isDirectory() || await fs.realpath(name) !== name) throw boundary();
    return stat;
  };
  const same = (a, b) => a.ino === b.ino && a.dev === b.dev;
  const add = async name => {
    signal.throwIfAborted();
    if (name.length > 256 || files.size === 128) throw limit();
    const bytes = await readFile(path.join(root, name), Math.min(MiB, 4 * MiB - size), 'LOCAL_EXTENSION_SOURCE_LIMIT');
    size += bytes.length;
    files.set(name, bytes);
  };
  const walk = async (relative, depth) => {
    if (depth > 10 || relative.length > 256) throw limit();
    const name = path.join(root, relative);
    const before = await checkDirectory(name);
    for await (const entry of await fs.opendir(name)) {
      signal.throwIfAborted();
      if (++entries > 256) throw limit();
      if (entry.isSymbolicLink()) throw boundary();
      const child = relative + '/' + entry.name;
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile() && sourceName.test(child)) await add(child);
    }
    if (!same(before, await checkDirectory(name))) throw boundary();
  };
  if (!same(identity, await checkDirectory(root))) throw boundary();
  for (const name of ['extension-build.json', 'package.json', 'pnpm-lock.yaml']) await add(name);
  await walk('src', 0);
  if (!same(identity, await checkDirectory(root))) throw boundary();
  const hash = createHash('sha256');
  for (const name of Array.from(files.keys()).sort()) {
    hash.update(name).update('\0').update(createHash('sha256').update(files.get(name)).digest());
  }
  const parse = name => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(files.get(name)));
  const profile = parse('extension-build.json');
  if (!sourceName.test(profile.settings) || !files.has(profile.settings)) throw failure('LOCAL_EXTENSION_SOURCE_FAILED');
  const {id, unsandboxed} = parse(profile.settings);
  if (unsandboxed !== false || typeof id !== 'string' || !/^[a-z][a-z0-9]{0,63}$/iu.test(id)) {
    throw failure('LOCAL_EXTENSION_SOURCE_FAILED');
  }
  return {files, id, digest: hash.digest('hex')};
}

// The paths are trusted application files. Project paths and environment variables are never passed to the worker.
const policy = `(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec (require-not (literal (param "RUNTIME"))))
(deny signal)
(deny file-write*)
(deny mach-lookup)
(deny ipc-posix*)
(deny file-read-data
  (require-not (require-any
    (literal "/")
    (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
    (subpath "/System/Library") (subpath "/usr/lib") (subpath "/private/var/db/dyld")
    (subpath (param "FRAMEWORKS")) (literal (param "INFO"))
    (literal (param "RUNTIME")) (subpath (param "COMPILER")))))`;

function runSourceWorker ({executable, appRoot, worker}, request, signal,
  {timeoutMs = 15_000, outputLimit = 9 * MiB, residentLimit = 256 * MiB, sampleMs = 100} = {}) {
  if (signal.aborted) return Promise.reject(cancelled());
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(outputLimit) || outputLimit < 1 || outputLimit > 9 * MiB ||
      !Number.isSafeInteger(residentLimit) || residentLimit < MiB || residentLimit > 512 * MiB ||
      !Number.isSafeInteger(sampleMs) || sampleMs < 10 || sampleMs > 1000 || request.length > 6 * MiB) return Promise.reject(limit());
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn('/usr/bin/sandbox-exec', [
      '-D', `FRAMEWORKS=${appRoot}/Frameworks`, '-D', `INFO=${appRoot}/Info.plist`, '-D', `RUNTIME=${executable}`,
      '-D', `COMPILER=${path.dirname(worker)}`, '-p', policy,
      executable, '--max-old-space-size=128', worker
    ], {cwd: path.dirname(worker), env: {ELECTRON_RUN_AS_NODE: '1', RAYON_NUM_THREADS: '2', UV_THREADPOOL_SIZE: '2'},
      stdio: ['pipe', 'pipe', 'ignore']});
    let failureCode;
    let bytes = 0;
    let closed = false;
    let sampling = false;
    let failedSamples = 0;
    let sampledPeakResidentBytes = 0;
    const chunks = [];
    const kill = code => {
      failureCode ??= code;
      child.kill('SIGKILL');
    };
    const abort = () => kill('LOCAL_EXTENSION_SOURCE_CANCELLED');
    signal.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => kill('LOCAL_EXTENSION_SOURCE_TIMEOUT'), timeoutMs);
    const sample = () => {
      if (closed || sampling || failureCode || !child.pid) return;
      sampling = true;
      execFile('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], {env: {LC_ALL: 'C'}, timeout: 1000, maxBuffer: 1024}, (error, stdout) => {
        sampling = false;
        if (closed || child.exitCode !== null || failureCode) return;
        const resident = Number(stdout.trim()) * 1024;
        if (error || !Number.isSafeInteger(resident) || resident <= 0) {
          // An exiting process can disappear from ps before Node receives its exit notification.
          if (++failedSamples >= 3) kill('LOCAL_EXTENSION_SOURCE_UNAVAILABLE');
          return;
        }
        failedSamples = 0;
        sampledPeakResidentBytes = Math.max(sampledPeakResidentBytes, resident);
        if (resident > residentLimit) kill('LOCAL_EXTENSION_SOURCE_LIMIT');
      });
    };
    const memoryTimer = setInterval(sample, sampleMs);
    sample();
    child.on('error', () => kill('LOCAL_EXTENSION_SOURCE_UNAVAILABLE'));
    if (signal.aborted) abort();
    child.stdout.on('data', chunk => {
      if (failureCode) return;
      bytes += chunk.length;
      if (bytes > outputLimit) kill('LOCAL_EXTENSION_SOURCE_LIMIT');
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      closed = true;
      clearTimeout(timer);
      clearInterval(memoryTimer);
      signal.removeEventListener('abort', abort);
      if (failureCode || code !== 0) {
        const error = failure(failureCode ?? (code === 2 ? 'LOCAL_EXTENSION_SOURCE_FAILED' : 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'));
        if (!failureCode && code === 2) {
          try {
            const response = JSON.parse(Buffer.concat(chunks, bytes));
            error.diagnostics = validateDiagnostics(response.diagnostics);
          } catch { /* A malformed worker error remains a generic failure. */ }
        }
        reject(error);
        return;
      }
      try {
        const output = JSON.parse(Buffer.concat(chunks, bytes));
        if (output.formatVersion !== 1 || !Array.isArray(output.files) || output.files.length !== 4) throw new Error();
        const files = new Map(output.files.map(([name, data]) => {
          if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) ||
              typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) throw new Error();
          const bytes = Buffer.from(data, 'base64');
          if (bytes.toString('base64') !== data) throw new Error();
          return [name, bytes];
        }));
        if (files.size !== 4) throw new Error();
        resolve({files, receipt: output.receipt, environment: output.environment,
          measurements: {outputBytes: [...files.values()].reduce((sum, data) => sum + data.length, 0),
            sampledPeakResidentBytes, elapsedMs: Math.ceil(performance.now() - started), cacheBytes: 0, temporaryDiskBytes: 0}});
      } catch {
        reject(failure('LOCAL_EXTENSION_SOURCE_FAILED'));
      }
    });
    child.stdin.end(request);
  });
}

function validateDiagnostics (value) {
  if (!Array.isArray(value) || value.length > 16) return [];
  return value.filter(item => item && typeof item.file === 'string' &&
    sourceName.test(item.file) &&
    /^[A-Z_]{1,64}$/u.test(item.code) && Number.isSafeInteger(item.line) && item.line > 0 &&
    Number.isSafeInteger(item.column) && item.column > 0).map(({code, file, line, column}) => ({code, file, line, column}));
}

function createStandardExtensionBuilder ({isPackaged, executable = process.execPath,
  resources = process.resourcesPath, platform = process.platform, mas = process.mas}) {
  if (platform !== 'darwin' || mas || !existsSync('/usr/bin/sandbox-exec')) return null;
  const payload = isPackaged ? path.join(resources, 'standard-extension-compiler', process.arch) :
    path.resolve(__dirname, '../dist-standard-extension-compiler', process.arch);
  let worker;
  let appRoot;
  let payloadLock;
  try {
    worker = realpathSync(path.join(payload, 'worker.mjs'));
    executable = realpathSync(executable);
    appRoot = path.resolve(executable, '../..');
    if (path.basename(appRoot) !== 'Contents') return null;
    payloadLock = verifyPayload(payload);
  } catch {
    return null;
  }
  return {
    read: readSourceSnapshot,
    async build (snapshot, signal) {
      return (await this.buildResult(snapshot, signal)).files;
    },
    async buildResult (snapshot, signal) {
      if (activeBuilds >= maximumParallelBuilds) throw failure('LOCAL_EXTENSION_SOURCE_BUSY');
      activeBuilds++;
      try {
        const currentLock = verifyPayload(payload);
        if (currentLock.sha256 !== payloadLock.sha256) throw failure('LOCAL_EXTENSION_SOURCE_UNAVAILABLE');
        const request = JSON.stringify(Array.from(snapshot.files, ([name, data]) => [name, data.toString('base64')]));
        const result = await runSourceWorker({executable, appRoot, worker}, request, signal);
        if (result.environment?.electron !== payloadLock.electronVersion || result.environment?.platform !== 'darwin' || result.environment?.arch !== process.arch) throw failure('LOCAL_EXTENSION_SOURCE_UNAVAILABLE');
        const receipt = verifyBuildReceipt(result.receipt, result.files, snapshot, payloadLock);
        return {...result, receipt, measurements: {...result.measurements,
          inputBytes: [...snapshot.files.values()].reduce((sum, data) => sum + data.length, 0),
          payloadBytes: payloadLock.bytes, additionalRuntimeDownloadBytes: 0}};
      } finally {
        activeBuilds--;
      }
    }
  };
}

module.exports = {createStandardExtensionBuilder, readSourceSnapshot, runSourceWorker, validateDiagnostics};
