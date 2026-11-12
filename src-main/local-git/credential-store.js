const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const LINUX_KEYRINGS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const MAX_RECORD_BYTES = 64 * 1024;

async function createSafeStorageCodec (safeStorage, platform = process.platform) {
  if (platform === 'linux') {
    // Use the backend that was explicitly checked, rather than an asynchronous fallback provider.
    if (!safeStorage.isEncryptionAvailable() || !LINUX_KEYRINGS.has(safeStorage.getSelectedStorageBackend())) return null;
    return {
      encrypt: value => safeStorage.encryptString(value),
      decrypt: bytes => ({result: safeStorage.decryptString(bytes), shouldReEncrypt: false})
    };
  }
  if ((platform === 'darwin' || platform === 'win32') && await safeStorage.isAsyncEncryptionAvailable()) {
    return {encrypt: value => safeStorage.encryptStringAsync(value), decrypt: bytes => safeStorage.decryptStringAsync(bytes)};
  }
  return null;
}

function createCredentialStore ({directory, clientId, safeStorage, platform = process.platform}) {
  const root = path.join(directory, 'local-git');
  const file = path.join(root, createHash('sha256').update(clientId).digest('hex') + '.bin');
  let queue = Promise.resolve();
  const serialize = callback => {
    const result = queue.then(callback);
    queue = result.catch(() => {});
    return result;
  };

  const codec = () => createSafeStorageCodec(safeStorage, platform);

  async function replace (bytes, signal) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_RECORD_BYTES) return false;
    signal.throwIfAborted();
    await fs.mkdir(root, {recursive: true, mode: 0o700});
    const temporary = file + '.' + randomUUID();
    try {
      await fs.writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
      signal.throwIfAborted();
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, {force: true});
    }
    return true;
  }

  return {
    read: signal => serialize(async () => {
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
        const encryption = await codec();
        if (!encryption) return null;
        const record = await encryption.decrypt(await fs.readFile(file));
        signal.throwIfAborted();
        if (record.isTemporarilyUnavailable || typeof record.result !== 'string') return null;
        const value = JSON.parse(record.result);
        if (value?.version !== 1 || value.clientId !== clientId) return null;
        if (record.shouldReEncrypt) {
          await replace(await encryption.encrypt(record.result), signal).catch(() => {});
        }
        return value.credentials;
      } catch {
        return null;
      }
    }),
    write: (credentials, signal) => serialize(async () => {
      try {
        signal.throwIfAborted();
        const encryption = await codec();
        if (!encryption) return false;
        const bytes = await encryption.encrypt(JSON.stringify({version: 1, clientId, credentials}));
        return await replace(bytes, signal);
      } catch {
        return false;
      }
    }),
    clear: () => serialize(() => fs.rm(file, {force: true}))
  };
}

module.exports = {createCredentialStore, createSafeStorageCodec};
