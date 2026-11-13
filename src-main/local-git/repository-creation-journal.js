const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {createSafeStorageCodec} = require('./credential-store');
const {GitServiceError} = require('./github-auth');

const OPERATION_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const MAX_RECORD_BYTES = 64 * 1024;

function createEncryptedGitJournal ({directory, folder, identity, safeStorage, platform = process.platform,
  validKey, encode, decode, maxRecordBytes = MAX_RECORD_BYTES}) {
  const root = path.join(directory, folder);
  const locks = new Map();
  const codec = () => createSafeStorageCodec(safeStorage, platform);
  const storageFailure = () => new GitServiceError(503, 'STORAGE_FAILURE');

  function filename (key) {
    if (typeof key !== 'string' || !validKey(key)) throw new GitServiceError(400, 'BAD_REQUEST');
    // Operation IDs are case-sensitive, including on case-insensitive filesystems.
    return path.join(root, createHash('sha256').update(identity + '\0' + key).digest('hex') + '.bin');
  }

  async function syncDirectory (directoryPath) {
    if (platform === 'win32') return;
    const directory = await fs.open(directoryPath, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  return {
    async available () {
      return !!await codec();
    },
    exclusive (operationId, run) {
      const file = filename(operationId);
      const pending = (locks.get(file) ?? Promise.resolve()).then(run);
      const settled = pending.catch(() => {});
      locks.set(file, settled);
      void settled.then(() => {
        if (locks.get(file) === settled) locks.delete(file);
      });
      return pending;
    },
    async read (key) {
      const file = filename(key);
      try {
        const stat = await fs.lstat(file).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!stat) return null;
        if (!stat.isFile() || stat.size < 1 || stat.size > maxRecordBytes) throw storageFailure();
        const encryption = await codec();
        if (!encryption) throw storageFailure();
        const record = await encryption.decrypt(await fs.readFile(file));
        if (record.isTemporarilyUnavailable || typeof record.result !== 'string') throw storageFailure();
        return decode(JSON.parse(record.result), key);
      } catch {
        // A missing record permits a new POST. An unreadable record never does.
        throw storageFailure();
      }
    },
    async write (key, value) {
      const file = filename(key);
      const temporary = file + '.' + randomUUID();
      try {
        const encryption = await codec();
        if (!encryption) throw storageFailure();
        const bytes = await encryption.encrypt(JSON.stringify(encode(value, key)));
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxRecordBytes) throw storageFailure();
        const createdRoot = await fs.mkdir(root, {recursive: true, mode: 0o700});
        if (createdRoot) await syncDirectory(path.dirname(root));
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, file);
        await syncDirectory(root);
      } catch {
        throw storageFailure();
      } finally {
        await fs.rm(temporary, {force: true}).catch(() => {});
      }
    }
  };
}

function createRepositoryCreationJournal ({clientId, ...options}) {
  const journal = createEncryptedGitJournal({...options, folder: 'github-repository-creation', identity: clientId,
    validKey: key => OPERATION_ID.test(key),
    encode: attempt => ({version: 1, clientId, attempt}),
    decode (parsed, operationId) {
      if (parsed?.version !== 1 || parsed.clientId !== clientId || parsed.attempt?.intent?.operationId !== operationId ||
          !['unknown', 'refused', 'created'].includes(parsed.attempt.status)) throw new Error('Invalid creation record');
      return parsed.attempt;
    }
  });
  return {...journal, write: attempt => journal.write(attempt?.intent?.operationId, attempt)};
}

module.exports = {createRepositoryCreationJournal, createEncryptedGitJournal};
