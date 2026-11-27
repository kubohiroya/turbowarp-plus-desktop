// SPDX-License-Identifier: MPL-2.0
const {randomUUID} = require('node:crypto');
const {GitServiceError} = require('./github-auth');
const {startDesktopGit} = require('./service');

/** A pool belongs to one trusted renderer. Each account keeps its own proxy and credential lifetime. */
function createGitAccountPool (options, start = startDesktopGit) {
  const slots = new Map();
  let closed = false;
  const valid = id => typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id);
  async function get (id) {
    if (closed || !valid(id) || !slots.has(id)) throw new GitServiceError(401, 'SESSION_REQUIRED');
    return slots.get(id);
  }
  return {
    async create () {
      if (closed || slots.size >= 16) throw new GitServiceError(409, 'GIT_IN_USE');
      const id = randomUUID();
      // Pair credentials are memory-only. The single-account saved credential store is never reused.
      const service = Promise.resolve().then(() => start({clientId: options.clientId, githubApi: options.githubApi,
        ...(options.request && {request: options.request}), ...(options.now && {now: options.now}),
        ...(options.wait && {wait: options.wait})}));
      slots.set(id, service);
      try { await service; return id; } catch (error) { slots.delete(id); throw error; }
    },
    async begin (id) { return (await get(id)).begin(false); },
    async finish (id) { return (await get(id)).finish(); },
    async authorizeRepository (id, remote, write = false, review = false) {
      return (await get(id)).createSession(remote, write, review);
    },
    async getSession (id) { return (await get(id)).getSession(); },
    async disconnect (id) {
      if (!valid(id)) throw new GitServiceError(400, 'BAD_REQUEST');
      const pending = slots.get(id);
      if (!pending) return;
      slots.delete(id);
      const service = await pending;
      try { await service.disconnect(); } finally { await service.close(); }
    },
    async close () {
      closed = true;
      const pending = [...slots.values()];
      slots.clear();
      await Promise.allSettled(pending.map(async promise => (await promise).close()));
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
  const close = () => { const previous = pool; pool = createGitAccountPool(options); void previous.close(); };
  webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) close();
  });
  webContents.on('render-process-gone', close);
  webContents.once('destroyed', close);
}
module.exports = {createGitAccountPool, installEditorGitAccounts};
