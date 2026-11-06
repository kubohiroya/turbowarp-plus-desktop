const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomBytes} = require('node:crypto');

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 256;
const ASSET_TTL = 15 * 60 * 1000;
const tokenPattern = /^[a-f0-9]{64}$/;
const recordPattern = /^([a-f0-9]{64})\.(costume|sound|pending)$/;
const kindIsValid = kind => kind === 'costume' || kind === 'sound';
const validAssetInput = (kind, input) => kindIsValid(kind) && input instanceof Uint8Array &&
  input.byteLength > 0 && input.byteLength <= MAX_ASSET_BYTES;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const missing = () => new Error('The transfer asset is missing, expired, or invalid.');
const unlink = file => files.unlink(file).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});

class ProjectAssets {
  constructor (directory, {now = Date.now, ttl = ASSET_TTL, capacity = MAX_STORE_BYTES} = {}) {
    this.directory = directory;
    this.now = now;
    this.ttl = ttl;
    this.capacity = capacity;
    this.owners = new Map();
    this.tail = Promise.resolve();
  }

  async validateDirectory () {
    const stat = await files.lstat(this.directory);
    if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))) {
      throw new Error('The project transfer directory is not private.');
    }
  }

  queue (operation) {
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  async inspect () {
    await files.mkdir(this.directory, {mode: 0o700}).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await this.validateDirectory();
    const cutoff = this.now() - this.ttl;
    let bytes = 0;
    let count = 0;
    for (const name of await files.readdir(this.directory)) {
      const match = recordPattern.exec(name);
      if (!match) continue;
      const [, token, kind] = match;
      const file = path.join(this.directory, name);
      const stat = await files.lstat(file);
      // Only this broker writes pending files, so these are remnants from an interrupted write.
      if (kind === 'pending' || stat.mtimeMs <= cutoff || !stat.isFile() || stat.nlink !== 1) {
        if (!stat.isDirectory()) await unlink(file);
        this.owners.delete(token);
      } else {
        bytes += stat.size;
        count++;
      }
    }
    return {bytes, count};
  }

  sweep () {
    return this.queue(() => this.inspect());
  }

  stage (owner, kind, input) {
    if (!validAssetInput(kind, input)) throw new Error('Invalid project transfer asset.');
    return this.queue(async () => {
      const data = Buffer.from(input);
      const used = await this.inspect();
      if (used.count >= MAX_RECORDS || used.bytes + data.length > this.capacity) {
        throw new Error('The project asset transfer store is full.');
      }
      const transferId = randomBytes(32).toString('hex');
      const pending = path.join(this.directory, transferId + '.pending');
      try {
        await files.writeFile(pending, data, {mode: 0o600, flag: 'wx'});
        await files.rename(pending, path.join(this.directory, transferId + '.' + kind));
      } catch (error) {
        await unlink(pending);
        throw error;
      }
      this.owners.set(transferId, {owner, kind});
      return {transferId, assets: [{id: 'asset', kind, size: data.length, sha256: sha256(data)}]};
    });
  }

  read (transferId, asset) {
    return this.queue(() => this.readVerified(transferId, asset));
  }

  async readVerified (transferId, asset) {
    if (typeof transferId !== 'string' || !tokenPattern.test(transferId) ||
        asset?.id !== 'asset' || !kindIsValid(asset.kind) ||
        !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES ||
        typeof asset.sha256 !== 'string' || !tokenPattern.test(asset.sha256)) throw missing();
    const file = path.join(this.directory, transferId + '.' + asset.kind);
    let handle;
    try {
      await this.validateDirectory();
      const before = await files.lstat(file);
      if (!before.isFile() || before.nlink !== 1) throw missing();
      handle = await files.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== asset.size ||
          stat.mtimeMs <= this.now() - this.ttl) throw missing();
      // Read no more than the expected bytes plus a sentinel, even if the file changes.
      const data = Buffer.alloc(asset.size + 1);
      let offset = 0;
      while (offset < data.length) {
        const {bytesRead} = await handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const result = data.subarray(0, asset.size);
      if (offset !== asset.size || sha256(result) !== asset.sha256 || stat.mtimeMs <= this.now() - this.ttl) throw missing();
      return result;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') throw missing();
      throw error;
    } finally {
      await handle?.close();
    }
  }

  discard (owner, transferId) {
    return this.queue(async () => {
      const record = this.owners.get(transferId);
      if (!record || record.owner !== owner) return false;
      await this.validateDirectory();
      await unlink(path.join(this.directory, transferId + '.' + record.kind));
      this.owners.delete(transferId);
      return true;
    });
  }
}

module.exports = {ProjectAssets, validAssetInput};
