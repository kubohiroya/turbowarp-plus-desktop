const {createServer} = require('node:http');
const {randomUUID} = require('node:crypto');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {GitServiceError} = require('./github-auth');
const {handleGitHubApi, isGitHubApiPath, parseGitHubApiFeatures} = require('./github-api');

const GITHUB = 'https://github.com';
const EDITOR_ORIGIN = 'tw-editor://.';
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const pushIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const names = '([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9_.-]+?)';
const gitPath = new RegExp('^/' + names +
  '\\.git(/info/refs\\?service=(git-upload-pack|git-receive-pack)|/(git-upload-pack|git-receive-pack))$', 'u');
const remotePattern = new RegExp('^https://github\\.com/' + names + '(?:\\.git)?$', 'u');

function validRepo (name) {
  return !['.', '..', '.git'].includes(name.toLowerCase());
}

function parseRemote (remote) {
  const match = typeof remote === 'string' && remotePattern.exec(remote);
  if (!match || match[0] !== remote || !validRepo(match[2])) throw new GitServiceError(400, 'BAD_REQUEST');
  return {owner: match[1], repo: match[2]};
}

function parseGitPath (path, method) {
  const match = gitPath.exec(path);
  if (!match || match[0] !== path || !validRepo(match[2])) return null;
  const [, owner, repo, suffix, discovery, rpc] = match;
  if ((discovery ? 'GET' : 'POST') !== method) return null;
  const service = discovery || rpc;
  return {owner, repo, suffix, service, write: service === 'git-receive-pack'};
}

function upstreamError (status) {
  if (status === 401) return new GitServiceError(401, 'REAUTH_REQUIRED');
  if (status === 403 || status === 404) return new GitServiceError(403, 'FORBIDDEN');
  if (status === 429) return new GitServiceError(429, 'RATE_LIMITED');
  if (status === 504) return new GitServiceError(504, 'UPSTREAM_TIMEOUT');
  return new GitServiceError(502, 'UPSTREAM_FAILURE');
}

async function startGitProxy ({
  authorize, resolveRedirect, authorizeGitHub, githubApi, now = Date.now, request = fetch, origin = EDITOR_ORIGIN,
  maxRequestBytes = MAX_REQUEST_BYTES
}) {
  let address;
  const github = {features: parseGitHubApiFeatures(githubApi), authorize: authorizeGitHub, request, now};
  function fail (res, status, code) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({code, requestId: randomUUID()}));
  }

  async function handle (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== address ||
        req.headersDistinct.host?.length !== 1 || req.headers.origin !== origin || req.headersDistinct.origin?.length !== 1) {
      return fail(res, 403, 'FORBIDDEN');
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (isGitHubApiPath(req.url)) return handleGitHubApi(req, res, github);
    const preflight = req.method === 'OPTIONS';
    const method = preflight ? req.headers['access-control-request-method'] : req.method;
    const route = req.url.startsWith('/v1/git/') && parseGitPath(req.url.slice('/v1/git'.length), method);
    if (!route) return fail(res, 400, 'BAD_REQUEST');
    const post = method === 'POST';
    const push = post && route.write;

    if (preflight) {
      res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      const allowed = post ? ['authorization', 'content-type'] : ['authorization'];
      if (push) allowed.push('git-push-id');
      const requested = (req.headers['access-control-request-headers'] || '').toLowerCase().split(',')
        .map(header => header.trim()).filter(Boolean);
      if (requested.some(header => !allowed.includes(header))) return fail(res, 403, 'FORBIDDEN');
      res.writeHead(204, {
        'Access-Control-Allow-Methods': method, 'Access-Control-Allow-Headers': allowed.join(', ')
      });
      return res.end();
    }

    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(req.headers.authorization ?? '');
    if (!bearer || req.headersDistinct.authorization?.length !== 1) return fail(res, 401, 'SESSION_REQUIRED');
    const length = req.headers['content-length'];
    const requestType = 'application/x-' + route.service + '-request';
    if (post) {
      if (req.headers['content-type'] !== requestType) return fail(res, 400, 'BAD_REQUEST');
      if (!/^[0-9]+$/u.test(length ?? '') || req.headers['transfer-encoding']) return fail(res, 411, 'LENGTH_REQUIRED');
      if (Number(length) > maxRequestBytes) return fail(res, 413, 'PAYLOAD_TOO_LARGE');
      if (Number(length) === 0) return fail(res, 400, 'BAD_REQUEST');
    } else if ((length !== undefined && length !== '0') || req.headers['transfer-encoding']) {
      return fail(res, 400, 'BAD_REQUEST');
    }
    const pushId = req.headers['git-push-id'];
    if (push ? !pushIdPattern.test(pushId ?? '') || req.headersDistinct['git-push-id']?.length !== 1 : pushId !== undefined) {
      return fail(res, 400, 'BAD_REQUEST');
    }

    const cancellation = new AbortController();
    const timeout = AbortSignal.timeout(120_000);
    res.once('close', () => { if (!res.writableFinished) cancellation.abort(); });
    const requestSignal = AbortSignal.any([cancellation.signal, timeout]);
    try {
      const {accessToken, repository, signal: sessionSignal} = await authorize(bearer[1], route, requestSignal, pushId);
      const signal = AbortSignal.any([requestSignal, sessionSignal]);
      signal.throwIfAborted();
      const type = 'application/x-' + route.service + (post ? '-result' : '-advertisement');
      const headers = {
        Authorization: 'Basic ' + Buffer.from('x-access-token:' + accessToken).toString('base64'),
        Accept: type
      };
      const options = {method, headers, signal, redirect: 'manual', cache: 'no-store'};
      if (post) {
        headers['Content-Type'] = requestType;
        headers['Content-Length'] = length;
        options.body = Readable.toWeb(req);
        options.duplex = 'half';
      }
      const upstream = repo => GITHUB + '/' + repo.owner + '/' + repo.repo + '.git' + route.suffix;
      let target = upstream(repository);
      let response = await request(target, options);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        let redirected;
        if (!post && location && (location.startsWith(GITHUB + '/') || /^\/(?!\/)/u.test(location))) {
          const rawPath = location.startsWith('/') ? location : location.slice(GITHUB.length);
          const candidate = parseGitPath(rawPath, 'GET');
          if (candidate?.service === route.service) {
            redirected = await resolveRedirect(repository, candidate, accessToken, signal);
          }
        }
        if (!redirected) throw new GitServiceError(409, 'REDIRECT_REJECTED');
        const next = upstream(redirected);
        if (next === target) throw new GitServiceError(409, 'REDIRECT_REJECTED');
        target = next;
        response = await request(target, options);
      }

      if (response.status !== 200 || !response.body || response.headers.get('content-type') !== type) {
        await response.body?.cancel().catch(() => {});
        if (response.status >= 300 && response.status < 400) throw new GitServiceError(409, 'REDIRECT_REJECTED');
        throw upstreamError(response.status);
      }
      res.writeHead(200, {'Content-Type': type});
      await pipeline(Readable.fromWeb(response.body), res, {signal});
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      if (error instanceof GitServiceError) return fail(res, error.status, error.code);
      return timeout.aborted ? fail(res, 504, 'UPSTREAM_TIMEOUT') : fail(res, 502, 'UPSTREAM_FAILURE');
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  address = '127.0.0.1:' + server.address().port;
  return {
    proxyOrigin: 'http://' + address,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}

module.exports = {EDITOR_ORIGIN, MAX_REQUEST_BYTES, parseRemote, startGitProxy};
