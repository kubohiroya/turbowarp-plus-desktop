const assert = require('node:assert/strict');
const {request: httpRequest} = require('node:http');
const {test} = require('node:test');
const {createGitHubAuth} = require('../src-main/local-git/github-auth');
const {EDITOR_ORIGIN, MAX_REQUEST_BYTES, parseRemote} = require('../src-main/local-git/git-proxy');
const {startDesktopGit} = require('../src-main/local-git/service');

const desktopRemote = 'https://github.com/owner/project.git';
const route = '/v1/git/owner/project.git';
const upload = '/info/refs?service=git-upload-pack';
const receive = '/git-receive-pack';
const readType = 'application/x-git-upload-pack-advertisement';
const writeType = 'application/x-git-receive-pack-request';

function tokens (suffix = 'one', expires = 3600) {
  return {access_token: 'ghu_' + suffix, refresh_token: 'ghr_' + suffix, expires_in: expires, refresh_token_expires_in: 7200};
}

function fixture (onGit = () => new Response('git-bytes', {headers: {'Content-Type': readType}})) {
  let time = 100_000;
  const waitTimes = [];
  const calls = [];
  const oauthResponses = [];
  const repositories = new Map([
    ['/repos/owner/project', {id: 1, full_name: 'owner/project', permissions: {pull: true, push: true}}],
    ['/repos/owner/renamed', {id: 1, full_name: 'owner/renamed', permissions: {pull: true, push: true}}],
    ['/repos/owner/other', {id: 2, full_name: 'owner/other', permissions: {pull: true, push: true}}],
    ['/repos/owner/readonly', {id: 3, full_name: 'owner/readonly', permissions: {pull: true, push: false}}]
  ]);
  return {
    calls, oauthResponses, waitTimes, repositories,
    now: () => time,
    advance: milliseconds => { time += milliseconds; },
    wait: async (milliseconds, _value, {signal}) => {
      signal.throwIfAborted();
      waitTimes.push(milliseconds);
      time += milliseconds;
    },
    request: async (url, options) => {
      options.signal.throwIfAborted();
      calls.push({url, options});
      const {pathname} = new URL(url);
      if (pathname === '/login/device/code') {
        assert.equal(options.body.get('scope'), 'offline_access');
        return Response.json({device_code: 'device_token', user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 1});
      }
      if (pathname === '/login/oauth/access_token') {
        assert.equal(options.body.has('client_secret'), false);
        return Response.json(oauthResponses.shift() ?? tokens());
      }
      if (pathname === '/user') return Response.json({login: 'fixture-user'});
      if (pathname.startsWith('/repos/')) {
        assert.match(options.headers.Authorization, /^Bearer ghu_/u);
        const repository = repositories.get(pathname);
        return repository ? Response.json(repository) : new Response(null, {status: 404});
      }
      return onGit(url, options);
    }
  };
}

test('device login exposes display fields and serializes token rotation', async () => {
  const upstream = fixture();
  const auth = createGitHubAuth('Iv1_test', upstream);
  upstream.oauthResponses.push({error: 'authorization_pending'}, {error: 'slow_down'}, tokens('one', 10), tokens('two'));
  assert.deepEqual(await auth.begin(), {userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: 160_000});
  assert.deepEqual(await auth.finish(), {account: {login: 'fixture-user'}, expiresAt: 118_000});
  assert.deepEqual(upstream.waitTimes, [1000, 1000, 6000]);
  upstream.advance(10_000);
  const refreshed = await Promise.all([auth.getCredentials(), auth.getCredentials()]);
  assert.deepEqual(refreshed.map(result => result.accessToken), ['ghu_two', 'ghu_two']);
  const refresh = upstream.calls.filter(call => call.options.body?.get('grant_type') === 'refresh_token');
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].options.body.get('refresh_token'), 'ghr_one');
  auth.disconnect();
  await assert.rejects(auth.getCredentials(), {code: 'REAUTH_REQUIRED'});
});

test('device polling cannot restore credentials after disconnect', async () => {
  const upstream = fixture();
  let resume;
  const auth = createGitHubAuth('Iv1_test', {...upstream, wait: () => new Promise(resolve => { resume = resolve; })});
  await auth.begin();
  const pending = auth.finish();
  auth.disconnect();
  resume();
  await assert.rejects(pending, {name: 'AbortError'});
  await assert.rejects(auth.getCredentials(), {code: 'REAUTH_REQUIRED'});
});

async function start (t, upstream) {
  const service = await startDesktopGit({clientId: 'Iv1_test', ...upstream});
  t.after(() => service.close());
  await service.begin();
  await service.finish();
  return service;
}

function call (service, session, path = route + upload, options = {}) {
  const headers = {Origin: EDITOR_ORIGIN, ...options.headers};
  if (session) headers.Authorization = 'Bearer ' + session.bearer;
  return fetch(service.connection.proxyOrigin + path, {...options, headers});
}

async function error (request, status, code) {
  const response = await request;
  assert.equal(response.status, status);
  assert.deepEqual(Object.keys(await response.clone().json()).sort(), ['code', 'requestId']);
  assert.equal((await response.json()).code, code);
}

test('loopback proxy checks origin, host, route, bearer, scope and body before contacting GitHub', async t => {
  let transmitted;
  const upstream = fixture(async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('x-access-token:ghu_one').toString('base64'));
    assert.deepEqual(Object.keys(options.headers).sort(), options.body
      ? ['Accept', 'Authorization', 'Content-Length', 'Content-Type'] : ['Accept', 'Authorization']);
    if (options.body) transmitted = new Uint8Array(await new Response(options.body).arrayBuffer());
    return new Response(new Uint8Array([0, 255, 64]), {headers: {
      'Content-Type': options.headers.Accept, 'Set-Cookie': 'upstream=private'
    }});
  });
  const service = await start(t, upstream);
  const session = await service.createSession(desktopRemote);
  assert.match(service.connection.proxyOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(session.bearer, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(Object.keys(session).sort(), ['account', 'bearer', 'connection', 'expiresAt']);
  const before = upstream.calls.length;
  const preflight = await call(service, null, route + upload, {method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization'
  }});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), EDITOR_ORIGIN);
  assert.match(preflight.headers.get('vary'), /Access-Control-Request-Headers/u);
  await error(call(service, session, route + upload, {headers: {Origin: 'null'}}), 403, 'FORBIDDEN');
  await error(call(service, session, route + upload, {headers: {Origin: 'https://editor.invalid'}}), 403, 'FORBIDDEN');
  await error(call(service, null), 401, 'SESSION_REQUIRED');
  await error(call(service, session, route + upload + '&url=https://evil.invalid'), 400, 'BAD_REQUEST');
  await error(call(service, session, '/v1/git/owner/%2e%2e.git' + upload), 400, 'BAD_REQUEST');
  await error(call(service, session, '/v1/git/owner/other.git' + upload), 403, 'FORBIDDEN');
  await error(call(service, session, route + '/info/refs?service=git-receive-pack'), 403, 'FORBIDDEN');
  const host = await new Promise((resolve, reject) => {
    httpRequest(service.connection.proxyOrigin + route + upload, {headers: {
      Host: 'rebinding.invalid', Origin: EDITOR_ORIGIN, Authorization: 'Bearer ' + session.bearer
    }}, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(host, 403);
  const post = {method: 'POST', headers: {'Content-Type': writeType}};
  await error(call(service, session, route + receive, {...post,
    body: new ReadableStream({start (controller) { controller.enqueue(Uint8Array.of(1)); controller.close(); }}),
    duplex: 'half'
  }), 411, 'LENGTH_REQUIRED');
  const oversized = await new Promise((resolve, reject) => {
    httpRequest(service.connection.proxyOrigin + route + receive, {method: 'POST', headers: {
      Origin: EDITOR_ORIGIN, Authorization: 'Bearer ' + session.bearer,
      'Content-Type': writeType, 'Content-Length': MAX_REQUEST_BYTES + 1
    }}, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(oversized, 413);
  assert.equal(upstream.calls.length, before);

  const read = await call(service, session, route + upload, {headers: {Cookie: 'local=secret', Referer: 'https://private.invalid'}});
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('set-cookie'), null);
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), Uint8Array.of(0, 255, 64));

  await assert.rejects(service.createSession('https://github.com/owner/readonly', true), {code: 'FORBIDDEN'});
  const write = await service.createSession(desktopRemote, true);
  await error(call(service, session), 401, 'SESSION_REQUIRED');
  const bytes = Uint8Array.of(4, 5, 6);
  const pushed = await call(service, write, route + receive, {...post, body: bytes});
  assert.equal(pushed.status, 200);
  await pushed.arrayBuffer();
  assert.deepEqual(transmitted, bytes);

  upstream.advance(5 * 60_000);
  assert.equal(service.getSession(), null);
  await error(call(service, write), 401, 'SESSION_EXPIRED');
  const latest = await service.createSession(desktopRemote);
  service.disconnect();
  await error(call(service, latest), 401, 'SESSION_REQUIRED');
});

test('only one discovery redirect may target the same repository ID and RPC is never replayed', async t => {
  let redirect = 'renamed';
  const upstream = fixture((url, options) => {
    if (url.includes('/project.git/')) return new Response(null, {status: 307, headers: {
      Location: redirect === 'external' ? 'https://evil.invalid/owner/renamed.git' + upload :
        'https://github.com/owner/' + redirect + '.git' + upload
    }});
    return new Response('advertisement', {headers: {'Content-Type': options.headers.Accept}});
  });
  const service = await start(t, upstream);
  let session = await service.createSession(desktopRemote, true);
  for (const target of ['other', 'external', 'project']) {
    redirect = target;
    await error(call(service, session), 409, 'REDIRECT_REJECTED');
  }
  const gitCalls = () => upstream.calls.filter(call => call.url.startsWith('https://github.com/owner/'));
  const firstPost = gitCalls().length;
  await error(call(service, session, route + receive, {method: 'POST', headers: {'Content-Type': writeType}, body: Uint8Array.of(1)}),
    409, 'REDIRECT_REJECTED');
  assert.equal(gitCalls().length, firstPost + 1);
  redirect = 'renamed';
  const good = await call(service, session);
  assert.equal(await good.text(), 'advertisement');
  const followup = await call(service, session);
  assert.equal(await followup.text(), 'advertisement');
  assert.equal(upstream.calls.at(-1).url, 'https://github.com/owner/renamed.git' + upload);
  assert.ok(upstream.calls.every(call => !call.url.includes('evil.invalid')));

  session = await service.createSession(desktopRemote, true);
  upstream.repositories.get('/repos/owner/renamed').id = 2;
  await error(call(service, session), 409, 'REDIRECT_REJECTED');
  const beforeChange = gitCalls().length;
  upstream.repositories.get('/repos/owner/project').id = 4;
  await error(call(service, session), 403, 'FORBIDDEN');
  assert.equal(gitCalls().length, beforeChange);
  assert.throws(() => parseRemote('https://github.com:443/owner/project.git'), {code: 'BAD_REQUEST'});
});
