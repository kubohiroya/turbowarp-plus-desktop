const {setTimeout: delay} = require('node:timers/promises');

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_URL = 'https://api.github.com';
const safeToken = /^[A-Za-z0-9_]+$/u;

class GitServiceError extends Error {
  constructor (status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function createGitHubAuth (clientId, {request = fetch, now = Date.now, wait = delay} = {}) {
  if (typeof clientId !== 'string' || !safeToken.test(clientId)) throw new Error('Invalid GitHub App client ID');
  let lifetime = new AbortController();
  let deviceFlow = null;
  let credentials = null;
  let pending = null;

  const unauthorized = () => new GitServiceError(401, 'REAUTH_REQUIRED');

  async function json (url, options, signal) {
    try {
      const response = await request(url, {
        ...options, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      });
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

  async function github (path, accessToken, signal) {
    const {status, value} = await json(API_URL + path, {
      headers: {Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + accessToken}
    }, signal);
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

  async function begin () {
    const {signal} = lifetime;
    if (deviceFlow || pending) throw new GitServiceError(409, 'AUTH_IN_PROGRESS');
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
      credentials = {...tokens, account: {login: user.login}};
      return credentials;
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
    return {account: result.account, expiresAt: result.expiresAt};
  }

  async function refresh (current, signal) {
    try {
      const response = await oauth(TOKEN_URL, {
        grant_type: 'refresh_token', refresh_token: current.refreshToken
      }, signal);
      const updated = acceptTokens(response);
      signal.throwIfAborted();
      credentials = {...updated, account: current.account};
      return credentials;
    } catch (error) {
      if (!signal.aborted && error.status === 401) credentials = null;
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

  function disconnect () {
    lifetime.abort();
    lifetime = new AbortController();
    deviceFlow = credentials = pending = null;
  }

  return {
    begin, finish, disconnect, getCredentials,
    repository: (owner, repo, accessToken, signal) =>
      github('/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo), accessToken, signal)
  };
}

module.exports = {createGitHubAuth, GitServiceError};
