const {randomBytes} = require('node:crypto');
const {createGitHubAuth, GitServiceError} = require('./github-auth');
const {parseRemote, startGitProxy} = require('./git-proxy');

const SESSION_MS = 5 * 60_000;
const MAX_PUSH_IDS = 256;
const sameRemote = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

async function startDesktopGit ({clientId, request = fetch, now = Date.now, wait, store} = {}) {
  const github = createGitHubAuth(clientId, {request, now, wait, store});
  let lifetime = new AbortController();
  let revision = 0;
  let session = null;
  let closed = false;

  function expired (selected) {
    if (selected.public.expiresAt > now()) return false;
    selected.pushIds.clear();
    return true;
  }

  function reset () {
    lifetime.abort();
    lifetime = new AbortController();
    session?.controller.abort();
    session = null;
    github.disconnect();
  }

  async function repository (remote, write, accessToken, signal) {
    const metadata = await github.repository(remote.owner, remote.repo, accessToken, signal);
    const allowed = write ? metadata.permissions?.push : metadata.permissions?.pull;
    if (allowed !== true || !Number.isSafeInteger(metadata.id) || metadata.id <= 0 ||
        typeof metadata.full_name !== 'string') throw new GitServiceError(403, 'FORBIDDEN');
    const name = parseRemote('https://github.com/' + metadata.full_name);
    if (!sameRemote(name, remote)) throw new GitServiceError(403, 'FORBIDDEN');
    return {...name, id: metadata.id};
  }

  const proxy = await startGitProxy({
    request,
    async authorize (bearer, route, signal, pushId) {
      const selected = session;
      if (!selected || selected.public.bearer !== bearer) throw new GitServiceError(401, 'SESSION_REQUIRED');
      if (expired(selected)) throw new GitServiceError(401, 'SESSION_EXPIRED');
      if (!sameRemote(route, selected.remote) || (route.write && !selected.write)) {
        throw new GitServiceError(403, 'FORBIDDEN');
      }
      const requestSignal = AbortSignal.any([signal, selected.controller.signal]);
      const {accessToken} = await github.getCredentials();
      requestSignal.throwIfAborted();
      const verified = await repository(selected.repository, route.write, accessToken, requestSignal);
      requestSignal.throwIfAborted();
      if (expired(selected)) throw new GitServiceError(401, 'SESSION_EXPIRED');
      if (verified.id !== selected.repository.id) throw new GitServiceError(403, 'FORBIDDEN');
      if (pushId) {
        if (selected.pushIds.has(pushId)) throw new GitServiceError(409, 'PUSH_DUPLICATE');
        if (selected.pushIds.size >= MAX_PUSH_IDS) throw new GitServiceError(429, 'RATE_LIMITED');
        selected.pushIds.add(pushId);
      }
      return {accessToken, repository: verified, signal: selected.controller.signal};
    },
    async resolveRedirect (current, candidate, accessToken, signal) {
      const selected = session;
      const target = await repository(candidate, candidate.write, accessToken, signal).catch(error => {
        if (error instanceof GitServiceError && error.status === 403) return null;
        throw error;
      });
      signal.throwIfAborted();
      if (!target || selected !== session || selected?.repository.id !== current.id || target.id !== current.id) return null;
      selected.repository = target;
      return target;
    }
  });
  const connection = Object.freeze({mode: 'desktop', proxyOrigin: proxy.proxyOrigin});

  return {
    connection,
    async begin (remember = false) {
      if (closed) throw new GitServiceError(401, 'SESSION_REQUIRED');
      if (typeof remember !== 'boolean') throw new GitServiceError(400, 'BAD_REQUEST');
      reset();
      return github.begin(remember);
    },
    finish: github.finish,
    restore: github.restore,
    getState: github.getState,
    async createSession (remoteUrl, write = false) {
      if (closed) throw new GitServiceError(401, 'SESSION_REQUIRED');
      if (typeof write !== 'boolean') throw new GitServiceError(400, 'BAD_REQUEST');
      const remote = parseRemote(remoteUrl);
      const {signal} = lifetime;
      const ticket = ++revision;
      const {account, accessToken, expiresAt} = await github.getCredentials();
      const approved = await repository(remote, write, accessToken, signal);
      if (signal.aborted || ticket !== revision || expiresAt <= now()) throw new GitServiceError(401, 'SESSION_EXPIRED');
      const publicSession = Object.freeze({
        connection, account: Object.freeze({...account}),
        expiresAt: Math.min(expiresAt, now() + SESSION_MS), bearer: randomBytes(32).toString('base64url')
      });
      session?.controller.abort();
      session = {remote, write, repository: approved, controller: new AbortController(), public: publicSession, pushIds: new Set()};
      return publicSession;
    },
    getSession () {
      return session && !expired(session) ? session.public : null;
    },
    async disconnect () {
      reset();
      await store?.clear();
    },
    async close () {
      if (closed) return;
      closed = true;
      reset();
      await proxy.close();
    }
  };
}

module.exports = {startDesktopGit};
