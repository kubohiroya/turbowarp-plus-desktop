const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const maxBytes = 4 * 1024 * 1024;
const isYaml = file => typeof file === 'string' && /\.ya?ml$/i.test(path.extname(file));
const conflict = () => new Error('The YAML file changed on disk. Your draft is preserved. Reopen the file before saving.');
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

function readFile (file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd, {bigint: true});
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(maxBytes)) {
      throw new Error('Select a regular UTF-8 YAML file of 4 MiB or less without hard links.');
    }
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd, {bigint: true});
    if (BigInt(offset) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs ||
        after.ctimeNs !== stat.ctimeNs) throw conflict();
    const data = bytes.subarray(0, offset);
    const revision = createHash('sha256').update(`${stat.dev}:${stat.ino}:`).update(data).digest('hex');
    return {source: decoder.decode(data), revision, mode: Number(stat.mode & 0o777n)};
  } finally {
    fs.closeSync(fd);
  }
}

class ExternalYamlFiles {
  constructor (leasePort) {
    this.leases = leasePort;
    this.entries = new Map();
    this.tail = Promise.resolve();
  }

  run (operation) {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  open (select) {
    return this.run(async () => {
      const file = await select();
      if (!file) return null;
      if (!isYaml(file) || !path.isAbsolute(file)) throw new Error('Select a .yaml or .yml file.');
      const lease = await this.leases.reserve(file);
      const opened = [...this.entries.values()].find(entry => entry.lease.token === lease.token);
      if (opened) return opened.public;
      try {
        this.leases.verify(lease);
        const {source, revision} = readFile(lease.path);
        const result = {id: randomUUID(), name: path.basename(lease.path), source, revision};
        this.entries.set(result.id, {lease, public: result});
        return result;
      } catch (error) {
        await this.leases.release(lease.token);
        throw error;
      }
    });
  }

  save (id, revision, source) {
    if (typeof source !== 'string' || Buffer.byteLength(source) > maxBytes) {
      throw new Error('The YAML source exceeds 4 MiB or is invalid.');
    }
    const bytes = Buffer.from(source);
    if (bytes.toString('utf8') !== source) throw new Error('The YAML source is not valid UTF-8 text.');
    return this.run(async () => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error('The YAML file handle is closed.');
      if (entry.public.revision !== revision) throw conflict();
      const {lease} = entry;
      this.leases.verify(lease);
      const old = readFile(lease.path);
      if (old.revision !== revision) throw conflict();
      const temp = path.join(path.dirname(lease.path), '.tw-yaml-' + randomUUID());
      let handle;
      try {
        handle = await files.open(temp, 'wx', old.mode);
        await handle.chmod(old.mode);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        this.leases.verify(lease);
        if (readFile(lease.path).revision !== revision) throw conflict();
        fs.renameSync(temp, lease.path);
        const saved = readFile(lease.path);
        if (saved.source !== source) throw conflict();
        entry.public = {...entry.public, source: saved.source, revision: saved.revision};
        return {source: saved.source, revision: saved.revision};
      } finally {
        await handle?.close();
        await files.rm(temp, {force: true});
      }
    });
  }

  closeAll () {
    return this.run(async () => {
      for (const [id, entry] of this.entries) {
        await this.leases.release(entry.lease.token);
        this.entries.delete(id);
      }
    });
  }

  close (id) {
    return this.run(async () => {
      const entry = this.entries.get(id);
      if (!entry) return;
      await this.leases.release(entry.lease.token);
      this.entries.delete(id);
    });
  }
}

module.exports = {ExternalYamlFiles, isYaml};
