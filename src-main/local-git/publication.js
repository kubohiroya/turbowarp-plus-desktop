const path = require('node:path');
const {createEncryptedGitJournal} = require('./repository-creation-journal');
const {parseRemote} = require('./git-proxy');
const {GitServiceError} = require('./github-auth');

const featureNames = new Set(['pulls-read', 'pulls-write', 'issues-read', 'issues-write', 'checks-read', 'merge']);
const jobIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const canonicalRemote = url => {
  const {owner, repo} = parseRemote(url);
  return `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}.git`;
};
const badRequest = () => new GitServiceError(400, 'BAD_REQUEST');
const denied = () => new GitServiceError(403, 'FORBIDDEN');

function loadPublicationContract (developmentDirectory, packaged) {
  const override = packaged ? undefined : developmentDirectory;
  if (override && !path.isAbsolute(override)) return null;
  try {
    const {createPullRequestQueue, validatePublicationIntent} = require(override ?
      path.join(override, 'pull-request-queue.js') : '@kubohiroya/turbowarp-plus-editor-git/pull-request-queue');
    const {createGitHubPublicationHost} = require(override ?
      path.join(override, 'github-publication-host.js') : '@kubohiroya/turbowarp-plus-editor-git/github-publication-host');
    if ([createPullRequestQueue, validatePublicationIntent, createGitHubPublicationHost].every(fn => typeof fn === 'function')) {
      return {createPullRequestQueue, validatePublicationIntent, createGitHubPublicationHost};
    }
  } catch {
    return null;
  }
  return null;
}

function publicationCapabilities (configured) {
  if (typeof configured !== 'string' || !configured) return null;
  const values = configured.split(',');
  const enabled = new Set(values);
  if (enabled.size !== values.length || values.some(value => !featureNames.has(value)) ||
      !enabled.has('pulls-read') || !enabled.has('pulls-write')) return null;
  return Object.freeze(values);
}

function createPublicationJournal ({clientId, ...options}) {
  return createEncryptedGitJournal({...options, folder: 'github-publication', identity: clientId,
    validKey: key => key.length <= 512,
    maxRecordBytes: 512 * 1024,
    encode: (record, key) => ({version: 1, clientId, key, record}),
    decode (value, key) {
      if (value?.version !== 1 || value.clientId !== clientId || value.key !== key ||
          typeof value.record?.login !== 'string' || !jobIdPattern.test(value.record?.job?.intent?.id ?? '')) {
        throw new Error('Invalid publication record');
      }
      return value.record;
    }
  });
}

function requiredCapabilities (intent) {
  const needed = ['pulls-read', 'pulls-write'];
  if (intent.goal === 'merge') needed.push('checks-read', 'merge');
  if (intent.issue) {
    needed.push('issues-read');
    if (intent.issue.closeAfterMerge || !('number' in intent.issue)) needed.push('issues-write');
    if (intent.issue.closeAfterMerge && intent.goal === 'pr') needed.push('checks-read');
  }
  return needed;
}

function validateTarget (value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' ||
      !jobIdPattern.test(value.id) || !Number.isSafeInteger(value.repositoryId) || value.repositoryId < 1) throw badRequest();
  return {remote: canonicalRemote(value.remote), repositoryId: value.repositoryId, id: value.id};
}

/** Keeps the approved intent and repository grant in the privileged process. */
function createDesktopPublication ({contract, journal, capabilities, authorize, confirm, request = fetch}) {
  const enabled = new Set(capabilities);
  async function context ({remote, repositoryId}) {
    const authorized = await authorize(remote, repositoryId);
    if (!authorized?.signal || authorized.repositoryId !== repositoryId ||
        typeof authorized.account?.login !== 'string' || !authorized.account.login) throw denied();
    authorized.signal.throwIfAborted();
    const login = authorized.account.login.toLowerCase();
    const queueJournal = {
      exclusive: (key, action) => journal.exclusive(key, action),
      async get (key) {
        const record = await journal.read(key);
        if (!record) return undefined;
        if (record.login !== login) throw denied();
        return record.job;
      },
      put: (key, job) => journal.write(key, {login, job})
    };
    let awaitingPush = false;
    const port = contract.createGitHubPublicationHost({remote, repositoryId, fetch: request, signal: authorized.signal,
      async grant (capability) {
        if (!enabled.has(capability)) return null;
        const current = await authorize(remote, repositoryId);
        authorized.signal.throwIfAborted();
        return current?.account?.login?.toLowerCase() === login && current.repositoryId === repositoryId ? current : null;
      },
      async pushCommit () {
        // A privileged IPC handler has no renderer working-tree access. Check the immutable ref on GitHub.
        awaitingPush = true;
        throw new Error('Publication ref has not been pushed');
      }
    });
    const queue = contract.createPullRequestQueue({journal: queueJournal, repository: {remote, id: repositoryId}, port});
    return {queue, authorized, awaitingPush: () => awaitingPush};
  }

  return {
    capabilities: () => [...capabilities],
    async repository (remote) {
      const authorized = await authorize(canonicalRemote(remote));
      if (!authorized?.signal || !Number.isSafeInteger(authorized.repositoryId) || authorized.repositoryId < 1) throw denied();
      authorized.signal.throwIfAborted();
      return {repositoryId: authorized.repositoryId};
    },
    async enqueue (value) {
      let intent;
      try {
        intent = contract.validatePublicationIntent(value);
      } catch {
        throw badRequest();
      }
      const target = validateTarget(intent);
      intent = {...intent, remote: target.remote};
      if (requiredCapabilities(intent).some(capability => !enabled.has(capability))) throw denied();
      if (!await journal.available()) throw new GitServiceError(503, 'STORAGE_FAILURE');
      const {queue, authorized} = await context(target);
      const key = `confirm:${target.repositoryId}:${target.remote}:${target.id}`;
      return journal.exclusive(key, async () => {
        authorized.signal.throwIfAborted();
        const existing = await queue.get(intent.id);
        if (existing) {
          if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) throw new GitServiceError(409, 'PUBLICATION_CHANGED');
          return existing;
        }
        if (!await confirm(intent, authorized.account.login, authorized.signal)) return null;
        authorized.signal.throwIfAborted();
        return queue.enqueue(intent);
      });
    },
    async get (value) {
      const target = validateTarget(value);
      const {queue} = await context(target);
      return await queue.get(target.id) ?? null;
    },
    async advance (value) {
      const target = validateTarget(value);
      if (value.retryRejectedMerge !== undefined && typeof value.retryRejectedMerge !== 'boolean') throw badRequest();
      const {queue, awaitingPush} = await context(target);
      const approved = await queue.get(target.id);
      if (!approved) throw new GitServiceError(404, 'PUBLICATION_NOT_FOUND');
      if (requiredCapabilities(approved.intent).some(capability => !enabled.has(capability))) throw denied();
      const updated = await queue.advance(target.id, {retryRejectedMerge: value.retryRejectedMerge === true});
      return awaitingPush() ? {...updated, awaitingPush: true} : updated;
    }
  };
}

module.exports = {createDesktopPublication, createPublicationJournal, loadPublicationContract, publicationCapabilities};
