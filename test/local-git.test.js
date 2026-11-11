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
const pushId = '00000000-0000-4000-8000-000000000001';

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
        assert.match(options.headers.Authorization, /^Bearer (?:ghu_|github_pat_)/u);
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
  assert.deepEqual(await auth.finish(), {account: {login: 'fixture-user'}, expiresAt: 118_000, remembered: false});
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
  const post = {method: 'POST', headers: {'Content-Type': writeType, 'Git-Push-Id': pushId}};
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
  await error(call(service, write, route + receive, {method: 'POST', headers: {'Content-Type': writeType}, body: bytes}),
    400, 'BAD_REQUEST');
  await error(call(service, write, route + receive, {...post, headers: {...post.headers, 'Git-Push-Id': 'invalid'}, body: bytes}),
    400, 'BAD_REQUEST');
  await error(call(service, write, route + upload, {headers: {'Git-Push-Id': pushId}}), 400, 'BAD_REQUEST');
  const pushed = await call(service, write, route + receive, {...post, body: bytes});
  assert.equal(pushed.status, 200);
  await pushed.arrayBuffer();
  assert.deepEqual(transmitted, bytes);
  await error(call(service, write, route + receive, {...post, body: bytes}), 409, 'PUSH_DUPLICATE');

  upstream.advance(5 * 60_000);
  assert.equal(service.getSession(), null);
  await error(call(service, write), 401, 'SESSION_EXPIRED');
  const latest = await service.createSession(desktopRemote);
  service.disconnect();
  await error(call(service, latest), 401, 'SESSION_REQUIRED');
});

test('receive-pack reserves a push ID before egress and retains it after failure', {timeout: 10000}, async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const upstream = fixture(async (_url, options) => {
    assert.equal(options.headers['Git-Push-Id'], undefined);
    await new Response(options.body).arrayBuffer();
    entered.resolve();
    await release.promise;
    return new Response(null, {status: 502});
  });
  const service = await start(t, upstream);
  const session = await service.createSession(desktopRemote, true);
  const preflight = headers => call(service, null, route + receive, {method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': headers
  }});
  assert.equal((await preflight('authorization, content-type, git-push-id')).status, 204);
  await error(call(service, null, '/v1/git/owner/project.git/git-upload-pack', {method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'git-push-id'
  }}), 403, 'FORBIDDEN');
  const post = (id = pushId) => call(service, session, route + receive, {
    method: 'POST', headers: {'Content-Type': writeType, 'Git-Push-Id': id}, body: Uint8Array.of(1)
  });
  const first = post();
  try {
    await entered.promise;
    await error(post(), 409, 'PUSH_DUPLICATE');
  } finally {
    release.resolve();
  }
  await error(first, 502, 'UPSTREAM_FAILURE');
  await error(post(), 409, 'PUSH_DUPLICATE');
  const pushes = () => upstream.calls.filter(({url}) => url.endsWith(receive)).length;
  assert.equal(pushes(), 1);
  for (let index = 2; index <= 256; index++) {
    const id = '00000000-0000-4000-8000-' + String(index).padStart(12, '0');
    await error(post(id), 502, 'UPSTREAM_FAILURE');
  }
  await error(post('00000000-0000-4000-8000-000000000257'), 429, 'RATE_LIMITED');
  await error(post(), 409, 'PUSH_DUPLICATE');
  assert.equal(pushes(), 256);
  upstream.advance(5 * 60_000);
  await error(post(), 401, 'SESSION_EXPIRED');
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
  await error(call(service, session, route + receive, {
    method: 'POST', headers: {'Content-Type': writeType, 'Git-Push-Id': pushId}, body: Uint8Array.of(1)
  }),
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

test('protected credential records restore and rotate without persisting proxy sessions', async t => {
  const fs = require('node:fs/promises');
  const {tmpdir} = require('node:os');
  const path = require('node:path');
  const {createCipheriv, createDecipheriv, randomBytes} = require('node:crypto');
  const {createCredentialStore} = require('../src-main/local-git/credential-store');
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tw-credential-store-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const key = randomBytes(32);
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptStringAsync: async bytes => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return {result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')};
    }
  };
  const upstream = fixture();
  upstream.oauthResponses.push(tokens('one', 10), tokens('two'));
  const make = () => createCredentialStore({directory, clientId: 'Iv1_test', safeStorage, platform: 'darwin'});
  const first = await startDesktopGit({clientId: 'Iv1_test', ...upstream, store: make()});
  t.after(() => first.close());
  await first.begin(true);
  assert.equal((await first.finish()).remembered, true);
  const session = await first.createSession(desktopRemote);
  const dir = path.join(directory, 'local-git');
  const [file] = await fs.readdir(dir);
  const disk = await fs.readFile(path.join(dir, file));
  for (const secret of ['ghu_one', 'ghr_one', session.bearer]) assert.equal(disk.includes(secret), false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, file))).mode & 0o777, 0o600);
  await first.close();

  upstream.advance(10_000);
  const second = await startDesktopGit({clientId: 'Iv1_test', ...upstream, store: make()});
  t.after(() => second.close());
  assert.equal(await second.restore(), true);
  assert.equal(second.getState().account.login, 'fixture-user');
  assert.equal(second.getState().remembered, true);
  assert.notDeepEqual(await fs.readFile(path.join(dir, file)), disk);
  const record = await make().read(new AbortController().signal);
  assert.equal(record.accessToken, 'ghu_two');
  assert.equal(record.refreshToken, 'ghr_two');
  assert.deepEqual(Object.keys(record).sort(), ['accessToken', 'account', 'expiresAt', 'refreshExpiresAt', 'refreshToken']);
  assert.equal(second.getSession(), null);
  const renewed = await second.createSession(desktopRemote);
  assert.notEqual(renewed.bearer, session.bearer);
  await second.disconnect();
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(await second.restore(), false);
});

test('credential persistence refuses Linux plaintext storage', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const {tmpdir} = require('node:os');
  const {createCredentialStore} = require('../src-main/local-git/credential-store');
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tw-credential-store-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const store = createCredentialStore({directory, clientId: 'Iv1_test', platform: 'linux', safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: () => assert.fail('Plaintext provider must not encrypt credentials')
  }});
  const signal = new AbortController().signal;
  assert.equal(await store.write({accessToken: 'fixture'}, signal), false);
  assert.equal(await store.read(signal), null);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('Git preload handlers accept only the Plus Editor top frame', async () => {
  const {EventEmitter} = require('node:events');
  const {installEditorGit} = require('../src-main/local-git/editor-ipc');
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name, handler) => handlers.set(name, handler);
  const contents = new EventEmitter();
  contents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html?lang=ja'};
  installEditorGit(ipc, contents, {clientId: 'Iv1_test', store: {}});
  const accepted = {sender: contents, senderFrame: contents.mainFrame};
  const assertEnabled = (event, expected) => {
    for (const channel of ['local-git-enabled', 'local-git-auth-enabled']) {
      ipc.emit(channel, event);
      assert.equal(event.returnValue, expected);
    }
  };
  assertEnabled(accepted, true);
  assert.deepEqual(await handlers.get('local-git-state')(accepted), {status: 'disconnected'});
  assert.deepEqual(await handlers.get('local-git-auth-methods')(accepted), ['github-app']);
  await assert.rejects(handlers.get('local-git-connect-personal-access-token')(accepted, desktopRemote),
    {message: 'GIT_UNAVAILABLE'});
  const iframe = {sender: contents, senderFrame: {...contents.mainFrame}};
  const other = {sender: new EventEmitter(), senderFrame: contents.mainFrame};
  for (const event of [iframe, other]) {
    assertEnabled(event, false);
    await assert.rejects(handlers.get('local-git-state')(event), {message: 'GIT_UNAVAILABLE'});
    await assert.rejects(handlers.get('local-git-connect-personal-access-token')(event, desktopRemote),
      {message: 'GIT_UNAVAILABLE'});
  }
  contents.mainFrame.url = 'tw-editor://./plus-gui/addons.html';
  assertEnabled(accepted, false);
  await assert.rejects(handlers.get('local-git-state')(accepted), {message: 'GIT_UNAVAILABLE'});
});

test('token-only auth stays hidden from older Editors and cancellation releases the connection', async t => {
  const {EventEmitter} = require('node:events');
  const {installEditorGit} = require('../src-main/local-git/editor-ipc');
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name, handler) => handlers.set(name, handler);
  const contents = new EventEmitter();
  contents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  installEditorGit(ipc, contents, {promptPersonalToken: async () => null});
  const event = {sender: contents, senderFrame: contents.mainFrame};
  ipc.emit('local-git-enabled', event);
  assert.equal(event.returnValue, false);
  ipc.emit('local-git-auth-enabled', event);
  assert.equal(event.returnValue, true);
  assert.deepEqual(await handlers.get('local-git-auth-methods')(event), ['fine-grained-pat']);
  t.after(() => handlers.get('local-git-disconnect')(event));
  await assert.rejects(handlers.get('local-git-begin')(event), {message: 'GIT_UNAVAILABLE'});
  assert.equal(await handlers.get('local-git-connect-personal-access-token')(event, desktopRemote), null);
  assert.equal(await handlers.get('local-git-connection')(event), null);
});

test('fine-grained token uses the same repository and operation checks as Device Flow', async t => {
  const token = 'github_pat_fixture';
  let revoked = false;
  const upstream = fixture((url, options) => {
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('x-access-token:' + token).toString('base64'));
    assert.match(url, /^https:\/\/github\.com\/owner\/project\.git\//u);
    if (options.method === 'POST') {
      return new Response('git-result', {headers: {'Content-Type': 'application/x-git-receive-pack-result'}});
    }
    return new Response('git-bytes', {headers: {'Content-Type': readType}});
  });
  upstream.repositories.set('/repos/OWNER/Project', upstream.repositories.get('/repos/owner/project'));
  const service = await startDesktopGit({
    ...upstream,
    request: (url, options) => revoked && new URL(url).hostname === 'api.github.com'
      ? new Response(null, {status: 401}) : upstream.request(url, options),
    promptPersonalToken: async remote => {
      assert.deepEqual(remote, {owner: 'OWNER', repo: 'Project'});
      return token;
    }
  });
  t.after(() => service.close());
  await assert.rejects(service.begin(), {code: 'GIT_UNAVAILABLE'});
  assert.deepEqual(await service.connectPersonalAccessToken('https://github.com/OWNER/Project'), {
    status: 'connected', account: {login: 'fixture-user'}, remembered: false
  });
  assert.equal(upstream.calls[0].url, 'https://api.github.com/repos/OWNER/Project');
  assert.equal(upstream.calls[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(upstream.calls.some(call => call.url.includes(token)), false);

  const before = upstream.calls.length;
  await assert.rejects(service.createSession('https://github.com/owner/other'), {code: 'FORBIDDEN'});
  assert.equal(upstream.calls.length, before);

  const metadata = upstream.repositories.get('/repos/OWNER/Project');
  metadata.id = 2;
  await assert.rejects(service.createSession(desktopRemote), {code: 'FORBIDDEN'});
  metadata.id = 1;
  metadata.permissions.push = false;
  await assert.rejects(service.createSession(desktopRemote, true), {code: 'FORBIDDEN'});
  const read = await service.createSession(desktopRemote);
  assert.equal(read.expiresAt, upstream.now() + 300_000);
  assert.equal(JSON.stringify(read).includes(token), false);
  assert.equal(await (await call(service, read)).text(), 'git-bytes');

  const push = {method: 'POST', headers: {'Content-Type': writeType, 'Git-Push-Id': pushId}, body: 'git-pack'};
  await error(call(service, read, route + receive, push), 403, 'FORBIDDEN');
  metadata.permissions.push = true;
  const write = await service.createSession(desktopRemote, true);
  assert.equal(await (await call(service, write, route + receive, push)).text(), 'git-result');
  await error(call(service, write, route + receive, push), 409, 'PUSH_DUPLICATE');
  const gitCalls = () => upstream.calls.filter(call => call.url.startsWith('https://github.com/')).length;
  assert.equal(gitCalls(), 2);

  metadata.id = 2;
  await error(call(service, write), 403, 'FORBIDDEN');
  metadata.id = 1;
  revoked = true;
  await error(call(service, write), 401, 'REAUTH_REQUIRED');
  assert.deepEqual(service.getState(), {status: 'reauth-required'});
  assert.equal(service.getSession(), null);
  assert.equal(gitCalls(), 2);
  await service.disconnect();
  await error(call(service, write), 401, 'SESSION_REQUIRED');
});

test('token entry rejects invalid input and cannot complete after disconnect', async t => {
  const upstream = fixture();
  let token = 'ghp_classic';
  let resolvePrompt;
  const service = await startDesktopGit({
    ...upstream, promptPersonalToken: async () => token === undefined
      ? new Promise(resolve => { resolvePrompt = resolve; })
      : token
  });
  t.after(() => service.close());

  await assert.rejects(service.connectPersonalAccessToken(desktopRemote), {code: 'BAD_REQUEST'});
  token = null;
  assert.equal(await service.connectPersonalAccessToken(desktopRemote), null);
  assert.equal(upstream.calls.length, 0);

  token = 'github_pat_fixture';
  await assert.rejects(service.connectPersonalAccessToken('https://github.com/owner/unknown'), {code: 'FORBIDDEN'});
  assert.equal(service.getState().status, 'disconnected');
  assert.equal(upstream.calls.length, 1);

  token = undefined;
  const connecting = service.connectPersonalAccessToken(desktopRemote);
  assert.deepEqual(service.getState(), {status: 'connecting'});
  await assert.rejects(service.connectPersonalAccessToken(desktopRemote), {code: 'AUTH_IN_PROGRESS'});
  await service.disconnect();
  resolvePrompt('github_pat_fixture');
  await assert.rejects(connecting, {name: 'AbortError'});
  assert.equal(upstream.calls.length, 1);
  assert.equal(service.getState().status, 'disconnected');
});

test('saved token is revalidated before restore and removed on disconnect', async t => {
  const upstream = fixture();
  let record;
  let promptCount = 0;
  const store = {
    read: async () => record,
    write: async value => { record = value; return true; },
    clear: async () => { record = undefined; }
  };
  const make = () => startDesktopGit({
    ...upstream, store, promptPersonalToken: async () => {
      promptCount++;
      return 'github_pat_fixture';
    }
  });
  const first = await make();
  t.after(() => first.close());
  assert.equal((await first.connectPersonalAccessToken(desktopRemote, true)).remembered, true);
  assert.equal(record.repository.id, 1);
  await first.close();

  const second = await make();
  t.after(() => second.close());
  const metadata = upstream.repositories.get('/repos/owner/project');
  metadata.id = 2;
  await assert.rejects(second.restore(), {code: 'FORBIDDEN'});
  assert.equal(second.getState().status, 'disconnected');
  metadata.id = 1;
  assert.equal(await second.restore(), true);
  assert.equal(second.getState().remembered, true);
  assert.equal(promptCount, 1);
  assert.equal(second.getSession(), null);
  await second.disconnect();
  assert.equal(record, undefined);
  assert.equal(await second.restore(), false);
});

test('native token prompt captures private input and filters helper failures', async () => {
  const {createPersonalTokenPrompt} = require('../src-main/local-git/personal-token-prompt');
  const remote = {owner: 'owner', repo: 'project'};
  const signal = new AbortController().signal;
  assert.equal(createPersonalTokenPrompt({platform: 'linux', exists: () => false}), undefined);
  const prompt = createPersonalTokenPrompt({
    platform: 'linux', exists: file => file === '/usr/bin/zenity',
    execute: async (file, args, options) => {
      assert.equal(file, '/usr/bin/zenity');
      assert.ok(args.includes('--hide-text'));
      assert.match(args.at(-1), /owner\/project/u);
      assert.equal(options.signal, signal);
      return {stdout: 'github_pat_fixture\n'};
    }
  });
  assert.equal(await prompt(remote, signal), 'github_pat_fixture');

  const failed = createPersonalTokenPrompt({
    platform: 'darwin', exists: () => true,
    execute: async () => { throw Object.assign(new Error('github_pat_fixture'), {code: 1, stderr: 'internal error'}); }
  });
  await assert.rejects(failed(remote, signal), {message: 'TOKEN_PROMPT_FAILED'});
  const cancelled = createPersonalTokenPrompt({
    platform: 'darwin', exists: () => true,
    execute: async () => { throw Object.assign(new Error('helper error'), {code: 1, stderr: 'User canceled. (-128)\n'}); }
  });
  assert.equal(await cancelled(remote, signal), null);
});
