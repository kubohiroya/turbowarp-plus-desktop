const {createHash} = require('node:crypto');
const {lstatSync, readdirSync, readFileSync, realpathSync} = require('node:fs');
const path = require('node:path');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = () => Object.assign(new Error('LOCAL_EXTENSION_SOURCE_UNAVAILABLE'), {code: 'LOCAL_EXTENSION_SOURCE_UNAVAILABLE'});

function inspectPayload (root) {
  root = realpathSync(root);
  const files = [];
  let bytes = 0;
  const walk = relative => {
    for (const entry of readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (name === 'compiler-lock.json') continue;
      if (entry.isSymbolicLink() || name.length > 512 || files.length >= 4096) throw unavailable();
      const absolute = path.join(root, name);
      const stat = lstatSync(absolute);
      if (entry.isDirectory()) walk(name);
      else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024 || bytes + stat.size > 128 * 1024 * 1024) throw unavailable();
        const contents = readFileSync(absolute);
        bytes += contents.length;
        files.push({file: name, size: contents.length, sha256: sha256(contents)});
      }
    }
  };
  walk('');
  return {files: files.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0), bytes};
}

function verifyPayload (root, arch = process.arch) {
  try {
    const manifest = path.join(root, 'compiler-lock.json');
    const stat = lstatSync(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw unavailable();
    const bytes = readFileSync(manifest);
    const lock = JSON.parse(bytes);
    if (lock.formatVersion !== 1 || lock.recipe !== 'turbowarp-standard-worker-v1' ||
        lock.platform !== 'darwin' || lock.arch !== arch ||
        !/^\d+\.\d+\.\d+$/u.test(lock.electronVersion) ||
        !lock.packages || !lock.packages['@kubohiroya/sb3-toolchain'] ||
        !lock.packages.rolldown || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(lock.packages.rolldown.integrity)) throw unavailable();
    const observed = inspectPayload(root);
    if (JSON.stringify(observed.files) !== JSON.stringify(lock.files) || observed.bytes !== lock.bytes) throw unavailable();
    return {...lock, sha256: sha256(bytes)};
  } catch { throw unavailable(); }
}

function verifyBuildReceipt (receipt, files, snapshot, payload) {
  let source = {kind: 'local-snapshot'};
  if (snapshot.source !== undefined) {
    const origin = snapshot.source;
    if (origin?.kind !== 'github' || Object.keys(origin).length !== 3 ||
        typeof origin.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(origin.repository) ||
        typeof origin.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(origin.commit)) throw unavailable();
    source = {kind: 'github', repository: origin.repository, commit: origin.commit};
  }
  const expectedSnapshot = sha256(Buffer.from(JSON.stringify([...snapshot.files.keys()].sort().map(
    name => [name, sha256(snapshot.files.get(name))]))));
  if (!receipt || receipt.profile !== 'turbowarp-typescript-v1' || receipt.execution !== 'sandboxed' ||
      (receipt.formatVersion !== undefined && receipt.formatVersion !== 1) ||
      Object.keys(receipt).some(key => !['formatVersion', 'profile', 'execution', 'compiler', 'snapshotSHA256', 'lockfileSHA256', 'outputs', 'source'].includes(key)) ||
      (receipt.source !== undefined && (receipt.source?.kind !== 'local-snapshot' || Object.keys(receipt.source).length !== 1)) ||
      receipt.compiler?.name !== 'rolldown' || receipt.compiler.version !== payload.packages.rolldown.version ||
      Object.keys(receipt.compiler).some(key => !['name', 'version', 'integrity'].includes(key)) ||
      (receipt.compiler.integrity !== undefined && receipt.compiler.integrity !== payload.packages.rolldown.integrity) ||
      receipt.snapshotSHA256 !== expectedSnapshot ||
      receipt.lockfileSHA256 !== sha256(snapshot.files.get('pnpm-lock.yaml')) ||
      !receipt.outputs || Object.keys(receipt.outputs).length !== files.size || files.size !== 4) throw unavailable();
  for (const [name, bytes] of files) if (receipt.outputs[name] !== sha256(bytes)) throw unavailable();
  // Normalize the previously unversioned standard receipt without retaining any host paths or approvals.
  return {
    formatVersion: 1, profile: receipt.profile, execution: receipt.execution,
    compiler: {name: 'rolldown', version: receipt.compiler.version, integrity: payload.packages.rolldown.integrity},
    snapshotSHA256: receipt.snapshotSHA256, lockfileSHA256: receipt.lockfileSHA256,
    outputs: {...receipt.outputs}, source
  };
}

module.exports = {inspectPayload, verifyPayload, verifyBuildReceipt};
