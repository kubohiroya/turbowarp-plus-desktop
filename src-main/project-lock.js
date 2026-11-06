const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash, randomUUID} = require('node:crypto');

const host = os.hostname();
const isSB3 = file => typeof file === 'string' && path.extname(file).toLowerCase() === '.sb3';
const normalize = file => process.platform === 'darwin' || process.platform === 'win32' ?
  file.normalize('NFC').toLowerCase() : file;

const identify = (file, allowMissing = false) => {
  let canonical;
  try {
    canonical = fs.realpathSync.native(file);
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    // Do not treat a dangling symlink as a new destination.
    try {
      fs.lstatSync(file);
      throw new Error('The save destination is a dangling link.');
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
    canonical = path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file));
    return {path: canonical, key: normalize(canonical)};
  }
  const stat = fs.statSync(canonical, {bigint: true});
  if (!stat.isFile()) throw new Error('The selected path is not a regular file.');
  if (stat.nlink !== 1n) throw new Error('This project has hard links. Copy it to a new SB3 before editing.');
  return {path: canonical, key: normalize(canonical)};
};

const fileFor = (directory, key) =>
  path.join(directory, createHash('sha256').update(key).digest('hex') + '.json');

const read = file => {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('The project lock cannot be read. Close any editor for this file before checking the lock.', {cause: error});
  }
  if (data?.version !== 1 || data.host !== host || !Number.isSafeInteger(data.pid) || data.pid <= 0 ||
      typeof data.token !== 'string' || typeof data.key !== 'string' || typeof data.path !== 'string') {
    throw new Error('The project lock cannot be verified.');
  }
  return data;
};

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // An inaccessible or reused PID is not proof that the lock is stale.
    return true;
  }
};

class ProjectBusy extends Error {
  constructor (owner, message = 'This SB3 is already open in a project process.') {
    super(message);
    this.owner = owner;
  }
}

/**
 * Only the singleton launcher mutates the lock directory. Project processes
 * independently verify ownership before writing. Recovery never relies on age.
 */
class ProjectLocks {
  constructor (directory, busyMessage) {
    this.directory = directory;
    this.busyMessage = busyMessage;
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  }

  check (identity) {
    const file = fileFor(this.directory, identity.key);
    const owner = read(file);
    if (!owner) return;
    if (owner.key !== identity.key) throw new Error('The project lock does not match its path.');
    if (isAlive(owner.pid)) throw new ProjectBusy(owner, this.busyMessage);
    fs.unlinkSync(file);
  }

  acquire (identity, pid) {
    this.check(identity);
    const record = {version: 1, host, ...identity, pid, token: randomUUID()};
    const file = fileFor(this.directory, identity.key);
    const temporary = path.join(this.directory, '.' + record.token);
    try {
      // Linking a complete record publishes it exclusively, without an empty-file crash interval.
      fs.writeFileSync(temporary, JSON.stringify(record), {flag: 'wx', mode: 0o600});
      fs.linkSync(temporary, file);
    } finally {
      fs.rmSync(temporary, {force: true});
    }
    return {...record, file};
  }

  release (lease) {
    const owner = read(lease.file);
    if (owner?.token === lease.token && owner.pid === lease.pid && owner.key === lease.key) {
      fs.unlinkSync(lease.file);
    }
  }
}

const assertOwned = lease => {
  if (!lease) throw new Error('No project lock for this SB3.');
  const owner = read(lease.file);
  if (owner?.pid !== process.pid || owner.token !== lease.token || owner.key !== lease.key ||
      identify(lease.path, true).key !== lease.key) {
    throw new Error('The project process no longer owns this SB3.');
  }
};

module.exports = {ProjectLocks, ProjectBusy, identify, isSB3, assertOwned};
