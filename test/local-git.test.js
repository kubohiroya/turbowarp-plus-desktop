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

function fixture (onGit = () => new Response('git-bytes', {headers: {'Content-Type': readType}}), onApi = null) {
  let time = 100_000;
  const waitTimes = [];
  const calls = [];
  const oauthResponses = [];
  const lookups = [];
  const repositories = new Map([
    ['/repos/owner/project', {id: 1, full_name: 'owner/project', permissions: {pull: true, push: true}}],
    ['/repos/owner/renamed', {id: 1, full_name: 'owner/renamed', permissions: {pull: true, push: true}}],
    ['/repos/owner/other', {id: 2, full_name: 'owner/other', permissions: {pull: true, push: true}}],
    ['/repos/owner/readonly', {id: 3, full_name: 'owner/readonly', permissions: {pull: true, push: false}}]
  ]);
  return {
    calls, oauthResponses, waitTimes, repositories, lookups,
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
      if (onApi && (pathname === '/graphql' || /^\/repos\/[^/]+\/[^/]+\/pulls(?:\/|$)/u.test(pathname))) {
        return onApi(url, options);
      }
      if (pathname.startsWith('/repos/')) {
        if (lookups.length) return lookups.shift()();
        assert.match(options.headers.Authorization, /^Bearer (?:gh[ou]_|github_pat_)/u);
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
    await assert.rejects(handlers.get('local-git-connect-git-credential')(event, desktopRemote, 'fixture-user'),
      {message: 'GIT_UNAVAILABLE'});
  }
  contents.mainFrame.url = 'tw-editor://./plus-gui/addons.html';
  assertEnabled(accepted, false);
  await assert.rejects(handlers.get('local-git-state')(accepted), {message: 'GIT_UNAVAILABLE'});
});

// GitHub API routes (/v1/github/<owner>/<repo>/...). The stub below stands in for api.github.com: the pull request,
// the viewer's pending review and published reviews, and every mutation it applied.

const {githubReviewDocuments} = require('../src-main/local-git/github-review-documents');
const reviewRecords = require('../src-main/local-git/review-submits');

const apiRoot = '/v1/github/owner/project';
const allGroups = 'pulls-read,review-threads,reviews-body';
const head = 'a'.repeat(40);
const submitId = (index = 1) => '00000000-0000-4000-8000-' + String(index).padStart(12, '0');
const projectFile = 'game/project.source.json';

function gitHubStub () {
  const stub = {
    calls: [], mutations: [], faults: [], pending: null, reviews: [], nextId: 1, repositoryId: 1, viewer: 'reviewer',
    graphqlHeaders: {}
  };
  const json = (value, headers = {}) => Response.json(value, {headers});
  const take = operation => {
    const index = stub.faults.findIndex(fault => fault.operation === operation);
    return index < 0 ? null : stub.faults.splice(index, 1)[0];
  };
  const user = {login: 'author', id: 9, node_id: 'U_author'};
  const pullSummary = number => ({
    number, title: 'Title ' + number, state: 'open', draft: false, merged_at: null, updated_at: '2026-11-11T00:00:00Z',
    user, node_id: 'PR_node', head: {sha: head, ref: 'feature', label: 'x', repo: {full_name: 'owner/project'}},
    base: {sha: 'b'.repeat(40), ref: 'main', repo: {full_name: 'owner/project'}}, _links: {}
  });
  const restReview = review => ({
    id: review.databaseId, node_id: review.id, user: {login: stub.viewer, node_id: 'U_viewer'}, commit_id: review.commitOid,
    state: review.state, submitted_at: review.submittedAt, body: review.body, html_url: review.url
  });

  function graphql (operation, variables) {
    const pull = stub.pending;
    switch (operation) {
      case 'pullRequestReviewContext':
        assert.deepEqual(Object.keys(variables).sort(), ['name', 'number', 'owner']);
        return {data: {viewer: {login: stub.viewer}, repository: {
          databaseId: stub.repositoryId,
          pullRequest: variables.number !== 7 ? null : {
            id: 'PR_node', headRefOid: head,
            pending: {nodes: pull ? [{id: pull.id, viewerDidAuthor: true, createdAt: '2026-11-11T00:00:00Z', body: pull.body,
              commit: {oid: pull.commitOid}, comments: {totalCount: pull.threads.length}}] : []},
            recent: {nodes: stub.reviews.map(review => ({id: review.id, viewerDidAuthor: true, state: review.state,
              submittedAt: review.submittedAt, commit: {oid: review.commitOid}}))}
          }
        }}};
      case 'addPullRequestReview': {
        assert.deepEqual(variables, {pullRequestId: 'PR_node', commitOid: variables.commitOid});
        stub.pending = {id: 'PRR_' + stub.nextId++, commitOid: variables.commitOid, body: '', threads: []};
        return {data: {addPullRequestReview: {pullRequestReview: {id: stub.pending.id, state: 'PENDING',
          commit: {oid: variables.commitOid}, pullRequest: {id: 'PR_node'}}}}};
      }
      case 'addPullRequestReviewThread':
        if (!pull || pull.id !== variables.reviewId) return {data: null, errors: [{type: 'NOT_FOUND', message: 'secret'}]};
        pull.threads.push(variables.path);
        return {data: {addPullRequestReviewThread: {thread: {id: 'PRRT_' + stub.nextId++, path: variables.path,
          subjectType: 'FILE'}}}};
      case 'submitPullRequestReview': {
        if (!pull || pull.id !== variables.reviewId) return {data: null, errors: [{type: 'NOT_FOUND'}]};
        const state = {COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED'}[variables.event];
        const review = {...pull, state, body: variables.body, submittedAt: '2026-11-11T01:00:00Z', databaseId: stub.nextId++,
          url: 'https://github.com/owner/project/pull/7#pullrequestreview-' + stub.nextId};
        stub.reviews.push(review);
        stub.pending = null;
        return {data: {submitPullRequestReview: {pullRequestReview: {id: review.id, state, submittedAt: review.submittedAt,
          url: review.url, commit: {oid: review.commitOid}}}}};
      }
      case 'deletePullRequestReview':
        if (!pull || pull.id !== variables.reviewId) return {data: null, errors: [{type: 'NOT_FOUND'}]};
        stub.pending = null;
        return {data: {deletePullRequestReview: {pullRequestReview: {id: pull.id}}}};
    }
    assert.fail('Unexpected GraphQL operation');
  }

  stub.handle = async (url, options) => {
    const {search} = new URL(url);
    // GitHub matches names without regard to case.
    const pathname = new URL(url).pathname.toLowerCase();
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    const operation = pathname === '/graphql'
      ? Object.keys(githubReviewDocuments).find(name => githubReviewDocuments[name] === body.query)
      : options.method === 'POST' ? 'createReview' : 'rest';
    assert.ok(operation, 'Only the fixed GraphQL documents reach GitHub');
    stub.calls.push({url, operation, headers: options.headers, body, redirect: options.redirect});
    const fault = take(operation);
    if (fault?.entered) fault.entered.resolve();
    if (fault?.gate) await fault.gate;
    if (operation !== 'pullRequestReviewContext' && operation !== 'rest' && (!fault || fault.apply)) {
      stub.mutations.push(operation);
    }
    let result;
    if (!fault || fault.apply) {
      if (pathname === '/graphql') result = json(graphql(operation, body.variables), stub.graphqlHeaders);
      else if (pathname === '/repos/owner/project/pulls') {
        assert.match(search, /^\?state=all&sort=updated&direction=desc&per_page=20&page=[0-9]+$/u);
        result = json([pullSummary(7), pullSummary(8)], {'Set-Cookie': 'upstream=1', 'x-ratelimit-remaining': '4999'});
      } else if (pathname === '/repos/owner/project/pulls/7' && !search) {
        result = json({...pullSummary(7), body: 'markdown', body_text: 'plain', changed_files: 3,
          head: {sha: head, ref: 'feature', repo: null}, merge_commit_sha: 'x'});
      } else if (pathname === '/repos/owner/project/pulls/7/reviews' && options.method === 'POST') {
        const review = {id: 'PRR_' + stub.nextId, databaseId: stub.nextId++, commitOid: body.commit_id, body: body.body ?? '',
          state: {COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED'}[body.event],
          submittedAt: '2026-11-11T01:00:00Z', url: 'https://github.com/owner/project/pull/7#pullrequestreview-1'};
        stub.reviews.push(review);
        result = json(restReview(review));
      } else if (pathname === '/repos/owner/project/pulls/7/reviews') {
        assert.match(search, /^\?per_page=30&page=[0-9]+$/u);
        result = json(stub.reviews.map(restReview));
      } else {
        result = new Response(null, {status: 404});
      }
    }
    if (fault?.response) {
      await result?.body?.cancel();
      return fault.response();
    }
    return result;
  };
  return stub;
}

async function startApi (t, {githubApi = allGroups, review = true, onGit} = {}) {
  const github = gitHubStub();
  const upstream = fixture(onGit, github.handle);
  const service = await startDesktopGit({clientId: 'Iv1_test', ...upstream, githubApi});
  t.after(() => service.close());
  await service.begin();
  await service.finish();
  const session = await service.createSession(desktopRemote, false, review);
  const api = (path, options = {}) => call(service, options.session === undefined ? session : options.session,
    apiRoot + path, options);
  const graphql = (operation, variables, id, options = {}) => {
    const body = JSON.stringify(variables);
    return api('/graphql/' + operation, {...options, method: 'POST', body, headers: {
      'Content-Type': 'application/json', ...(id && {'Review-Submit-Id': id}), ...options.headers
    }});
  };
  const createReview = (value, id = submitId(1), options = {}) => api('/pulls/7/reviews', {...options, method: 'POST',
    body: JSON.stringify(value), headers: {'Content-Type': 'application/json', 'Review-Submit-Id': id, ...options.headers}});
  const apiCalls = () => github.calls.length;
  return {github, upstream, service, session, api, graphql, createReview, apiCalls};
}

async function ok (request) {
  const response = await request;
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), EDITOR_ORIGIN);
  for (const secret of ['ghu_', 'PR_node', 'PRR_', 'PRRT_', 'U_author', 'node_id']) assert.equal(text.includes(secret), false);
  return JSON.parse(text);
}

async function errorWith (request, status, code, retryAfter) {
  const response = await request;
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  assert.equal(value.code, code);
  assert.deepEqual(Object.keys(value).sort(), retryAfter === undefined ? ['code', 'requestId'] : ['code', 'requestId', 'retryAfter']);
  if (retryAfter !== undefined) assert.equal(value.retryAfter, retryAfter);
}

const settleRequests = () => new Promise(resolve => setTimeout(resolve, 50));

test('GitHub API routes are off by default and fail closed on an unknown group', async t => {
  for (const [githubApi, status, code] of [[null, 404, 'GITHUB_API_UNAVAILABLE'], ['', 404, 'GITHUB_API_UNAVAILABLE'],
    ['pulls-read,pulls-write', 500, 'GITHUB_API_MISCONFIGURED'], ['pulls-read,pulls-read', 500, 'GITHUB_API_MISCONFIGURED']]) {
    const {api, graphql, apiCalls, upstream} = await startApi(t, {githubApi});
    const lookups = upstream.calls.length;
    await errorWith(api('/pulls'), status, code);
    await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId()), status, code);
    await errorWith(api('/anything'), status, code);
    assert.equal(apiCalls(), 0);
    assert.equal(upstream.calls.length, lookups);
  }
});

test('GitHub API routes reject other methods, paths, queries and bodies before contacting GitHub', async t => {
  const {api, graphql, createReview, apiCalls, upstream, service, session} = await startApi(t);
  const lookups = upstream.calls.length;
  const bad = [
    api('/pulls', {method: 'DELETE'}), api('/pulls?page=0'), api('/pulls?page=51'), api('/pulls?page=1&page=2'),
    api('/pulls?page=01'), api('/pulls?state=open'), api('/pulls/7?page=1'), api('/pulls/07'), api('/pulls/2147483648'),
    api('/pulls/7/reviews?page=11'), api('/pulls/7/files'), api('/issues'), api('/graphql/pullRequestReviewContext'),
    call(service, session, '/v1/github/owner/project.git/pulls'), call(service, session, '/v1/github/owner/%2e%2e/pulls'),
    graphql('deleteRepository', {number: 7}, submitId()),
    graphql('pullRequestReviewContext', {number: 7, query: '{ viewer { login } }'}),
    graphql('pullRequestReviewContext', {number: '7'}),
    graphql('pullRequestReviewContext', {number: 7, pullRequestId: 'PR_node'}),
    graphql('addPullRequestReview', {number: 7, commitOid: head.toUpperCase()}, submitId()),
    graphql('addPullRequestReview', {number: 7, commitOid: head}),
    graphql('addPullRequestReview', {number: 7, commitOid: head}, 'not-a-uuid'),
    graphql('addPullRequestReviewThread', {number: 7, threadIndex: 50, path: projectFile, body: 'x'}, submitId()),
    graphql('addPullRequestReviewThread', {number: 7, threadIndex: 0, path: 'game/sprite.json', body: 'x'}, submitId()),
    graphql('addPullRequestReviewThread', {number: 7, threadIndex: 0, path: '../project.source.json', body: 'x'}, submitId()),
    graphql('addPullRequestReviewThread', {number: 7, threadIndex: 0, path: '/project.source.json', body: 'x'}, submitId()),
    graphql('addPullRequestReviewThread', {number: 7, threadIndex: 0, path: projectFile, body: ''}, submitId()),
    graphql('addPullRequestReviewThread', {number: 7, threadIndex: 0, path: projectFile, body: 'x'.repeat(65_537)},
      submitId()),
    graphql('submitPullRequestReview', {number: 7, threadCount: 0, event: 'COMMENT', body: ''}, submitId()),
    graphql('submitPullRequestReview', {number: 7, threadCount: 1, event: 'DISMISS', body: 'x'}, submitId()),
    graphql('submitPullRequestReview', {number: 7, threadCount: 1, event: 'REQUEST_CHANGES', body: ''}, submitId()),
    graphql('deletePullRequestReview', {number: 7, reviewId: 'PRR_1'}, submitId()),
    api('/graphql/pullRequestReviewContext', {method: 'POST', body: '[7]', headers: {'Content-Type': 'application/json'}}),
    api('/graphql/pullRequestReviewContext', {method: 'POST', body: '{"number":7}', headers: {'Content-Type': 'text/plain'}}),
    api('/pulls', {headers: {'Review-Submit-Id': submitId()}}),
    createReview({commit_id: head, event: 'COMMENT', body: 'x', comments: []}),
    createReview({commit_id: head, event: 'COMMENT'}),
    createReview({commit_id: head, event: '', body: 'x'}),
    api('/pulls/7/reviews', {method: 'POST', body: JSON.stringify({commit_id: head, event: 'APPROVE'}),
      headers: {'Content-Type': 'application/json'}})
  ];
  for (const [index, response] of bad.entries()) {
    await errorWith(response, 400, 'BAD_REQUEST').catch(error => assert.fail('Request ' + index + ': ' + error.message));
  }
  const length = await new Promise((resolve, reject) => {
    httpRequest(service.connection.proxyOrigin + apiRoot + '/graphql/pullRequestReviewContext', {method: 'POST', headers: {
      Origin: EDITOR_ORIGIN, Authorization: 'Bearer ' + session.bearer, 'Content-Type': 'application/json',
      'Content-Length': 256 * 1024 + 1
    }}, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(length, 413);
  await errorWith(api('/graphql/pullRequestReviewContext', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: new ReadableStream({start (controller) {
      controller.enqueue(new TextEncoder().encode('{"number":7}'));
      controller.close();
    }}), duplex: 'half'}), 411, 'LENGTH_REQUIRED');

  const preflight = (path, method, headers) => call(service, null, apiRoot + path, {method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers
  }});
  const allowed = await preflight('/graphql/addPullRequestReview', 'POST', 'authorization, content-type, review-submit-id');
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-headers'), 'authorization, content-type, review-submit-id');
  assert.equal((await preflight('/pulls', 'GET', 'authorization')).status, 204);
  await errorWith(preflight('/pulls', 'GET', 'authorization, review-submit-id'), 403, 'FORBIDDEN');
  await errorWith(preflight('/pulls', 'POST', 'authorization'), 400, 'BAD_REQUEST');
  await errorWith(preflight('/graphql/addPullRequestReview', 'POST', 'authorization, cookie'), 403, 'FORBIDDEN');
  assert.equal(apiCalls(), 0);
  assert.equal(upstream.calls.length, lookups);
});

test('GitHub API routes check origin, host, bearer, session, repository and the review grant', async t => {
  const {api, graphql, createReview, apiCalls, upstream, service, session} = await startApi(t, {review: false});
  await errorWith(api('/pulls', {headers: {Origin: 'https://editor.invalid'}}), 403, 'FORBIDDEN');
  await errorWith(api('/pulls', {headers: {Origin: 'null'}}), 403, 'FORBIDDEN');
  await errorWith(api('/pulls', {session: null}), 401, 'SESSION_REQUIRED');
  await errorWith(api('/pulls', {session: null, headers: {Authorization: 'Bearer ' + 'x'.repeat(43)}}), 401, 'SESSION_REQUIRED');
  const host = await new Promise((resolve, reject) => {
    httpRequest(service.connection.proxyOrigin + apiRoot + '/pulls', {headers: {
      Host: 'rebinding.invalid', Origin: EDITOR_ORIGIN, Authorization: 'Bearer ' + session.bearer
    }}, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(host, 403);
  await errorWith(call(service, session, '/v1/github/owner/other/pulls'), 403, 'FORBIDDEN');
  // A session without the review grant reads but cannot send.
  await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId()), 403, 'FORBIDDEN');
  await errorWith(graphql('deletePullRequestReview', {number: 7}, submitId()), 403, 'FORBIDDEN');
  await errorWith(createReview({commit_id: head, event: 'COMMENT', body: 'x'}), 403, 'FORBIDDEN');
  assert.equal(apiCalls(), 0);
  await ok(graphql('pullRequestReviewContext', {number: 7}));
  await ok(api('/pulls'));
  assert.equal(apiCalls(), 2);

  // Another repository ID behind the same name, expiry and disconnect stop requests before GitHub.
  upstream.repositories.get('/repos/owner/project').id = 4;
  await errorWith(api('/pulls'), 403, 'FORBIDDEN');
  upstream.repositories.get('/repos/owner/project').id = 1;
  await assert.rejects(service.createSession(desktopRemote, false, 'yes'), {code: 'BAD_REQUEST'});
  upstream.advance(5 * 60_000);
  await errorWith(api('/pulls'), 401, 'SESSION_EXPIRED');
  const latest = await service.createSession(desktopRemote, false, true);
  await service.disconnect();
  await errorWith(call(service, latest, apiRoot + '/pulls'), 401, 'SESSION_REQUIRED');
  assert.equal(apiCalls(), 2);
});

test('GitHub API reads send only the GitHub credential to canonical URLs and return the contracted fields', async t => {
  const {api, graphql, github, upstream} = await startApi(t);
  upstream.repositories.get('/repos/owner/project').full_name = 'Owner/Project';
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, method, (...args) => logged.push(args));
  const list = await ok(api('/pulls?page=2', {headers: {Cookie: 'local=1', Referer: 'https://private.invalid'}}));
  assert.deepEqual(list[0], {number: 7, title: 'Title 7', state: 'open', draft: false, merged_at: null,
    updated_at: '2026-11-11T00:00:00Z', user: {login: 'author'}, head: {sha: head, ref: 'feature'},
    base: {sha: 'b'.repeat(40), ref: 'main'}});
  const listCall = github.calls.at(-1);
  assert.equal(listCall.url,
    'https://api.github.com/repos/Owner/Project/pulls?state=all&sort=updated&direction=desc&per_page=20&page=2');
  assert.deepEqual(listCall.headers, {Authorization: 'Bearer ghu_one', Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TurboWarp-Plus-Desktop-Git'});
  assert.equal(listCall.redirect, 'manual');

  upstream.repositories.get('/repos/owner/project').full_name = 'owner/project';
  const pull = await ok(api('/pulls/7'));
  assert.deepEqual(pull, {number: 7, title: 'Title 7', state: 'open', draft: false, merged_at: null, user: {login: 'author'},
    body: 'markdown', body_text: 'plain', changed_files: 3, head: {sha: head, ref: 'feature', repo: null},
    base: {sha: 'b'.repeat(40), ref: 'main', repo: {full_name: 'owner/project'}}});
  assert.equal(github.calls.at(-1).headers.Accept, 'application/vnd.github.text+json');
  await errorWith(api('/pulls/8'), 404, 'PULL_REQUEST_NOT_FOUND');
  assert.deepEqual(await ok(api('/pulls/7/reviews')), []);

  const context = await ok(graphql('pullRequestReviewContext', {number: 7}));
  assert.deepEqual(context, {headRefOid: head, viewer: 'reviewer', pendingReview: null, reviews: []});
  const contextCall = github.calls.at(-1);
  assert.equal(contextCall.url, 'https://api.github.com/graphql');
  assert.deepEqual(contextCall.body.variables, {owner: 'owner', name: 'project', number: 7});
  assert.deepEqual(Object.keys(contextCall.headers).sort(), ['Accept', 'Authorization', 'Content-Type', 'User-Agent']);
  await errorWith(graphql('pullRequestReviewContext', {number: 8}), 404, 'PULL_REQUEST_NOT_FOUND');

  // Over-limit, non-JSON and mis-shaped upstream bodies, redirects and list 404s.
  github.faults.push({operation: 'rest', response: () => new Response('x'.repeat(1024 * 1024 + 1),
    {headers: {'Content-Type': 'application/json'}})});
  await errorWith(api('/pulls'), 502, 'UPSTREAM_FAILURE');
  github.faults.push({operation: 'rest', response: () => new Response('<html>', {headers: {'Content-Type': 'text/html'}})});
  await errorWith(api('/pulls/7'), 502, 'UPSTREAM_FAILURE');
  github.faults.push({operation: 'rest', response: () => Response.json([{number: '7'}])});
  await errorWith(api('/pulls'), 502, 'UPSTREAM_FAILURE');
  github.faults.push({operation: 'rest', response: () => new Response(null, {status: 404})});
  await errorWith(api('/pulls'), 403, 'FORBIDDEN');
  github.faults.push({operation: 'rest', response: () => new Response(null, {status: 302,
    headers: {Location: 'https://evil.invalid/repos/owner/project/pulls'}})});
  await errorWith(api('/pulls'), 409, 'REDIRECT_REJECTED');
  github.faults.push({operation: 'pullRequestReviewContext', response: () => new Response(null, {status: 301,
    headers: {Location: 'https://evil.invalid/graphql'}})});
  await errorWith(graphql('pullRequestReviewContext', {number: 7}), 409, 'REDIRECT_REJECTED');
  assert.equal(github.calls.filter(call => call.url.includes('evil.invalid')).length, 0);
  assert.ok(upstream.calls.every(call => !call.url.includes('ghu_')));
  assert.deepEqual(logged, []);
});

test('a review goes out in steps under one Review-Submit-Id and rejects other step orders', async t => {
  const {graphql, github} = await startApi(t);
  const id = submitId(1);
  const thread = (index, options) => graphql('addPullRequestReviewThread',
    {number: 7, threadIndex: index, path: projectFile, body: 'Comment ' + index}, id, options);
  await errorWith(thread(0), 409, 'REVIEW_STEP_CONFLICT');
  assert.deepEqual(await ok(graphql('addPullRequestReview', {number: 7, commitOid: head}, id)),
    {state: 'PENDING', commitOid: head});
  await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, id), 409, 'REVIEW_DUPLICATE');
  await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(2)), 409, 'REVIEW_STEP_CONFLICT');
  await errorWith(thread(1), 409, 'REVIEW_STEP_CONFLICT');
  assert.deepEqual(await ok(thread(0)), {threads: 1});
  await errorWith(thread(0), 409, 'REVIEW_DUPLICATE');
  assert.deepEqual(await ok(thread(1)), {threads: 2});
  await errorWith(graphql('addPullRequestReviewThread', {number: 8, threadIndex: 2, path: projectFile, body: 'x'}, id),
    409, 'REVIEW_STEP_CONFLICT');
  await errorWith(graphql('submitPullRequestReview', {number: 7, threadCount: 1, event: 'COMMENT', body: ''}, id),
    409, 'REVIEW_STEP_CONFLICT');
  await errorWith(graphql('submitPullRequestReview', {number: 7, threadCount: 2, event: 'COMMENT', body: ''}, submitId(3)),
    409, 'REVIEW_STEP_CONFLICT');
  const context = await ok(graphql('pullRequestReviewContext', {number: 7}, id));
  assert.deepEqual(context.pendingReview, {ours: true, commitOid: head, createdAt: '2026-11-11T00:00:00Z'});
  assert.deepEqual(context.submit, {state: 'pending', threads: 2});
  const published = await ok(graphql('submitPullRequestReview', {number: 7, threadCount: 2, event: 'APPROVE', body: 'Good'}, id));
  assert.equal(published.state, 'APPROVED');
  assert.equal(published.commitOid, head);
  assert.match(published.url, /^https:\/\/github\.com\/owner\/project\/pull\/7#pullrequestreview-/u);
  assert.deepEqual(Object.keys(published).sort(), ['commitOid', 'state', 'submittedAt', 'url']);
  await errorWith(graphql('submitPullRequestReview', {number: 7, threadCount: 2, event: 'APPROVE', body: 'Good'}, id),
    409, 'REVIEW_DUPLICATE');
  await errorWith(graphql('deletePullRequestReview', {number: 7}, id), 409, 'REVIEW_STEP_CONFLICT');
  const after = await ok(graphql('pullRequestReviewContext', {number: 7}, id));
  assert.deepEqual(after.submit, {state: 'submitted', threads: 2});
  assert.deepEqual(after.reviews, [{state: 'APPROVED', commitOid: head, submittedAt: '2026-11-11T01:00:00Z', ours: true}]);
  assert.deepEqual(github.mutations, ['addPullRequestReview', 'addPullRequestReviewThread', 'addPullRequestReviewThread',
    'submitPullRequestReview']);
  const variables = github.calls.filter(call => call.operation !== 'pullRequestReviewContext').map(call => call.body.variables);
  assert.deepEqual(variables, [
    {pullRequestId: 'PR_node', commitOid: head},
    {reviewId: 'PRR_1', path: projectFile, body: 'Comment 0'},
    {reviewId: 'PRR_1', path: projectFile, body: 'Comment 1'},
    {reviewId: 'PRR_1', event: 'APPROVE', body: 'Good'}
  ]);

  // A later submission can start, and a pending review can be discarded only while it is pending.
  const next = submitId(4);
  await ok(graphql('addPullRequestReview', {number: 7, commitOid: head}, next));
  assert.deepEqual(await ok(graphql('deletePullRequestReview', {number: 7}, next)), {deleted: true});
  await errorWith(graphql('deletePullRequestReview', {number: 7}, next), 409, 'REVIEW_DUPLICATE');
  assert.equal(github.pending, null);
});

test('the same step arriving twice at once reaches GitHub once', {timeout: 10_000}, async t => {
  const {graphql, github} = await startApi(t);
  const id = submitId(1);
  const steps = [
    ['addPullRequestReview', {number: 7, commitOid: head}],
    ['addPullRequestReviewThread', {number: 7, threadIndex: 0, path: projectFile, body: 'x'}],
    ['submitPullRequestReview', {number: 7, threadCount: 1, event: 'COMMENT', body: ''}]
  ];
  for (const [operation, variables] of steps) {
    const entered = Promise.withResolvers();
    const gate = Promise.withResolvers();
    github.faults.push({operation, apply: true, entered, gate: gate.promise});
    const first = graphql(operation, variables, id);
    await entered.promise;
    await errorWith(graphql(operation, variables, id), 409, 'REVIEW_DUPLICATE');
    gate.resolve();
    await ok(first);
  }
  assert.deepEqual(github.mutations, ['addPullRequestReview', 'addPullRequestReviewThread', 'submitPullRequestReview']);
});

test('a step resent after the Editor dropped the connection before the response reaches GitHub once', {timeout: 10_000},
  async t => {
    const {graphql, github} = await startApi(t);
    const id = submitId(1);
    const steps = [
      ['addPullRequestReview', {number: 7, commitOid: head}, 'pending'],
      ['addPullRequestReviewThread', {number: 7, threadIndex: 0, path: projectFile, body: 'x'}, 'pending'],
      ['submitPullRequestReview', {number: 7, threadCount: 1, event: 'COMMENT', body: ''}, 'submitted']
    ];
    for (const [operation, variables, state] of steps) {
      const entered = Promise.withResolvers();
      const gate = Promise.withResolvers();
      github.faults.push({operation, apply: true, entered, gate: gate.promise});
      const controller = new AbortController();
      const dropped = graphql(operation, variables, id, {signal: controller.signal});
      await entered.promise;
      controller.abort();
      await assert.rejects(dropped, {name: 'AbortError'});
      gate.resolve();
      await settleRequests();
      await errorWith(graphql(operation, variables, id), 409, 'REVIEW_DUPLICATE');
      // The step ran to its end, so the record already holds its outcome.
      assert.equal((await ok(graphql('pullRequestReviewContext', {number: 7}, id))).submit.state, state);
    }
    assert.deepEqual(github.mutations, ['addPullRequestReview', 'addPullRequestReviewThread', 'submitPullRequestReview']);
  });

test('a pending review of the viewer stops the start step before the mutation', async t => {
  const {graphql, github} = await startApi(t);
  github.pending = {id: 'PRR_mine', commitOid: head, body: 'draft on github.com', threads: []};
  await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(1)), 409, 'PENDING_REVIEW_EXISTS');
  assert.deepEqual(github.mutations, []);
  await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(1)), 409, 'REVIEW_DUPLICATE');
  const context = await ok(graphql('pullRequestReviewContext', {number: 7}, submitId(1)));
  assert.deepEqual(context.submit, {state: 'closed', threads: 0});
  assert.deepEqual(context.pendingReview, {ours: false, commitOid: head, createdAt: '2026-11-11T00:00:00Z'});
  github.pending = null;
  await ok(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(2)));
  assert.deepEqual(github.mutations, ['addPullRequestReview']);
});

test('the review context resolves an unknown outcome as published, pending or absent', async t => {
  const {graphql, github} = await startApi(t);
  const lost = () => Promise.reject(new TypeError('connection lost'));

  // Start applied, answer lost: the pending review on the recorded commit is the submission's.
  github.faults.push({operation: 'addPullRequestReview', apply: true, response: () => new Response(null, {status: 502})});
  await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(1)), 502, 'UPSTREAM_FAILURE');
  await errorWith(graphql('addPullRequestReviewThread', {number: 7, threadIndex: 0, path: projectFile, body: 'x'},
    submitId(1)), 409, 'REVIEW_STEP_CONFLICT');
  let context = await ok(graphql('pullRequestReviewContext', {number: 7}, submitId(1)));
  assert.deepEqual(context.submit, {state: 'pending', threads: 0});
  assert.equal(context.pendingReview.ours, true);
  await ok(graphql('addPullRequestReviewThread', {number: 7, threadIndex: 0, path: projectFile, body: 'x'}, submitId(1)));

  // Submit applied, connection lost: published.
  github.faults.push({operation: 'submitPullRequestReview', apply: true, response: lost});
  await errorWith(graphql('submitPullRequestReview', {number: 7, threadCount: 1, event: 'COMMENT', body: ''}, submitId(1)),
    502, 'UPSTREAM_FAILURE');
  context = await ok(graphql('pullRequestReviewContext', {number: 7}, submitId(1)));
  assert.deepEqual(context.submit, {state: 'submitted', threads: 1});
  assert.equal(context.reviews[0].ours, true);

  // Start not applied, connection lost: absent.
  github.faults.push({operation: 'addPullRequestReview', response: lost});
  await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(2)), 502, 'UPSTREAM_FAILURE');
  context = await ok(graphql('pullRequestReviewContext', {number: 7}, submitId(2)));
  assert.deepEqual(context.submit, {state: 'closed', threads: 0});
  assert.equal(context.pendingReview, null);

  // Submit not applied, gateway timeout: still pending, and it can be sent again or discarded.
  await ok(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(3)));
  github.faults.push({operation: 'submitPullRequestReview', response: () => new Response(null, {status: 504})});
  await errorWith(graphql('submitPullRequestReview', {number: 7, threadCount: 0, event: 'APPROVE', body: ''}, submitId(3)),
    504, 'UPSTREAM_TIMEOUT');
  await errorWith(graphql('submitPullRequestReview', {number: 7, threadCount: 0, event: 'APPROVE', body: ''}, submitId(3)),
    409, 'REVIEW_DUPLICATE');
  await errorWith(graphql('deletePullRequestReview', {number: 7}, submitId(3)), 409, 'REVIEW_STEP_CONFLICT');
  context = await ok(graphql('pullRequestReviewContext', {number: 7}, submitId(3)));
  assert.deepEqual(context.submit, {state: 'pending', threads: 0});
  assert.equal(context.pendingReview.ours, true);
  await ok(graphql('deletePullRequestReview', {number: 7}, submitId(3)));
  assert.deepEqual(github.mutations, ['addPullRequestReview', 'addPullRequestReviewThread', 'submitPullRequestReview',
    'addPullRequestReview', 'deletePullRequestReview']);

  // A rejected thread leaves the record broken; only a discard follows.
  await ok(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(5)));
  github.faults.push({operation: 'addPullRequestReviewThread',
    response: () => Response.json({data: null, errors: [{type: 'UNPROCESSABLE', message: 'secret'}]})});
  await errorWith(graphql('addPullRequestReviewThread', {number: 7, threadIndex: 0, path: projectFile, body: 'x'},
    submitId(5)), 422, 'REVIEW_THREAD_REJECTED');
  await errorWith(graphql('addPullRequestReviewThread', {number: 7, threadIndex: 0, path: projectFile, body: 'x'},
    submitId(5)), 409, 'REVIEW_DUPLICATE');
  assert.deepEqual(await ok(graphql('deletePullRequestReview', {number: 7}, submitId(5))), {deleted: true});
});

test('GitHub rate limits become 429 RATE_LIMITED with retryAfter, apart from missing permissions', async t => {
  const {api, graphql, createReview, github, upstream} = await startApi(t);
  const reset = Math.floor(upstream.now() / 1000) + 30;
  github.faults.push({operation: 'rest', response: () => new Response(null, {status: 429, headers: {'Retry-After': '7'}})});
  await errorWith(api('/pulls'), 429, 'RATE_LIMITED', 7);
  github.faults.push({operation: 'rest', response: () => new Response(null, {status: 403, headers: {
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset)
  }})});
  await errorWith(api('/pulls/7'), 429, 'RATE_LIMITED', 30);
  github.faults.push({operation: 'rest', response: () => new Response(null, {status: 403})});
  await errorWith(api('/pulls/7'), 403, 'FORBIDDEN');
  github.faults.push({operation: 'createReview', response: () => new Response(null, {status: 403, headers: {'Retry-After': '5'}})});
  await errorWith(createReview({commit_id: head, event: 'COMMENT', body: 'x'}), 429, 'RATE_LIMITED', 5);

  github.faults.push({operation: 'pullRequestReviewContext', response: () => Response.json(
    {data: null, errors: [{type: 'SOMETHING'}]}, {headers: {'x-ratelimit-remaining': '0'}})});
  await errorWith(graphql('pullRequestReviewContext', {number: 7}), 429, 'RATE_LIMITED', 60);
  github.faults.push({operation: 'addPullRequestReview', response: () => Response.json(
    {data: null, errors: [{type: 'RATE_LIMITED'}]}, {headers: {'Retry-After': '11'}})});
  await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(2)), 429, 'RATE_LIMITED', 11);
  github.faults.push({operation: 'pullRequestReviewContext', response: () => Response.json(
    {data: null, errors: [{type: 'FORBIDDEN'}]})});
  await errorWith(graphql('pullRequestReviewContext', {number: 7}), 403, 'FORBIDDEN');
  github.faults.push({operation: 'pullRequestReviewContext', response: () => new Response(null, {status: 401})});
  await errorWith(graphql('pullRequestReviewContext', {number: 7}), 403, 'FORBIDDEN');
  // A well-formed success that used the last point is a success.
  github.graphqlHeaders = {'x-ratelimit-remaining': '0'};
  await ok(graphql('pullRequestReviewContext', {number: 7}));
  github.graphqlHeaders = {};
  // A rate-limited repository lookup.
  upstream.lookups.push(() => new Response(null, {status: 403, headers: {'x-ratelimit-remaining': '0', 'Retry-After': '9'}}));
  await errorWith(api('/pulls'), 429, 'RATE_LIMITED', 9);
  assert.deepEqual(github.mutations, []);
});

test('turning off review-threads alone leaves the review body routes working', async t => {
  const {api, graphql, createReview, github} = await startApi(t, {githubApi: 'pulls-read,reviews-body'});
  await errorWith(graphql('pullRequestReviewContext', {number: 7}), 404, 'GITHUB_API_UNAVAILABLE');
  await errorWith(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(1)), 404, 'GITHUB_API_UNAVAILABLE');
  assert.equal(github.calls.length, 0);
  await ok(api('/pulls'));
  const created = await ok(createReview({commit_id: head, event: 'COMMENT', body: 'Overall'}));
  assert.deepEqual(Object.keys(created).sort(), ['commit_id', 'html_url', 'id', 'state', 'submitted_at']);
  assert.equal(created.state, 'COMMENTED');
  assert.deepEqual(github.calls.at(-1).body, {commit_id: head, event: 'COMMENT', body: 'Overall'});
  await errorWith(createReview({commit_id: head, event: 'COMMENT', body: 'Overall'}), 409, 'REVIEW_DUPLICATE');
  const reviews = await ok(api('/pulls/7/reviews?page=1'));
  assert.deepEqual(reviews, [{id: created.id, user: {login: 'reviewer'}, commit_id: head, state: 'COMMENTED',
    submitted_at: '2026-11-11T01:00:00Z', body: 'Overall'}]);
  github.faults.push({operation: 'createReview', response: () => Response.json({message: 'secret'}, {status: 422})});
  await errorWith(createReview({commit_id: head, event: 'APPROVE'}, submitId(2)), 422, 'REVIEW_REJECTED');
  await errorWith(createReview({commit_id: head, event: 'APPROVE'}, submitId(2)), 409, 'REVIEW_DUPLICATE');
  // The duplicates never left the proxy; the rejected review did and was not applied.
  assert.equal(github.calls.filter(call => call.operation === 'createReview').length, 2);
  assert.deepEqual(github.mutations, ['createReview']);

  const {api: reads} = await startApi(t, {githubApi: 'review-threads'});
  await errorWith(reads('/pulls'), 404, 'GITHUB_API_UNAVAILABLE');
  await errorWith(reads('/pulls/7/reviews'), 404, 'GITHUB_API_UNAVAILABLE');
});

test('review submit records are limited per session and dropped with it', {timeout: 20_000}, async t => {
  const {graphql, createReview, service, github} = await startApi(t);
  github.faults.push(...Array.from({length: 256}, () => ({operation: 'createReview',
    response: () => new Response(null, {status: 500})})));
  for (let index = 1; index <= 255; index++) {
    await errorWith(createReview({commit_id: head, event: 'APPROVE'}, submitId(index)), 502, 'UPSTREAM_FAILURE');
  }
  await ok(graphql('addPullRequestReview', {number: 7, commitOid: head}, submitId(256)));
  await errorWith(createReview({commit_id: head, event: 'APPROVE'}, submitId(257)), 429, 'RATE_LIMITED');
  await errorWith(graphql('addPullRequestReview', {number: 8, commitOid: head}, submitId(258)), 429, 'RATE_LIMITED');
  // The record still answers its own steps.
  await ok(graphql('deletePullRequestReview', {number: 7}, submitId(256)));
  const replaced = await service.createSession(desktopRemote, false, true);
  github.faults.length = 0;
  await ok(call(service, replaced, apiRoot + '/graphql/addPullRequestReview', {method: 'POST',
    headers: {'Content-Type': 'application/json', 'Review-Submit-Id': submitId(256)},
    body: JSON.stringify({number: 7, commitOid: head})}));
});

test('an in-flight review step older than 60 seconds reads as unknown', () => {
  const records = reviewRecords.createReviewRecords();
  const id = submitId(1);
  let now = 0;
  const start = reviewRecords.reserveStep(records, {id, step: 'start', number: 7, commitOid: head}, 1, now);
  assert.equal(start.state, 'starting');
  assert.throws(() => reviewRecords.reserveStep(records, {id: submitId(2), step: 'start', number: 7, commitOid: head}, 1, now),
    {code: 'REVIEW_STEP_CONFLICT'});
  now = 60_000;
  const context = reviewRecords.reserveStep(records, {id, step: 'context', number: 7}, 1, now);
  assert.equal(context.state, 'start-unknown');
  // A late result of the expired attempt does not apply.
  assert.throws(() => reviewRecords.applyResult(records, id, start.attempt, 'ok',
    {pullRequestNodeId: 'PR_node', reviewNodeId: 'PRR_1'}, now), {code: 'REVIEW_STEP_CONFLICT'});
  reviewRecords.applyResult(records, id, context.attempt, 'pending', {pullRequestNodeId: 'PR_node', reviewNodeId: 'PRR_1'}, now);
  const thread = reviewRecords.reserveStep(records, {id, step: 'thread', number: 7, threadIndex: 0}, 1, now);
  assert.equal(thread.state, 'threading');
  now += 60_000;
  assert.throws(() => reviewRecords.reserveStep(records, {id, step: 'thread', number: 7, threadIndex: 0}, 1, now),
    {code: 'REVIEW_DUPLICATE'});
  assert.equal(reviewRecords.reserveStep(records, {id, step: 'delete', number: 7}, 1, now).resume, 'broken');
  assert.throws(() => reviewRecords.reserveStep(records, {id, step: 'context', number: 7}, 2, now),
    {code: 'REVIEW_STEP_CONFLICT'});
  reviewRecords.clearReviewRecords(records);
  assert.throws(() => reviewRecords.reserveStep(records, {id, step: 'context', number: 7}, 1, now),
    {code: 'REVIEW_STEP_CONFLICT'});
});

test('the authorize handler passes the review grant through', async () => {
  const {EventEmitter} = require('node:events');
  const {installEditorGit} = require('../src-main/local-git/editor-ipc');
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name, handler) => handlers.set(name, handler);
  const contents = new EventEmitter();
  contents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  installEditorGit(ipc, contents, {clientId: 'Iv1_test', store: {}, githubApi: allGroups});
  const event = {sender: contents, senderFrame: contents.mainFrame};
  assert.equal(await handlers.get('local-git-authorize')(event, desktopRemote, false, true), null);
  const preload = require('node:fs').readFileSync(require.resolve('../src-preload/editor.js'), 'utf8');
  assert.match(preload, /authorizeRepository: \(remote, write = false, review = false\) =>\s+ipcRenderer\.invoke\('local-git-authorize', remote, write, review\)/u);
});

test('token-only auth stays hidden from older Editors and cancellation releases the connection', async t => {
  const {EventEmitter} = require('node:events');
  const {installEditorGit} = require('../src-main/local-git/editor-ipc');
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name, handler) => handlers.set(name, handler);
  const contents = new EventEmitter();
  contents.mainFrame = {url: 'tw-editor://./plus-gui/gui.html'};
  installEditorGit(ipc, contents, {
    promptPersonalToken: async () => null,
    gitCredentialHelper: {available: async ({owner}) => owner === 'owner'},
    confirmGitCredential: async () => false
  });
  const event = {sender: contents, senderFrame: contents.mainFrame};
  ipc.emit('local-git-enabled', event);
  assert.equal(event.returnValue, false);
  ipc.emit('local-git-auth-enabled', event);
  assert.equal(event.returnValue, true);
  assert.deepEqual(await handlers.get('local-git-auth-methods')(event), ['fine-grained-pat']);
  assert.deepEqual(await handlers.get('local-git-auth-methods')(event, desktopRemote),
    ['fine-grained-pat', 'git-credential-helper']);
  assert.deepEqual(await handlers.get('local-git-auth-methods')(event, 'https://github.com/another/project'),
    ['fine-grained-pat']);
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

test('Git credential helper checks configuration and reads only GitHub HTTPS credentials', async () => {
  const {createGitCredentialHelper} = require('../src-main/local-git/git-credential-helper');
  const signal = new AbortController().signal;
  const remote = {owner: 'owner', repo: 'project'};
  const calls = [];
  let config = 'manager\n';
  let credential = 'protocol=https\nhost=github.com\nusername=fixture-user\npassword=gho_fixture\n';
  const helper = createGitCredentialHelper({
    run: async (args, input, receivedSignal) => {
      assert.equal(receivedSignal, signal);
      calls.push({args, input});
      return args[0] === 'config' ? config : credential;
    }
  });
  assert.equal(await helper.available(remote, signal), true);
  assert.deepEqual(calls[0], {
    args: ['config', '--get-urlmatch', 'credential.helper', 'https://github.com/owner/project.git'],
    input: undefined
  });
  assert.equal(await helper.read(remote, 'fixture-user', signal), 'gho_fixture');
  assert.deepEqual(calls[1], {
    args: ['-c', 'core.askPass=', '-c', 'credential.interactive=false', 'credential', 'fill'],
    input: 'protocol=https\nhost=github.com\npath=owner/project.git\nusername=fixture-user\n\n'
  });
  config = '\n';
  assert.equal(await helper.available(remote, signal), false);
  for (const invalid of [
    credential.replace('github.com', 'other.example'),
    credential + 'path=owner/other.git\n',
    credential + 'password=ghp_second\n',
    credential.replace('gho_fixture', 'plain-password')
  ]) {
    credential = invalid;
    await assert.rejects(helper.read(remote, 'fixture-user', signal), {code: 'REAUTH_REQUIRED'});
  }
  assert.equal(calls.some(({args}) => args.includes('reject') || args.includes('approve')), false);
});

test('Git credential connections require native consent and the confirmed GitHub account', async t => {
  const upstream = fixture();
  let available = false;
  let consent = false;
  const steps = [];
  const token = 'gho_fixture';
  const remote = {owner: 'owner', repo: 'project'};
  const service = await startDesktopGit({
    ...upstream,
    gitCredentialHelper: {
      available: async selection => {
        assert.deepEqual(selection, remote);
        steps.push('probe');
        return available;
      },
      read: async (selection, login) => {
        assert.deepEqual(selection, remote);
        assert.match(login, /^(?:wrong-user|FIXTURE-USER)$/u);
        steps.push('read');
        return token;
      }
    },
    confirmGitCredential: async (selection, login) => {
      assert.deepEqual(selection, remote);
      assert.match(login, /^(?:wrong-user|FIXTURE-USER)$/u);
      steps.push('confirm');
      return consent;
    },
    store: {
      write: () => assert.fail('Helper credentials must never reach persistent storage'),
      clear: async () => {},
      read: async () => null
    }
  });
  t.after(() => service.close());

  await assert.rejects(service.connectGitCredential(desktopRemote, 'FIXTURE-USER'), {code: 'GIT_UNAVAILABLE'});
  assert.deepEqual(steps.splice(0), ['probe']);
  available = true;
  assert.equal(await service.connectGitCredential(desktopRemote, 'FIXTURE-USER'), null);
  assert.deepEqual(steps.splice(0), ['probe', 'confirm']);
  assert.equal(upstream.calls.length, 0);
  await assert.rejects(service.connectGitCredential(desktopRemote, 'fixture\npassword=injection'), {code: 'BAD_REQUEST'});
  assert.deepEqual(steps, []);

  consent = true;
  await assert.rejects(service.connectGitCredential(desktopRemote, 'wrong-user'), {code: 'FORBIDDEN'});
  assert.deepEqual(steps.splice(0), ['probe', 'confirm', 'read']);
  assert.equal(service.getState().status, 'disconnected');
  assert.deepEqual(await service.connectGitCredential(desktopRemote, 'FIXTURE-USER'), {
    status: 'connected', account: {login: 'fixture-user'}, remembered: false
  });
  const session = await service.createSession(desktopRemote);
  assert.equal(JSON.stringify(session).includes(token), false);
  assert.equal(await (await call(service, session)).text(), 'git-bytes');
  await assert.rejects(service.createSession('https://github.com/owner/other'), {code: 'FORBIDDEN'});
  upstream.repositories.get('/repos/owner/project').id = 2;
  await error(call(service, session), 403, 'FORBIDDEN');
  await service.disconnect();
  assert.equal(await service.restore(), false);
});
