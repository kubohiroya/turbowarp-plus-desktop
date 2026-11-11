const {randomUUID} = require('node:crypto');
const {GitServiceError, restRateLimited, retryAfterSeconds} = require('./github-auth');
const {githubReviewDocuments, isGitHubReviewOperation} = require('./github-review-documents');

/**
 * The pull request routes of the loopback proxy under `/v1/github/<owner>/<repo>/`. They follow the contract of the
 * Cloudflare Git Worker (hierarchidb packages/backend/bff/docs/git-smart-http.md, "GitHub API routes") so that the
 * Editor's Git package uses either proxy the same way. Only fixed routes and five fixed GraphQL documents are relayed.
 * The GitHub token and every node ID stay in the main process, and nothing of a request or a response is logged.
 */

const REST_ORIGIN = 'https://api.github.com';
const GRAPHQL_URL = 'https://api.github.com/graphql';
const USER_AGENT = 'TurboWarp-Plus-Desktop-Git';
const MAX_REQUEST_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT = 30_000;
const KIB = 1024;
const MIB = 1024 * KIB;
const MAX_BODY_LENGTH = 65_536;
const MAX_PATH_BYTES = 1024;
const MAX_PULL_REQUEST_NUMBER = 2_147_483_647;
const FEATURES = ['pulls-read', 'review-threads', 'reviews-body'];
const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
const submitIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const nodeIdPattern = /^[A-Za-z0-9_=-]{1,200}$/u;
const commitOidPattern = /^[0-9a-f]{40}$/u;
const pathPattern = new RegExp('^/v1/github/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9_.-]+)/' +
  '(?:(pulls)|pulls/([1-9][0-9]{0,9})|pulls/([1-9][0-9]{0,9})/(reviews)|graphql/([A-Za-z]+))$', 'u');

const stepOf = {
  pullRequestReviewContext: 'context',
  addPullRequestReview: 'start',
  addPullRequestReviewThread: 'thread',
  submitPullRequestReview: 'submit',
  deletePullRequestReview: 'delete'
};
const variableKeys = {
  pullRequestReviewContext: 'number',
  addPullRequestReview: 'commitOid,number',
  addPullRequestReviewThread: 'body,number,path,threadIndex',
  submitPullRequestReview: 'body,event,number,threadCount',
  deletePullRequestReview: 'number'
};

/** The upstream response did not have the contracted shape or size. */
class ShapeError extends Error {}

const isGitHubApiPath = url => url === '/v1/github' || url.startsWith('/v1/github/') || url.startsWith('/v1/github?');

/**
 * Parses the enabled route groups, such as `pulls-read,review-threads,reviews-body`. An absent or empty value disables
 * every route; an unknown or repeated value is a configuration error that fails every route instead of being ignored.
 */
function parseGitHubApiFeatures (value) {
  if (value === undefined || value === null || value.trim() === '') return null;
  const names = value.split(',').map(name => name.trim());
  if (!names.every(name => FEATURES.includes(name)) || new Set(names).size !== names.length) return 'invalid';
  return new Set(names);
}

function matchPath (path) {
  const match = pathPattern.exec(path);
  if (!match || match[0] !== path) return null;
  const [, owner, repo, pulls, pull, reviewsNumber, reviews, operation] = match;
  // The GitHub API names a repository without the `.git` suffix of the Git routes.
  if (['.', '..'].includes(repo) || repo.toLowerCase().endsWith('.git')) return null;
  if (pulls) return {owner, repo, feature: 'pulls-read', target: {kind: 'pulls'}};
  if (pull) {
    const number = Number(pull);
    return number > MAX_PULL_REQUEST_NUMBER ? null : {owner, repo, feature: 'pulls-read', target: {kind: 'pull', number}};
  }
  if (reviews) {
    const number = Number(reviewsNumber);
    return number > MAX_PULL_REQUEST_NUMBER ? null : {owner, repo, feature: 'reviews-body', target: {kind: 'reviews', number}};
  }
  return {owner, repo, feature: 'review-threads', target: {kind: 'graphql', operation}};
}

function parsePage (search, max) {
  if (search === '') return 1;
  const match = /^\?page=([1-9][0-9]?)$/u.exec(search);
  if (!match) return null;
  const page = Number(match[1]);
  return page <= max ? page : null;
}

function resolveRoute ({target}, method, search) {
  if (target.kind === 'pulls') {
    const page = method === 'GET' ? parsePage(search, 50) : null;
    return page === null ? null : {kind: 'pulls', page};
  }
  if (target.kind === 'pull') return method === 'GET' && search === '' ? {kind: 'pull', number: target.number} : null;
  if (target.kind === 'reviews') {
    if (method === 'POST') return search === '' ? {kind: 'create-review', number: target.number} : null;
    const page = method === 'GET' ? parsePage(search, 10) : null;
    return page === null ? null : {kind: 'reviews', number: target.number, page};
  }
  return method === 'POST' && search === '' && isGitHubReviewOperation(target.operation)
    ? {kind: 'graphql', operation: target.operation} : null;
}

const isJson = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInteger = (value, min, max) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const isBody = (value, minLength) => typeof value === 'string' && value.length >= minLength && value.length <= MAX_BODY_LENGTH;
const isEvent = value => typeof value === 'string' && EVENTS.includes(value);

/** A relative path whose last element is exactly `project.source.json`. */
function isProjectSourcePath (value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/u.test(value)) return false;
  const parts = value.split('/');
  return parts.at(-1) === 'project.source.json' && parts.every(part => part !== '' && part !== '.' && part !== '..');
}

function validateVariables (operation, input) {
  if (Object.keys(input).sort().join(',') !== variableKeys[operation]) return null;
  const {number, commitOid, threadIndex, path, body, threadCount, event} = input;
  if (!isInteger(number, 1, MAX_PULL_REQUEST_NUMBER)) return null;
  switch (operation) {
    case 'pullRequestReviewContext':
    case 'deletePullRequestReview':
      return {number};
    case 'addPullRequestReview':
      return typeof commitOid === 'string' && commitOidPattern.test(commitOid) ? {number, commitOid} : null;
    case 'addPullRequestReviewThread':
      return isInteger(threadIndex, 0, 49) && isProjectSourcePath(path) && isBody(body, 1)
        ? {number, threadIndex, path, body} : null;
    case 'submitPullRequestReview':
      if (!isInteger(threadCount, 0, 50) || !isEvent(event) || !isBody(body, 0)) return null;
      if (event === 'REQUEST_CHANGES' && body.length === 0) return null;
      if (event === 'COMMENT' && body.length === 0 && threadCount === 0) return null;
      return {number, threadCount, event, body};
    default:
      return null;
  }
}

function validateReview (input) {
  if (Object.keys(input).some(key => !['commit_id', 'event', 'body'].includes(key))) return null;
  const {commit_id: commitId, event, body} = input;
  if (typeof commitId !== 'string' || !commitOidPattern.test(commitId) || !isEvent(event)) return null;
  if (body === undefined) return event === 'APPROVE' ? {commit_id: commitId, event} : null;
  return isBody(body, event === 'APPROVE' ? 0 : 1) ? {commit_id: commitId, event, body} : null;
}

/** Reads a JSON response body of at most `limit` bytes. */
async function readJson (response, limit) {
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/json(;|$)/u.test(type) || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new ShapeError();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new ShapeError();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
  } catch {
    throw new ShapeError();
  }
}

// Shape readers. Each throws ShapeError when the upstream value does not have the contracted type.
const object = value => {
  if (!isJson(value)) throw new ShapeError();
  return value;
};
const string = value => {
  if (typeof value !== 'string') throw new ShapeError();
  return value;
};
const nullableString = value => value === null ? null : string(value);
const integer = value => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ShapeError();
  return value;
};
const boolean = value => {
  if (typeof value !== 'boolean') throw new ShapeError();
  return value;
};
const array = value => {
  if (!Array.isArray(value)) throw new ShapeError();
  return value;
};
const nodeId = value => {
  const id = string(value);
  if (!nodeIdPattern.test(id)) throw new ShapeError();
  return id;
};
const login = value => value === null ? null : {login: string(object(value).login)};
const commitOid = value => value === null ? null : string(object(value).oid);

function shapePullSummary (value) {
  const pull = object(value);
  const head = object(pull.head);
  const base = object(pull.base);
  return {
    number: integer(pull.number),
    title: string(pull.title),
    state: string(pull.state),
    draft: boolean(pull.draft),
    merged_at: nullableString(pull.merged_at),
    updated_at: string(pull.updated_at),
    user: login(pull.user),
    head: {sha: string(head.sha), ref: string(head.ref)},
    base: {sha: string(base.sha), ref: string(base.ref)}
  };
}

function shapeRevision (value) {
  const revision = object(value);
  return {
    sha: string(revision.sha),
    ref: string(revision.ref),
    repo: revision.repo === null ? null : {full_name: string(object(revision.repo).full_name)}
  };
}

function shapePull (value) {
  const pull = object(value);
  return {
    number: integer(pull.number),
    title: string(pull.title),
    state: string(pull.state),
    draft: boolean(pull.draft),
    merged_at: nullableString(pull.merged_at),
    user: login(pull.user),
    // The text media type returns `body_text`; `body` is included when GitHub sends it.
    ...(pull.body !== undefined && {body: nullableString(pull.body)}),
    body_text: nullableString(pull.body_text),
    changed_files: integer(pull.changed_files),
    head: shapeRevision(pull.head),
    base: shapeRevision(pull.base)
  };
}

function shapeReview (value) {
  const review = object(value);
  return {
    id: integer(review.id),
    user: login(review.user),
    commit_id: nullableString(review.commit_id),
    state: string(review.state),
    submitted_at: review.submitted_at === undefined ? null : nullableString(review.submitted_at),
    body: string(review.body)
  };
}

function shapeCreatedReview (value) {
  const review = object(value);
  return {
    id: integer(review.id),
    state: string(review.state),
    commit_id: nullableString(review.commit_id),
    submitted_at: review.submitted_at === undefined ? null : nullableString(review.submitted_at),
    html_url: string(review.html_url)
  };
}

function shapeContext (data, repositoryId) {
  const viewer = string(object(data.viewer).login);
  if (data.repository === null) throw new GitServiceError(403, 'FORBIDDEN');
  const repository = object(data.repository);
  if (integer(repository.databaseId) !== repositoryId) throw new GitServiceError(403, 'FORBIDDEN');
  if (repository.pullRequest === null) throw new GitServiceError(404, 'PULL_REQUEST_NOT_FOUND');
  const pull = object(repository.pullRequest);
  return {
    viewer,
    pullRequestNodeId: nodeId(pull.id),
    headRefOid: string(pull.headRefOid),
    pending: array(object(pull.pending).nodes).map(value => {
      const node = object(value);
      return {
        id: nodeId(node.id),
        // GitHub's `viewerDidAuthor`.
        ours: boolean(node.viewerDidAuthor),
        createdAt: string(node.createdAt),
        body: string(node.body),
        commitOid: commitOid(node.commit),
        comments: integer(object(node.comments).totalCount)
      };
    }),
    recent: array(object(pull.recent).nodes).map(value => {
      const node = object(value);
      return {
        id: nodeId(node.id),
        ours: boolean(node.viewerDidAuthor),
        state: string(node.state),
        submittedAt: nullableString(node.submittedAt),
        commitOid: commitOid(node.commit)
      };
    })
  };
}

function contextResponse (context, reviewNodeId, submit) {
  const pending = context.pending.find(review => review.ours);
  return {
    headRefOid: context.headRefOid,
    viewer: context.viewer,
    pendingReview: pending ? {
      ours: reviewNodeId !== null && pending.id === reviewNodeId,
      commitOid: pending.commitOid,
      createdAt: pending.createdAt
    } : null,
    reviews: context.recent.filter(review => review.ours).reverse().map(review => ({
      state: review.state,
      commitOid: review.commitOid,
      submittedAt: review.submittedAt,
      ours: reviewNodeId !== null && review.id === reviewNodeId
    })),
    ...(submit && {submit})
  };
}

/** Reads a request body of exactly `length` bytes. */
async function readRequest (req, length) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > length) return null;
    chunks.push(chunk);
  }
  return size === length ? Buffer.concat(chunks) : null;
}

/**
 * Handles one request under `/v1/github`. The caller has checked the peer address, `Host` and `Origin`, and set the
 * CORS and cache headers. `authorize(bearer, request, signal)` checks the session and the repository ID, reserves the
 * review submit ID or step, and returns `{accessToken, repository, signal, submit?, report?}`.
 */
async function handleGitHubApi (req, res, {features, authorize, request, now}) {
  const respond = (status, value) => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(value));
  };
  const fail = (status, code, retryAfter) =>
    respond(status, {code, requestId: randomUUID(), ...(retryAfter !== undefined && {retryAfter})});
  if (features === 'invalid') return fail(500, 'GITHUB_API_MISCONFIGURED');
  if (!features) return fail(404, 'GITHUB_API_UNAVAILABLE');

  const queryStart = req.url.indexOf('?');
  const pathname = queryStart < 0 ? req.url : req.url.slice(0, queryStart);
  const search = queryStart < 0 ? '' : req.url.slice(queryStart);
  const path = matchPath(pathname);
  if (!path) return fail(400, 'BAD_REQUEST');
  if (!features.has(path.feature)) return fail(404, 'GITHUB_API_UNAVAILABLE');
  const preflight = req.method === 'OPTIONS';
  const method = preflight ? req.headers['access-control-request-method'] : req.method;
  const route = typeof method === 'string' ? resolveRoute(path, method, search) : null;
  if (!route) return fail(400, 'BAD_REQUEST');
  const post = method === 'POST';
  if (preflight) {
    res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    const allowed = post ? ['authorization', 'content-type', 'review-submit-id'] : ['authorization'];
    const requested = (req.headers['access-control-request-headers'] || '').toLowerCase().split(',')
      .map(header => header.trim()).filter(Boolean);
    if (requested.some(header => !allowed.includes(header))) return fail(403, 'FORBIDDEN');
    res.writeHead(204, {'Access-Control-Allow-Methods': method, 'Access-Control-Allow-Headers': allowed.join(', ')});
    return res.end();
  }

  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(req.headers.authorization ?? '');
  if (!bearer || req.headersDistinct.authorization?.length !== 1) return fail(401, 'SESSION_REQUIRED');
  const submitId = req.headers['review-submit-id'];
  const length = req.headers['content-length'];
  let input = null;
  if (post) {
    if (req.headers['content-type'] !== 'application/json') return fail(400, 'BAD_REQUEST');
    if (!/^[0-9]+$/u.test(length ?? '') || req.headers['transfer-encoding']) return fail(411, 'LENGTH_REQUIRED');
    if (Number(length) > MAX_REQUEST_BYTES) return fail(413, 'PAYLOAD_TOO_LARGE');
    if (Number(length) === 0) return fail(400, 'BAD_REQUEST');
    const bytes = await readRequest(req, Number(length));
    if (!bytes) return fail(400, 'BAD_REQUEST');
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
      if (isJson(parsed)) input = parsed;
    } catch {
      return fail(400, 'BAD_REQUEST');
    }
    if (!input) return fail(400, 'BAD_REQUEST');
  } else if ((length !== undefined && length !== '0') || req.headers['transfer-encoding']) {
    return fail(400, 'BAD_REQUEST');
  }
  const submitRequired = route.kind === 'create-review' ||
    (route.kind === 'graphql' && route.operation !== 'pullRequestReviewContext');
  const submitAllowed = submitRequired || route.kind === 'graphql';
  if (submitId !== undefined
    ? !submitAllowed || !submitIdPattern.test(submitId) || req.headersDistinct['review-submit-id']?.length !== 1
    : submitRequired) {
    return fail(400, 'BAD_REQUEST');
  }
  const review = route.kind === 'create-review' ? validateReview(input) : null;
  if (route.kind === 'create-review' && !review) return fail(400, 'BAD_REQUEST');
  const variables = route.kind === 'graphql' ? validateVariables(route.operation, input) : null;
  if (route.kind === 'graphql' && !variables) return fail(400, 'BAD_REQUEST');

  // A read stops when the Editor goes away. A step that may change GitHub runs to its end, so that its outcome is
  // recorded; only the timeout and the end of the session stop it.
  const cancellation = new AbortController();
  res.once('close', () => { if (!res.writableFinished) cancellation.abort(); });
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT);
  const reserves = route.kind === 'create-review' || (route.kind === 'graphql' && submitId !== undefined);

  const rest = (grant, suffix, accept, signal, body) => request(REST_ORIGIN + '/repos/' + grant.repository.owner + '/' +
    grant.repository.repo + suffix, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + grant.accessToken,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
      ...(body !== undefined && {'Content-Type': 'application/json'})
    },
    ...(body !== undefined && {body}),
    redirect: 'manual',
    cache: 'no-store',
    signal
  });
  const restFailure = async (response, notFound, rejected) => {
    await response.body?.cancel().catch(() => {});
    if (response.status >= 300 && response.status < 400) return new GitServiceError(409, 'REDIRECT_REJECTED');
    if (restRateLimited(response)) return new GitServiceError(429, 'RATE_LIMITED', retryAfterSeconds(response.headers, now));
    if (response.status === 401 || response.status === 403) return new GitServiceError(403, 'FORBIDDEN');
    if (response.status === 404) return notFound;
    if (response.status === 422 && rejected) return rejected;
    if (response.status === 504) return new GitServiceError(504, 'UPSTREAM_TIMEOUT');
    return new GitServiceError(502, 'UPSTREAM_FAILURE');
  };

  async function graphql (grant, operation, graphqlVariables) {
    let response;
    try {
      response = await request(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + grant.accessToken,
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({query: githubReviewDocuments[operation], variables: graphqlVariables}),
        redirect: 'manual',
        cache: 'no-store',
        signal: grant.upstreamSignal
      });
    } catch {
      // The request may have reached GitHub before the connection failed.
      return {kind: 'unknown', timeout: timeout.aborted};
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      return {kind: 'redirect'};
    }
    if (restRateLimited(response)) {
      await response.body?.cancel().catch(() => {});
      return {kind: 'rate-limited', retryAfter: retryAfterSeconds(response.headers, now)};
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      return {kind: 'forbidden'};
    }
    if (response.status === 502 || response.status === 504) {
      await response.body?.cancel().catch(() => {});
      return {kind: 'unknown', timeout: response.status === 504};
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return {kind: 'not-sent'};
    }
    const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
    const retryAfter = retryAfterSeconds(response.headers, now);
    let body;
    try {
      body = await readJson(response, operation === 'pullRequestReviewContext' ? 256 * KIB : 64 * KIB);
    } catch {
      return {kind: 'unknown', timeout: timeout.aborted};
    }
    if (!isJson(body)) return {kind: 'unknown', timeout: false};
    const data = isJson(body.data) ? body.data : null;
    if (body.errors === undefined) {
      // A well-formed success is a success even when it consumed the last point.
      if (data) return {kind: 'ok', data};
      return exhausted ? {kind: 'rate-limited', retryAfter} : {kind: 'unknown', timeout: false};
    }
    if (!Array.isArray(body.errors) || body.errors.length === 0) return {kind: 'unknown', timeout: false};
    const types = body.errors.map(error => isJson(error) ? error.type : undefined);
    if (exhausted || types.includes('RATE_LIMITED')) return {kind: 'rate-limited', retryAfter};
    if (types.includes('FORBIDDEN')) return {kind: 'forbidden'};
    if (types.includes('NOT_FOUND')) return {kind: 'not-found', data};
    if (body.data === null || body.data === undefined) return {kind: 'rejected'};
    return {kind: 'unknown', timeout: false};
  }

  /** The client error for an outcome in which GitHub did not apply the request. */
  const unsent = (outcome, rejected, notFound) => {
    switch (outcome.kind) {
      case 'rate-limited': return new GitServiceError(429, 'RATE_LIMITED', outcome.retryAfter);
      case 'forbidden': return new GitServiceError(403, 'FORBIDDEN');
      case 'not-found': return notFound;
      case 'rejected': return rejected;
      case 'redirect': return new GitServiceError(409, 'REDIRECT_REJECTED');
      default: return new GitServiceError(502, 'UPSTREAM_FAILURE');
    }
  };
  const unknownError = outcome => outcome.timeout
    ? new GitServiceError(504, 'UPSTREAM_TIMEOUT') : new GitServiceError(502, 'UPSTREAM_FAILURE');
  const upstreamFailure = () => new GitServiceError(502, 'UPSTREAM_FAILURE');
  const pullNotFound = () => new GitServiceError(404, 'PULL_REQUEST_NOT_FOUND');

  /** Records the outcome of the reserved step. A failure to record is reported as an unknown outcome. */
  const report = (grant, outcome, ids = {}) => {
    try {
      return grant.report(outcome, ids);
    } catch {
      throw upstreamFailure();
    }
  };

  /** Reads the review context of the pull request in the verified repository. */
  async function readContext (grant, number) {
    const outcome = await graphql(grant, 'pullRequestReviewContext', {
      owner: grant.repository.owner, name: grant.repository.repo, number
    });
    if (outcome.kind === 'unknown') throw unknownError(outcome);
    if (outcome.kind === 'not-found') {
      // A missing pull request in the verified repository is reported as such; anything else (such as a renamed
      // repository that `followRenames: false` does not follow) is forbidden.
      const repository = outcome.data?.repository;
      if (isJson(repository) && repository.databaseId === grant.repository.id && repository.pullRequest === null) {
        throw pullNotFound();
      }
      throw new GitServiceError(403, 'FORBIDDEN');
    }
    if (outcome.kind !== 'ok') throw unsent(outcome, upstreamFailure(), pullNotFound());
    try {
      return shapeContext(outcome.data, grant.repository.id);
    } catch (error) {
      if (error instanceof GitServiceError) throw error;
      throw upstreamFailure();
    }
  }

  async function run () {
    const authorizeSignal = AbortSignal.any([cancellation.signal, timeout]);
    const grantFor = async value => {
      const grant = await authorize(bearer[1], {owner: path.owner, repo: path.repo, ...value}, authorizeSignal);
      const signals = [timeout, grant.signal];
      if (!reserves) signals.push(cancellation.signal);
      return {...grant, upstreamSignal: AbortSignal.any(signals)};
    };

    if (route.kind === 'pulls' || route.kind === 'pull' || route.kind === 'reviews') {
      const grant = await grantFor({operation: 'read'});
      const {suffix, accept, limit, shape} = route.kind === 'pulls' ? {
        suffix: '/pulls?state=all&sort=updated&direction=desc&per_page=20&page=' + route.page,
        accept: 'application/vnd.github+json',
        limit: MIB,
        shape: value => array(value).map(shapePullSummary)
      } : route.kind === 'pull' ? {
        suffix: '/pulls/' + route.number,
        accept: 'application/vnd.github.text+json',
        limit: MIB,
        shape: shapePull
      } : {
        suffix: '/pulls/' + route.number + '/reviews?per_page=30&page=' + route.page,
        accept: 'application/vnd.github+json',
        limit: 4 * MIB,
        shape: value => array(value).map(shapeReview)
      };
      const response = await rest(grant, suffix, accept, grant.upstreamSignal);
      if (response.status !== 200) {
        throw await restFailure(response, route.kind === 'pulls' ? new GitServiceError(403, 'FORBIDDEN') : pullNotFound());
      }
      try {
        return shape(await readJson(response, limit));
      } catch {
        throw upstreamFailure();
      }
    }

    if (route.kind === 'create-review') {
      const grant = await grantFor({operation: 'review', reviewId: submitId});
      let response;
      try {
        response = await rest(grant, '/pulls/' + route.number + '/reviews', 'application/vnd.github+json',
          grant.upstreamSignal, JSON.stringify(review));
      } catch {
        throw unknownError({timeout: timeout.aborted});
      }
      if (response.status !== 200) {
        throw await restFailure(response, pullNotFound(), new GitServiceError(422, 'REVIEW_REJECTED'));
      }
      try {
        return shapeCreatedReview(await readJson(response, MIB));
      } catch {
        throw unknownError({timeout: timeout.aborted});
      }
    }

    const step = stepOf[route.operation];
    if (step === 'context' && submitId === undefined) {
      const grant = await grantFor({operation: 'read'});
      return contextResponse(await readContext(grant, variables.number), null);
    }
    const grant = await grantFor({
      operation: step === 'context' ? 'read' : 'review',
      submit: {
        id: submitId,
        step,
        number: variables.number,
        ...(step === 'start' && {commitOid: variables.commitOid}),
        ...(step === 'thread' && {threadIndex: variables.threadIndex}),
        ...(step === 'submit' && {threadCount: variables.threadCount})
      }
    });
    const submit = grant.submit;
    if (!submit) throw upstreamFailure();

    if (step === 'context') {
      const context = await readContext(grant, variables.number);
      let resolved = {state: submit.state, threads: submit.threads};
      let reviewNodeId = submit.reviewNodeId;
      if (submit.state === 'start-unknown') {
        // The review the start step creates is the viewer's pending review on the recorded commit with an empty
        // body and no comments.
        const created = context.pending.find(candidate => candidate.ours && candidate.commitOid === submit.commitOid &&
          candidate.body === '' && candidate.comments === 0);
        resolved = created
          ? report(grant, 'pending', {pullRequestNodeId: context.pullRequestNodeId, reviewNodeId: created.id})
          : report(grant, 'closed');
        if (created) reviewNodeId = created.id;
      } else if (submit.state === 'submit-unknown') {
        const pending = context.pending.some(candidate => candidate.id === reviewNodeId);
        const recent = context.recent.find(candidate => candidate.id === reviewNodeId);
        resolved = report(grant,
          pending || recent?.state === 'PENDING' ? 'pending' : recent ? 'submitted' : 'closed');
      }
      return contextResponse(context, reviewNodeId, resolved);
    }

    if (step === 'start') {
      if (submit.state !== 'starting') throw upstreamFailure();
      let context;
      try {
        context = await readContext(grant, variables.number);
      } catch (error) {
        // The context query creates nothing, so the start step did not happen.
        report(grant, 'failed');
        throw error;
      }
      if (context.pending.some(candidate => candidate.ours)) {
        report(grant, 'failed');
        throw new GitServiceError(409, 'PENDING_REVIEW_EXISTS');
      }
      const outcome = await graphql(grant, 'addPullRequestReview', {
        pullRequestId: context.pullRequestNodeId, commitOid: variables.commitOid
      });
      if (outcome.kind === 'unknown') {
        report(grant, 'unknown');
        throw unknownError(outcome);
      }
      if (outcome.kind !== 'ok') {
        report(grant, 'failed');
        throw unsent(outcome, new GitServiceError(422, 'REVIEW_REJECTED'), pullNotFound());
      }
      let reviewNodeId;
      try {
        const created = object(object(outcome.data.addPullRequestReview).pullRequestReview);
        reviewNodeId = nodeId(created.id);
        if (created.state !== 'PENDING' || commitOid(created.commit) !== variables.commitOid ||
            nodeId(object(created.pullRequest).id) !== context.pullRequestNodeId) throw new ShapeError();
      } catch {
        report(grant, 'unknown');
        throw upstreamFailure();
      }
      report(grant, 'ok', {pullRequestNodeId: context.pullRequestNodeId, reviewNodeId});
      return {state: 'PENDING', commitOid: variables.commitOid};
    }

    const reviewNodeId = submit.reviewNodeId;
    const inFlight = {thread: 'threading', submit: 'submitting', delete: 'deleting'}[step];
    if (submit.state !== inFlight || !reviewNodeId) throw upstreamFailure();

    if (step === 'thread') {
      const outcome = await graphql(grant, 'addPullRequestReviewThread', {
        reviewId: reviewNodeId, path: variables.path, body: variables.body
      });
      if (outcome.kind === 'unknown') {
        report(grant, 'unknown');
        throw unknownError(outcome);
      }
      if (outcome.kind === 'not-found') {
        report(grant, 'gone');
        throw new GitServiceError(409, 'REVIEW_STEP_CONFLICT');
      }
      if (outcome.kind !== 'ok') {
        report(grant, 'failed');
        throw unsent(outcome, new GitServiceError(422, 'REVIEW_THREAD_REJECTED'), pullNotFound());
      }
      try {
        const thread = object(object(outcome.data.addPullRequestReviewThread).thread);
        nodeId(thread.id);
        if (thread.subjectType !== 'FILE' || thread.path !== variables.path) throw new ShapeError();
      } catch {
        report(grant, 'unknown');
        throw upstreamFailure();
      }
      return {threads: report(grant, 'ok').threads};
    }

    if (step === 'submit') {
      const outcome = await graphql(grant, 'submitPullRequestReview', {
        reviewId: reviewNodeId, event: variables.event, body: variables.body
      });
      if (outcome.kind === 'unknown') {
        report(grant, 'unknown');
        throw unknownError(outcome);
      }
      if (outcome.kind === 'not-found') {
        report(grant, 'gone');
        throw new GitServiceError(409, 'REVIEW_STEP_CONFLICT');
      }
      if (outcome.kind !== 'ok') {
        report(grant, 'failed');
        throw unsent(outcome, new GitServiceError(422, 'REVIEW_REJECTED'), pullNotFound());
      }
      let published;
      try {
        const value = object(object(outcome.data.submitPullRequestReview).pullRequestReview);
        const state = string(value.state);
        if (nodeId(value.id) !== reviewNodeId || state === 'PENDING') throw new ShapeError();
        published = {
          state, commitOid: string(commitOid(value.commit)), submittedAt: string(value.submittedAt), url: string(value.url)
        };
      } catch {
        report(grant, 'unknown');
        throw upstreamFailure();
      }
      report(grant, 'ok');
      return published;
    }

    const outcome = await graphql(grant, 'deletePullRequestReview', {reviewId: reviewNodeId});
    if (outcome.kind === 'unknown') {
      report(grant, 'unknown');
      throw unknownError(outcome);
    }
    if (outcome.kind === 'not-found') {
      report(grant, 'gone');
      return {deleted: true};
    }
    if (outcome.kind !== 'ok') {
      report(grant, 'failed');
      throw unsent(outcome, new GitServiceError(422, 'REVIEW_REJECTED'), pullNotFound());
    }
    try {
      const deleted = object(object(outcome.data.deletePullRequestReview).pullRequestReview);
      if (nodeId(deleted.id) !== reviewNodeId) throw new ShapeError();
    } catch {
      report(grant, 'unknown');
      throw upstreamFailure();
    }
    report(grant, 'ok');
    return {deleted: true};
  }

  try {
    const value = await run();
    if (!res.destroyed) respond(200, value);
  } catch (error) {
    if (res.destroyed || res.headersSent) return;
    if (error instanceof GitServiceError) return fail(error.status, error.code, error.retryAfter);
    return timeout.aborted ? fail(504, 'UPSTREAM_TIMEOUT') : fail(502, 'UPSTREAM_FAILURE');
  }
}

module.exports = {MAX_GITHUB_API_REQUEST_BYTES: MAX_REQUEST_BYTES, handleGitHubApi, isGitHubApiPath, parseGitHubApiFeatures};
