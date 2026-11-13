const {setTimeout: delay} = require('node:timers/promises');

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_URL = 'https://api.github.com';
const safeToken = /^[A-Za-z0-9_]+$/u;

class GitServiceError extends Error {
  constructor (status, code, retryAfter) {
    super(code);
    this.status = status;
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/** Seconds until GitHub accepts requests again: `retry-after`, else `x-ratelimit-reset` minus now, else 60. */
function retryAfterSeconds (headers, now = Date.now) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && /^[0-9]+$/u.test(retryAfter)) return Number(retryAfter);
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null && /^[0-9]+$/u.test(reset)) return Math.max(0, Math.ceil(Number(reset) - now() / 1000));
  return 60;
}

/** A REST rate limit: `429`, or `403` with `x-ratelimit-remaining: 0` or `retry-after`. */
function restRateLimited (response) {
  return response.status === 429 || (response.status === 403 &&
    (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
}

function createGitHubAuth (clientId, {request = fetch, now = Date.now, wait = delay, store} = {}) {
  if (clientId !== undefined && (typeof clientId !== 'string' || !safeToken.test(clientId))) {
    throw new Error('Invalid GitHub App client ID');
  }
  let lifetime = new AbortController();
  let deviceFlow = null;
  let credentials = null;
  let pending = null;
  let remember = false;
  let remembered = false;

  const unauthorized = () => new GitServiceError(401, 'REAUTH_REQUIRED');

  async function json (url, options, signal, rateLimit = false, readError = true) {
    let response;
    try {
      response = await request(url, {
        ...options, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      });
    } catch {
      signal.throwIfAborted();
      throw new GitServiceError(502, 'UPSTREAM_FAILURE');
    }
    if (rateLimit && restRateLimited(response)) {
      await response.body?.cancel().catch(() => {});
      throw new GitServiceError(429, 'RATE_LIMITED', retryAfterSeconds(response.headers, now));
    }
    if (!readError && response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return {status: response.status};
    }
    try {
      return {status: response.status, value: await response.json()};
    } catch {
      signal.throwIfAborted();
      throw new GitServiceError(502, 'UPSTREAM_FAILURE');
    }
  }

  async function oauth (url, form, signal) {
    const {status, value} = await json(url, {
      method: 'POST',
      headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({client_id: clientId, ...form})
    }, signal);
    if (status === 429) throw new GitServiceError(429, 'RATE_LIMITED');
    if (status >= 500 || !value || typeof value !== 'object') throw new GitServiceError(502, 'UPSTREAM_FAILURE');
    if (status >= 400 && !value.error) throw unauthorized();
    return value;
  }

  async function github (path, accessToken, signal, rateLimit) {
    const {status, value} = await json(API_URL + path, {
      headers: {Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + accessToken}
    }, signal, rateLimit, false);
    if (status === 401) throw unauthorized();
    if (status === 429) throw new GitServiceError(429, 'RATE_LIMITED');
    if (status === 403 || status === 404) throw new GitServiceError(403, 'FORBIDDEN');
    if (status !== 200 || !value || typeof value !== 'object') throw new GitServiceError(502, 'UPSTREAM_FAILURE');
    return value;
  }

  function expiry (seconds) {
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(now() + seconds * 1000)) {
      throw new GitServiceError(502, 'UPSTREAM_FAILURE');
    }
    return now() + seconds * 1000;
  }

  function acceptTokens (response) {
    if (response.error || typeof response.access_token !== 'string' || !safeToken.test(response.access_token) ||
        typeof response.refresh_token !== 'string' || !safeToken.test(response.refresh_token)) {
      throw unauthorized();
    }
    return {
      accessToken: response.access_token,
      expiresAt: expiry(response.expires_in),
      refreshToken: response.refresh_token,
      refreshExpiresAt: expiry(response.refresh_token_expires_in)
    };
  }

  async function begin (persist = false) {
    if (!clientId) throw new GitServiceError(403, 'GIT_UNAVAILABLE');
    const {signal} = lifetime;
    if (deviceFlow || pending) throw new GitServiceError(409, 'AUTH_IN_PROGRESS');
    remember = persist;
    deviceFlow = {};
    try {
      const response = await oauth('https://github.com/login/device/code', {scope: 'offline_access'}, signal);
      signal.throwIfAborted();
      if (typeof response.device_code !== 'string' || !safeToken.test(response.device_code) ||
          typeof response.user_code !== 'string' || !/^[A-Z0-9-]+$/u.test(response.user_code) ||
          response.verification_uri !== 'https://github.com/login/device' ||
          !Number.isSafeInteger(response.interval) || response.interval < 1) throw unauthorized();
      const expiresAt = expiry(response.expires_in);
      deviceFlow = {code: response.device_code, interval: response.interval, expiresAt};
      return {userCode: response.user_code, verificationUri: response.verification_uri, expiresAt};
    } catch (error) {
      if (!signal.aborted) deviceFlow = null;
      throw error;
    }
  }

  async function poll (flow, signal) {
    let interval = flow.interval;
    while (now() < flow.expiresAt) {
      await wait(Math.min(interval * 1000, flow.expiresAt - now()), undefined, {signal});
      if (now() >= flow.expiresAt) break;
      const response = await oauth(TOKEN_URL, {
        device_code: flow.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }, signal);
      if (response.error === 'authorization_pending') continue;
      if (response.error === 'slow_down') {
        interval += 5;
        continue;
      }
      const tokens = acceptTokens(response);
      const user = await github('/user', tokens.accessToken, signal);
      signal.throwIfAborted();
      if (typeof user.login !== 'string' || !user.login) throw unauthorized();
      const updated = {...tokens, account: {login: user.login}};
      const saved = !!(remember && await store?.write(updated, signal));
      signal.throwIfAborted();
      if (store && !saved) {
        await store.clear().catch(() => { throw new GitServiceError(500, 'STORAGE_FAILURE'); });
      }
      signal.throwIfAborted();
      remembered = saved;
      credentials = updated;
      return updated;
    }
    throw unauthorized();
  }

  function track (operation, signal) {
    pending = operation.finally(() => {
      if (!signal.aborted) pending = null;
    });
    return pending;
  }

  async function finish () {
    if (!deviceFlow?.code || pending) throw new GitServiceError(409, 'AUTH_IN_PROGRESS');
    const {signal} = lifetime;
    const result = await track(poll(deviceFlow, signal).finally(() => {
      if (!signal.aborted) deviceFlow = null;
    }), signal);
    return {account: result.account, expiresAt: result.expiresAt, remembered};
  }

  async function refresh (current, signal) {
    try {
      const response = await oauth(TOKEN_URL, {
        grant_type: 'refresh_token', refresh_token: current.refreshToken
      }, signal);
      const updated = acceptTokens(response);
      signal.throwIfAborted();
      const renewed = {...updated, account: current.account};
      const saved = !!(remember && await store?.write(renewed, signal));
      signal.throwIfAborted();
      if (remember && store && !saved) await store.clear().catch(() => {});
      signal.throwIfAborted();
      remembered = saved;
      credentials = renewed;
      return renewed;
    } catch (error) {
      if (!signal.aborted && error.status === 401) {
        credentials = null;
        remembered = false;
        await store?.clear().catch(() => {});
      }
      throw error;
    }
  }

  async function getCredentials () {
    if (!credentials) throw unauthorized();
    if (credentials.expiresAt > now()) return credentials;
    if (credentials.refreshExpiresAt <= now()) {
      credentials = null;
      throw unauthorized();
    }
    return pending ?? track(refresh(credentials, lifetime.signal), lifetime.signal);
  }

  async function restore (saved) {
    if (!clientId || deviceFlow || pending) return false;
    if (!saved || typeof saved.accessToken !== 'string' || !safeToken.test(saved.accessToken) ||
        typeof saved.refreshToken !== 'string' || !safeToken.test(saved.refreshToken) ||
        !Number.isSafeInteger(saved.expiresAt) || !Number.isSafeInteger(saved.refreshExpiresAt) ||
        typeof saved.account?.login !== 'string' || !saved.account.login) return false;
    if (saved.refreshExpiresAt <= now() && saved.expiresAt <= now()) {
      await store.clear().catch(() => {});
      return false;
    }
    credentials = saved;
    remember = remembered = true;
    await getCredentials();
    return true;
  }

  function getState () {
    if (deviceFlow) return {status: 'connecting'};
    if (!credentials) return {status: 'disconnected'};
    if (credentials.expiresAt <= now() && credentials.refreshExpiresAt <= now()) return {status: 'reauth-required'};
    return {status: 'connected', account: {...credentials.account}, expiresAt: credentials.expiresAt, remembered};
  }

  function disconnect () {
    lifetime.abort();
    lifetime = new AbortController();
    deviceFlow = credentials = pending = null;
    remember = remembered = false;
  }

  return {
    begin, finish, restore, getState, disconnect, getCredentials,
    user: (accessToken, signal) => github('/user', accessToken, signal),
    // `rateLimit` reports a rate-limited lookup as `429 RATE_LIMITED` with `retryAfter` (the GitHub API routes).
    repository: (owner, repo, accessToken, signal, rateLimit = false) =>
      github('/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo), accessToken, signal, rateLimit)
  };
}

module.exports = {createGitHubAuth, GitServiceError, restRateLimited, retryAfterSeconds};
