const {GitServiceError, restRateLimited, retryAfterSeconds} = require('./github-auth');

const API = 'https://api.github.com';
const loginPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const validLogin = login => typeof login === 'string' && loginPattern.test(login);
const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const repositoryPath = (owner, name) => '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name);

function createRepositoryCreationGitHub ({request, getAccessToken, signal, now = Date.now}) {
  async function send (route, method = 'GET', data) {
    signal.throwIfAborted();
    const accessToken = await getAccessToken();
    const response = await request(API + route, {
      method, signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]), redirect: 'error', cache: 'no-store',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'TurboWarp-Plus-Desktop',
        ...(data !== undefined && {'Content-Type': 'application/json'})
      },
      ...(data !== undefined && {body: JSON.stringify(data)})
    });
    signal.throwIfAborted();
    if (restRateLimited(response)) {
      await response.body?.cancel().catch(() => {});
      throw new GitServiceError(429, 'RATE_LIMITED', retryAfterSeconds(response.headers, now));
    }
    return response;
  }

  async function requireStatus (response, status) {
    if (response.status === status) return;
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new GitServiceError(401, 'REAUTH_REQUIRED');
    if (response.status === 403 || response.status === 404) throw new GitServiceError(403, 'FORBIDDEN');
    throw new GitServiceError(502, 'UPSTREAM_FAILURE');
  }

  async function find (owner, name) {
    const response = await send(repositoryPath(owner, name));
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    await requireStatus(response, 200);
    return response.json();
  }

  async function owners (account) {
    const result = new Map();
    // The installation authorizes the app; organization policy and the user's permissions are checked by GitHub on POST.
    for (let page = 1; page <= 10; page++) {
      const response = await send('/user/installations?per_page=100&page=' + page);
      await requireStatus(response, 200);
      const body = await response.json();
      if (!Array.isArray(body?.installations) || body.installations.length > 100) {
        throw new GitServiceError(502, 'UPSTREAM_FAILURE');
      }
      for (const installation of body.installations) {
        const {account: target, target_type: type, permissions, suspended_at: suspended} = installation ?? {};
        const login = target?.login;
        if (!validLogin(login) || suspended ||
            (type !== 'Organization' && (type !== 'User' || !sameName(login, account.login))) ||
            (permissions?.repository_creation !== 'write' && permissions?.administration !== 'write') ||
            permissions?.contents !== 'write') continue;
        result.set(login.toLowerCase(), {
          login, type, canCreate: {private: true, public: true},
          canSetTopics: permissions.administration === 'write'
        });
      }
      if (body.installations.length < 100 || body.total_count <= 100 * page) return [...result.values()];
    }
    throw new GitServiceError(502, 'UPSTREAM_FAILURE');
  }

  async function create (type, {owner, name, description, visibility}) {
    const route = type === 'User' ? '/user/repos' : '/orgs/' + encodeURIComponent(owner) + '/repos';
    const response = await send(route, 'POST', {name, description, private: visibility === 'private', auto_init: false})
      .catch(error => {
        // A rate-limit response explicitly refused this write.
        if (error instanceof GitServiceError && error.code === 'RATE_LIMITED') return null;
        throw error;
      });
    if (!response) return {status: 'refused', code: 'rateLimited'};
    if (response.status === 201) return {status: 'created', body: await response.json()};
    if (response.status === 409 || response.status === 422) {
      const value = await response.json().catch(() => null);
      const conflict = Array.isArray(value?.errors) && value.errors.some(error => error?.field === 'name' &&
        (error.code === 'already_exists' || /already exists/iu.test(error.message ?? '')));
      return {status: 'refused', code: conflict ? 'nameConflict' : 'failed'};
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) return {status: 'refused', code: 'denied'};
    if (response.status === 403 || response.status === 404) return {status: 'refused', code: 'insufficientPermission'};
    if (response.status === 400) return {status: 'refused', code: 'failed'};
    // A transport failure or unexpected response does not prove the repository was not created.
    throw new GitServiceError(502, 'UPSTREAM_FAILURE');
  }

  return {
    owners,
    create,
    find,
    async isEmpty ({owner, name}) {
      const root = repositoryPath(owner, name);
      for (const ref of ['/branches?per_page=1', '/tags?per_page=1']) {
        const response = await send(root + ref);
        await requireStatus(response, 200);
        const value = await response.json();
        if (!Array.isArray(value) || value.length) return false;
      }
      return true;
    },
    async setTopics ({owner, name}, topics) {
      const response = await send(repositoryPath(owner, name) + '/topics', 'PUT', {names: topics});
      await requireStatus(response, 200);
      await response.body?.cancel().catch(() => {});
    }
  };
}

module.exports = {createRepositoryCreationGitHub, validLogin, sameName};
