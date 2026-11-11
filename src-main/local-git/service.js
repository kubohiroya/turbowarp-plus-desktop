const {randomBytes} = require('node:crypto');
const {createGitHubAuth, GitServiceError} = require('./github-auth');
const {parseRemote, startGitProxy} = require('./git-proxy');

const SESSION_MS = 5 * 60_000;
const MAX_PUSH_IDS = 256;
const PERSONAL_TOKEN = 'fine-grained-pat';
const GIT_CREDENTIAL_HELPER = 'git-credential-helper';
const isGitHubLogin = login => typeof login === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(login);
const isPersonalToken = token => typeof token === 'string' && /^github_pat_[A-Za-z0-9_]{1,1024}$/u.test(token);
const sameRemote = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

async function startDesktopGit ({
  clientId, request = fetch, now = Date.now, wait, store, promptPersonalToken, gitCredentialHelper, confirmGitCredential
} = {}) {
  const github = createGitHubAuth(clientId, {request, now, wait, store});
  let lifetime = new AbortController();
  let revision = 0;
  let session = null;
  let closed = false;
  let localToken = null;
  let tokenReauthRequired = false;
  let authOperation = null;

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
    localToken = null;
    tokenReauthRequired = false;
    authOperation = null;
  }

  async function repository (remote, write, accessToken, signal) {
    const metadata = await github.repository(remote.owner, remote.repo, accessToken, signal).catch(error => {
      if (!signal.aborted && error.code === 'REAUTH_REQUIRED' && localToken?.accessToken === accessToken) {
        const {remembered} = localToken;
        localToken = null;
        tokenReauthRequired = true;
        session?.controller.abort(error);
        if (remembered) void store?.clear().catch(() => {});
      }
      throw error;
    });
    const allowed = write ? metadata.permissions?.push : metadata.permissions?.pull;
    if (allowed !== true || !Number.isSafeInteger(metadata.id) || metadata.id <= 0 ||
        typeof metadata.full_name !== 'string') throw new GitServiceError(403, 'FORBIDDEN');
    const name = parseRemote('https://github.com/' + metadata.full_name);
    if (!sameRemote(name, remote)) throw new GitServiceError(403, 'FORBIDDEN');
    return {...name, id: metadata.id};
  }

  async function verifyToken (remote, accessToken, signal, expectedId) {
    const approved = await repository(remote, false, accessToken, signal);
    if (expectedId !== undefined && approved.id !== expectedId) throw new GitServiceError(403, 'FORBIDDEN');
    const user = await github.user(accessToken, signal);
    signal.throwIfAborted();
    if (!isGitHubLogin(user.login) || user.login === accessToken) {
      throw new GitServiceError(401, 'REAUTH_REQUIRED');
    }
    return {accessToken, repository: approved, account: {login: user.login}};
  }

  async function runAuthOperation (operation) {
    if (closed) throw new GitServiceError(401, 'SESSION_REQUIRED');
    if (authOperation || github.getState().status === 'connecting') throw new GitServiceError(409, 'AUTH_IN_PROGRESS');
    const {signal} = lifetime;
    authOperation = signal;
    try {
      return await operation(signal);
    } finally {
      if (authOperation === signal) authOperation = null;
    }
  }

  async function connectToken (checked, remember, signal) {
    const remembered = !!(remember && await store?.write({kind: PERSONAL_TOKEN, ...checked}, signal));
    signal.throwIfAborted();
    if (store && !remembered) {
      await store.clear().catch(() => { throw new GitServiceError(500, 'STORAGE_FAILURE'); });
    }
    signal.throwIfAborted();
    reset();
    localToken = {...checked, remembered};
    return getState();
  }

  function getState () {
    if (tokenReauthRequired) return {status: 'reauth-required'};
    if (localToken) {
      return {status: 'connected', account: {...localToken.account}, remembered: localToken.remembered};
    }
    const state = github.getState();
    return authOperation && state.status === 'disconnected' ? {status: 'connecting'} : state;
  }

  const getCredentials = () => localToken ?? github.getCredentials();

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
      const {accessToken} = await getCredentials();
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
      if (!clientId) throw new GitServiceError(403, 'GIT_UNAVAILABLE');
      if (authOperation) throw new GitServiceError(409, 'AUTH_IN_PROGRESS');
      reset();
      return github.begin(remember);
    },
    finish: github.finish,
    async connectPersonalAccessToken (remoteUrl, remember = false) {
      if (!promptPersonalToken) throw new GitServiceError(403, 'GIT_UNAVAILABLE');
      if (typeof remember !== 'boolean') throw new GitServiceError(400, 'BAD_REQUEST');
      const remote = parseRemote(remoteUrl);
      return runAuthOperation(async signal => {
        const accessToken = await promptPersonalToken(remote, signal);
        signal.throwIfAborted();
        if (accessToken === null) return null;
        if (!isPersonalToken(accessToken)) throw new GitServiceError(400, 'BAD_REQUEST');
        const checked = await verifyToken(remote, accessToken, signal);
        return connectToken(checked, remember, signal);
      });
    },
    async connectGitCredential (remoteUrl, login) {
      if (!gitCredentialHelper || !confirmGitCredential) throw new GitServiceError(403, 'GIT_UNAVAILABLE');
      const remote = parseRemote(remoteUrl);
      if (!isGitHubLogin(login)) throw new GitServiceError(400, 'BAD_REQUEST');
      return runAuthOperation(async signal => {
        if (!await gitCredentialHelper.available(remote, signal)) throw new GitServiceError(403, 'GIT_UNAVAILABLE');
        signal.throwIfAborted();
        const approved = await confirmGitCredential(remote, login, signal);
        signal.throwIfAborted();
        if (approved !== true) return null;
        const accessToken = await gitCredentialHelper.read(remote, login, signal);
        signal.throwIfAborted();
        const checked = await verifyToken(remote, accessToken, signal);
        if (checked.account.login.toLowerCase() !== login.toLowerCase()) throw new GitServiceError(403, 'FORBIDDEN');
        return connectToken(checked, false, signal);
      });
    },
    async restore () {
      return runAuthOperation(async signal => {
        if (getState().status === 'connected') return true;
        const saved = await store?.read(signal);
        signal.throwIfAborted();
        if (saved?.kind !== PERSONAL_TOKEN) return github.restore(saved);
        const {repository: previous, accessToken} = saved;
        if (!promptPersonalToken || !isPersonalToken(accessToken) || !Number.isSafeInteger(previous?.id) ||
            previous.id <= 0 || typeof previous.owner !== 'string' || typeof previous.repo !== 'string') return false;
        const remote = parseRemote('https://github.com/' + previous.owner + '/' + previous.repo);
        try {
          const checked = await verifyToken(remote, accessToken, signal, previous.id);
          signal.throwIfAborted();
          tokenReauthRequired = false;
          localToken = {...checked, remembered: true};
          return true;
        } catch (error) {
          signal.throwIfAborted();
          if (error.code === 'REAUTH_REQUIRED') {
            tokenReauthRequired = true;
            await store.clear().catch(() => {});
          }
          throw error;
        }
      });
    },
    getState,
    async createSession (remoteUrl, write = false) {
      if (closed) throw new GitServiceError(401, 'SESSION_REQUIRED');
      if (typeof write !== 'boolean') throw new GitServiceError(400, 'BAD_REQUEST');
      const remote = parseRemote(remoteUrl);
      const {signal} = lifetime;
      const ticket = ++revision;
      const credentials = await getCredentials();
      const {account, accessToken, expiresAt = Infinity} = credentials;
      if (credentials.repository && !sameRemote(remote, credentials.repository)) {
        throw new GitServiceError(403, 'FORBIDDEN');
      }
      const approved = await repository(remote, write, accessToken, signal);
      if (credentials.repository && approved.id !== credentials.repository.id) {
        throw new GitServiceError(403, 'FORBIDDEN');
      }
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
      return session && !tokenReauthRequired && !expired(session) ? session.public : null;
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

module.exports = {startDesktopGit, PERSONAL_TOKEN, GIT_CREDENTIAL_HELPER};
