// SPDX-License-Identifier: MPL-2.0
const {randomUUID} = require('node:crypto');
const {GitServiceError} = require('./github-auth');
const {startDesktopGit} = require('./service');

/** A pool belongs to one trusted renderer. Each account keeps its own proxy and credential lifetime. */
function createGitAccountPool (options, start = startDesktopGit) {
  const slots = new Map();
  const retired = new Map();
  const stopping = new Map();
  let closed = false;
  const valid = id => typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id);
  async function get (id) {
    if (closed || !valid(id) || !slots.has(id)) throw new GitServiceError(401, 'SESSION_REQUIRED');
    return slots.get(id);
  }
  function disconnect (id) {
    if (!valid(id)) return Promise.reject(new GitServiceError(400, 'BAD_REQUEST'));
    if (stopping.has(id)) return stopping.get(id);
    const pending = slots.get(id) || retired.get(id);
    if (!pending) return Promise.resolve();
    slots.delete(id);
    retired.set(id, pending);
    const result = pending.then(async service => {
      try { await service.disconnect(); } finally { await service.close(); }
      retired.delete(id);
    }).finally(() => stopping.delete(id));
    stopping.set(id, result);
    return result;
  }
  return {
    async create () {
      if (closed || slots.size >= 16) throw new GitServiceError(409, 'GIT_IN_USE');
      const id = randomUUID();
      // Pair credentials are memory-only. The single-account saved credential store is never reused.
      const service = Promise.resolve().then(() => start({clientId: options.clientId, githubApi: options.githubApi,
        confirmRepository: options.confirmRepository || (async () => false),
        ...(options.request && {request: options.request}), ...(options.now && {now: options.now}),
        ...(options.wait && {wait: options.wait})}));
      slots.set(id, service);
      try {
        await service;
        if (closed || !slots.has(id)) throw new GitServiceError(401, 'SESSION_REQUIRED');
        return id;
      } catch (error) { slots.delete(id); throw error; }
    },
    async begin (id) { return (await get(id)).begin(false); },
    async finish (id) { return (await get(id)).finish(); },
    async authorizeRepository (id, remote, write = false, review = false) {
      return (await get(id)).createSession(remote, write, review);
    },
    async getSession (id) { return (await get(id)).getSession(); },
    disconnect,
    async close () {
      closed = true;
      const results = await Promise.allSettled([...new Set([...slots.keys(), ...retired.keys()])].map(disconnect));
      if (results.some(result => result.status === 'rejected')) throw new GitServiceError(500, 'STORAGE_FAILURE');
    }
  };
}

function installEditorGitAccounts (ipc, webContents, options, trusted) {
  let pool = createGitAccountPool(options);
  ipc.on('pair-git-enabled', event => { event.returnValue = Boolean(options.clientId) && trusted(event); });
  for (const method of ['create', 'begin', 'finish', 'authorizeRepository', 'getSession', 'disconnect']) {
    ipc.handle('pair-git-' + method, async (event, ...args) => {
      if (!options.clientId || !trusted(event)) throw new Error('GIT_UNAVAILABLE');
      try { return await pool[method](...args); } catch (error) {
        throw new Error(error instanceof GitServiceError ? error.code : 'GIT_UNAVAILABLE');
      }
    });
  }
  const finishClose = async (previous, attempt = 0) => {
    try { await previous.close(); } catch {
      if (attempt < 2) setTimeout(() => { void finishClose(previous, attempt + 1); }, 1000).unref();
      else console.warn('Pair Git connection cleanup remains pending.');
    }
  };
  const close = () => { const previous = pool; pool = createGitAccountPool(options); void finishClose(previous); };
  webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) close();
  });
  webContents.on('render-process-gone', close);
  webContents.once('destroyed', close);
}
module.exports = {createGitAccountPool, installEditorGitAccounts};
