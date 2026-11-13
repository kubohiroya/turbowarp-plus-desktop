const {randomBytes} = require('node:crypto');
const {createGitHubAuth, GitServiceError} = require('./github-auth');
const {startGitProxy} = require('./git-proxy');
const {createRepositoryCreationGitHub, validLogin, sameName} = require('./repository-creation-github');

const SCOPE = 'repository-creation';
const SESSION_MS = 5 * 60_000;
const MAX_INPUT = 4 * 1024;
const operationIdPattern = /^[A-Za-z0-9_-]{1,100}$/u;
const creationBearer = /^Bearer (create\.[A-Za-z0-9_-]{43})$/u;

function validateOperation (operationId, repositoryId) {
  if (typeof operationId !== 'string' || !operationIdPattern.test(operationId) ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1) throw new GitServiceError(400, 'BAD_REQUEST');
}

function matchRepository (current, repository) {
  return current?.id === repository.id && sameName(current.owner?.login, repository.owner) &&
    sameName(current.name, repository.name) && current.private === (repository.visibility === 'private');
}

function resultStatus (code) {
  switch (code) {
    case 'denied': return 401;
    case 'nameConflict': return 409;
    case 'insufficientPermission': return 403;
    case 'rateLimited': return 429;
    case 'invalidRequest': return 400;
    default: return 502;
  }
}

async function readInput (req) {
  const length = req.headers['content-length'];
  if (req.headers['content-type'] !== 'application/json' || req.headersDistinct['content-type']?.length !== 1 ||
      !/^[1-9][0-9]*$/u.test(length ?? '') || req.headers['transfer-encoding']) {
    throw new GitServiceError(400, 'BAD_REQUEST');
  }
  const size = Number(length);
  if (size > MAX_INPUT) throw new GitServiceError(413, 'PAYLOAD_TOO_LARGE');
  let count = 0;
  const chunks = [];
  for await (const chunk of req) {
    count += chunk.length;
    if (count > size) throw new GitServiceError(400, 'BAD_REQUEST');
    chunks.push(chunk);
  }
  try {
    if (count !== size) throw new Error();
    const input = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input;
  } catch {
    throw new GitServiceError(400, 'BAD_REQUEST');
  }
}

async function startRepositoryCreation ({
  clientId, journal, contract, confirmCreate, confirmAdoption, request = fetch, now = Date.now, wait, origin
}) {
  // A different auth instance cannot turn a normal sync session (including PAT/helper) into a creation session.
  const auth = createGitHubAuth(clientId, {request, now, wait});
  let lifetime = new AbortController();
  let creation = null;
  let initialPush = null;
  let flow = null;
  let closed = false;

  const deny = () => new GitServiceError(401, 'REAUTH_REQUIRED');

  function requireCreation (bearer) {
    const grant = creation;
    if (!grant || grant.public.expiresAt <= now() || (bearer !== undefined && grant.public.bearer !== bearer)) throw deny();
    return grant;
  }

  function replaceInitialPush (next = null) {
    initialPush?.controller.abort();
    initialPush = next;
  }

  function revoke () {
    lifetime.abort();
    lifetime = new AbortController();
    creation = null;
    flow = null;
    replaceInitialPush();
    auth.disconnect();
  }

  function githubFor (grant, signal) {
    return createRepositoryCreationGitHub({request, now, signal, async getAccessToken () {
      if (requireCreation() !== grant) throw deny();
      const {account, accessToken} = await auth.getCredentials();
      signal.throwIfAborted();
      if (requireCreation() !== grant || !sameName(account.login, grant.public.account.login)) throw deny();
      return accessToken;
    }});
  }

  function hostFor (grant, signal, reportTopicsError = () => {}) {
    const github = githubFor(grant, signal);
    return contract.createRepositoryCreationHost({
      journal, now,
      github: {
        ...github,
        async create (type, draft) {
          const accepted = await confirmCreate({...draft, account: grant.public.account.login}, signal);
          signal.throwIfAborted();
          if (!accepted) return {status: 'refused', code: 'denied'};
          return github.create(type, draft);
        },
        async setTopics (repository, topics) {
          try {
            if (!grant.owners.some(owner => sameName(owner.login, repository.owner) && owner.canSetTopics)) {
              throw new GitServiceError(403, 'FORBIDDEN');
            }
            await github.setTopics(repository, topics);
          } catch (error) {
            reportTopicsError(error);
            throw error;
          }
        }
      },
      confirmAdoption: candidate => confirmAdoption({...candidate, account: grant.public.account.login}, signal)
    });
  }

  async function handleCreation (req, res) {
    const respond = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, value ? {'Content-Type': 'application/json'} : undefined);
      res.end(value ? JSON.stringify(value) : undefined);
    };
    const owners = req.url === '/v1/github-create/owners';
    const repos = req.url === '/v1/github-create/repos';
    const topics = /^\/v1\/github-create\/repos\/([1-9][0-9]{0,15})\/topics$/u.exec(req.url);
    if (!owners && !repos && !topics) return respond(404, {code: 'invalidRequest'});
    const method = owners ? 'GET' : repos ? 'POST' : 'PUT';
    if (req.method === 'OPTIONS') {
      const allowed = owners ? ['authorization'] : ['authorization', 'content-type'];
      const requested = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',')
        .map(header => header.trim()).filter(Boolean);
      if (req.headers['access-control-request-method'] !== method || requested.some(header => !allowed.includes(header))) {
        return respond(403, {code: 'denied'});
      }
      res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      res.setHeader('Access-Control-Allow-Methods', method);
      res.setHeader('Access-Control-Allow-Headers', allowed.join(', '));
      return respond(204);
    }
    if (req.method !== method) return respond(405, {code: 'invalidRequest'});
    const authorization = creationBearer.exec(req.headers.authorization ?? '');
    if (!authorization || req.headersDistinct.authorization?.length !== 1) return respond(401, {code: 'denied'});
    try {
      const grant = requireCreation(authorization[1]);
      const {signal} = lifetime;
      if (owners) {
        if (req.headers['transfer-encoding'] || (req.headers['content-length'] ?? '0') !== '0') {
          return respond(400, {code: 'invalidRequest'});
        }
        return respond(200, {owners: grant.owners.map(({login, type, canCreate}) => ({login, type, canCreate}))});
      }
      const input = await readInput(req);
      if (requireCreation(authorization[1]) !== grant) throw deny();
      if (repos) {
        const attempt = await hostFor(grant, signal).create(grant.authority, input);
        if (attempt.status === 'created') return respond(201, attempt.repository);
        if (attempt.status === 'refused') return respond(resultStatus(attempt.code), {code: attempt.code});
        return respond(502, {code: 'unknown'});
      }
      if (Object.keys(input).length !== 1) return respond(400, {code: 'invalidRequest'});
      const repositoryId = Number(topics[1]);
      validateOperation(input.operationId, repositoryId);
      let topicsError;
      const host = hostFor(grant, signal, error => { topicsError = error; });
      const attempt = await host.applyTopics(grant.authority, input.operationId, repositoryId);
      if (attempt.status === 'created' && ['not-requested', 'applied'].includes(attempt.topicsStatus)) return respond(204);
      if (topicsError instanceof GitServiceError) {
        const code = topicsError.status === 403 ? 'insufficientPermission' :
          topicsError.status === 429 ? 'rateLimited' : 'failed';
        return respond(topicsError.status, {code});
      }
      return respond(502, {code: 'failed'});
    } catch (error) {
      if (error instanceof contract.RepositoryCreationError) return respond(resultStatus(error.code), {code: error.code});
      if (error instanceof GitServiceError) return respond(error.status, {code: error.code});
      return respond(502, {code: repos ? 'unknown' : 'failed'});
    }
  }

  const proxy = await startGitProxy({request, origin, handleCreation,
    async authorize (bearer, route, signal, pushId) {
      const selected = initialPush;
      if (!selected || selected.session.bearer !== bearer || selected.session.expiresAt <= now()) throw deny();
      if (!sameName(route.owner, selected.repository.owner) || !sameName(route.repo, selected.repository.name)) {
        throw new GitServiceError(403, 'FORBIDDEN');
      }
      const requestSignal = AbortSignal.any([signal, lifetime.signal, selected.controller.signal]);
      const github = githubFor(selected.grant, requestSignal);
      const verified = await github.find(selected.repository.owner, selected.repository.name);
      if (!matchRepository(verified, selected.repository) || verified.permissions?.push !== true) {
        throw new GitServiceError(403, 'FORBIDDEN');
      }
      if (pushId) {
        if (selected.pushId) throw new GitServiceError(409, 'PUSH_DUPLICATE');
        if (!await github.isEmpty(selected.repository)) throw new GitServiceError(409, 'INITIAL_PUSH_NOT_EMPTY');
      }
      const {account, accessToken} = await auth.getCredentials();
      requestSignal.throwIfAborted();
      if (selected !== initialPush || selected.session.expiresAt <= now() ||
          !sameName(account.login, selected.grant.public.account.login)) throw deny();
      if (pushId) {
        if (selected.pushId) throw new GitServiceError(409, 'PUSH_DUPLICATE');
        selected.pushId = pushId;
      }
      return {accessToken, repository: {owner: selected.repository.owner, repo: selected.repository.name},
        signal: selected.controller.signal};
    },
    // The verified newly created repository should not need a redirect.
    resolveRedirect: () => null
  });
  const connection = Object.freeze({mode: 'desktop', proxyOrigin: proxy.proxyOrigin});

  return {
    connection,
    async begin () {
      if (closed) throw deny();
      if (flow) throw new GitServiceError(409, 'AUTH_IN_PROGRESS');
      revoke();
      const started = {ready: false};
      flow = started;
      const {signal} = lifetime;
      try {
        if (!await journal.available()) throw new GitServiceError(503, 'STORAGE_FAILURE');
        signal.throwIfAborted();
        const code = await auth.begin(false);
        signal.throwIfAborted();
        started.ready = true;
        return code;
      } catch (error) {
        if (flow === started) flow = null;
        throw error;
      }
    },
    async finish () {
      if (closed || !flow?.ready) throw deny();
      const started = flow;
      started.ready = false;
      const {signal} = lifetime;
      try {
        const {account, expiresAt} = await auth.finish();
        if (!validLogin(account.login)) throw deny();
        const github = createRepositoryCreationGitHub({request, now, signal,
          getAccessToken: async () => (await auth.getCredentials()).accessToken});
        const owners = await github.owners(account);
        signal.throwIfAborted();
        if (!owners.length) throw new GitServiceError(403, 'FORBIDDEN');
        const publicGrant = {scope: SCOPE, connection, account: {login: account.login},
          bearer: 'create.' + randomBytes(32).toString('base64url'), expiresAt: Math.min(expiresAt, now() + SESSION_MS)};
        creation = {public: publicGrant, owners, authority: {scope: SCOPE, account: publicGrant.account, owners}};
        return publicGrant;
      } finally {
        if (flow === started) flow = null;
      }
    },
    getGrant () {
      return creation?.public.expiresAt > now() ? creation.public : null;
    },
    async authorizeInitialPush (operationId, repositoryId) {
      validateOperation(operationId, repositoryId);
      const grant = requireCreation();
      const {signal} = lifetime;
      const record = await journal.read(operationId);
      if (record?.status !== 'created' || record.repository.id !== repositoryId ||
          !sameName(record.account, grant.public.account.login) ||
          !grant.owners.some(owner => sameName(owner.login, record.repository.owner) &&
            owner.canCreate[record.repository.visibility])) throw deny();
      const {repository} = record;
      const current = await githubFor(grant, signal).find(repository.owner, repository.name);
      signal.throwIfAborted();
      if (requireCreation() !== grant) throw deny();
      if (!matchRepository(current, repository) || current.permissions?.push !== true) {
        throw new GitServiceError(403, 'FORBIDDEN');
      }
      const session = {connection, account: grant.public.account, bearer: randomBytes(32).toString('base64url'),
        expiresAt: grant.public.expiresAt};
      replaceInitialPush({operationId, grant, repository, session, controller: new AbortController()});
      return {remote: repository.remote, repositoryId, session};
    },
    revokeInitialPush (operationId, repositoryId, bearer) {
      validateOperation(operationId, repositoryId);
      if (initialPush?.operationId === operationId && initialPush.repository.id === repositoryId &&
          initialPush.session.bearer === bearer) replaceInitialPush();
    },
    async inspectUnknown (operationId) {
      const grant = requireCreation();
      return hostFor(grant, lifetime.signal).inspectUnknown(grant.authority, operationId);
    },
    async inspectCreation (operationId) {
      const grant = requireCreation();
      return hostFor(grant, lifetime.signal).inspectCreation(grant.authority, operationId);
    },
    async adoptUnknown (operationId, repositoryId) {
      validateOperation(operationId, repositoryId);
      const grant = requireCreation();
      const attempt = await hostFor(grant, lifetime.signal).adoptUnknown(grant.authority, operationId, repositoryId);
      return attempt.status === 'created' ? attempt.repository : null;
    },
    disconnect: revoke,
    async close () {
      closed = true;
      revoke();
      await proxy.close();
    }
  };
}

module.exports = {startRepositoryCreation};
