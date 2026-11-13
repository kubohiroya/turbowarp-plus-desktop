const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createRepositoryCreationJournal} = require('../src-main/local-git/repository-creation-journal');
const {installRepositoryCreation, loadCreationContract} = require('../src-main/local-git/repository-creation-ipc');
const {startRepositoryCreation} = require('../src-main/local-git/repository-creation-service');

const contract = loadCreationContract(process.env.TW_PLUS_DESKTOP_GITHUB_CREATE_AUTH_MODULE, false);
const clientId = 'Iv1_creation_fixture';
const accessToken = 'ghu_fixture';
const remote = 'https://github.com/octocat/project.git';
const editorOrigin = 'tw-editor://.';
const gitRoute = '/v1/git/octocat/project.git';
const gitDiscovery = gitRoute + '/info/refs?service=git-receive-pack';
const gitReceive = gitRoute + '/git-receive-pack';
const creationRoot = '/v1/github-create';
const seedDigest = 'a'.repeat(64);
const draft = {operationId: 'test-one', owner: 'octocat', name: 'project', description: 'First draft',
  visibility: 'private', topics: ['scratch'], seedDigest};
const device = {device_code: 'device_fixture', user_code: 'FIXT-1234', verification_uri: 'https://github.com/login/device',
  interval: 1, expires_in: 900};
const readType = 'application/x-git-receive-pack-advertisement';
const sendType = 'application/x-git-receive-pack-result';
const pushHeaders = {'Content-Type': 'application/x-git-receive-pack-request', 'Git-Push-Id': 'b3544f00-12a0-4e30-8c92-3786485930b7'};

const fakeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from(value).map(byte => byte ^ 0xef),
  decryptStringAsync: async bytes => ({result: bytes.map(byte => byte ^ 0xef).toString()})
};

async function makeJournal (t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tw-desktop-create-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const options = {directory, clientId, safeStorage: fakeStorage, platform: 'darwin'};
  return {directory, journal: createRepositoryCreationJournal(options), reopen: () => createRepositoryCreationJournal(options)};
}

function fakeGitHub (options = {}) {
  const actions = [];
  const repos = new Map();
  const seenHeaders = [];
  const makeRepo = (owner, name, isPrivate, id) => ({
    id, owner: {login: owner}, name, private: isPrivate, created_at: new Date().toISOString(), permissions: {push: true}
  });
  return {
    actions,
    repos,
    seenHeaders,
    async request (url, {headers, body, method = 'GET'}) {
      const target = new URL(url);
      const route = target.pathname;
      if (route === '/login/device/code') {
        assert.equal(body.get('client_id'), clientId);
        return Response.json(device);
      }
      if (route === '/login/oauth/access_token') return Response.json({
        access_token: accessToken, refresh_token: 'ghr_fixture', expires_in: 1800, refresh_token_expires_in: 9000
      });
      seenHeaders.push(headers.Authorization);
      if (target.origin === 'https://github.com') {
        assert.equal(headers.Authorization, 'Basic ' + Buffer.from('x-access-token:' + accessToken).toString('base64'));
        if (method === 'POST') {
          actions.push('receive-pack');
          for await (const _chunk of body) { /* Drain the simulated Git request. */ }
          return new Response('receive-result', {headers: {'Content-Type': sendType}});
        }
        return new Response('receive-advertisement', {headers: {'Content-Type': readType}});
      }
      assert.equal(target.origin, 'https://api.github.com');
      assert.equal(headers.Authorization, 'Bearer ' + accessToken);
      if (route === '/user') return Response.json({login: 'octocat'});
      if (route === '/user/installations') return Response.json({total_count: 4, installations: [
        {account: {login: 'octocat'}, target_type: 'User',
          permissions: {repository_creation: 'write', contents: 'write', ...(options.topics && {administration: 'write'})}},
        {account: {login: 'team'}, target_type: 'Organization', permissions: {repository_creation: 'write', contents: 'write'}},
        {account: {login: 'read-only'}, target_type: 'Organization', permissions: {contents: 'read'}},
        {account: {login: 'suspended'}, target_type: 'Organization', suspended_at: '2026-11-13',
          permissions: {repository_creation: 'write', contents: 'write'}}
      ]});
      if (method === 'POST') {
        assert.match(route, /^\/(?:user|orgs\/team)\/repos$/u);
        const owner = route.startsWith('/user/') ? 'octocat' : 'team';
        const data = JSON.parse(body);
        assert.deepEqual(data, {name: 'project', description: 'First draft', private: options.expectedPrivate ?? true,
          auto_init: false});
        actions.push('create ' + owner);
        const key = owner + '/project';
        if (repos.has(key)) return Response.json({errors: [{field: 'name', message: 'name already exists'}]}, {status: 422});
        repos.set(key, makeRepo(owner, data.name, data.private, 123));
        if (options.unknown) throw new Error('response lost');
        return Response.json(repos.get(key), {status: 201});
      }
      const [, owner, name, suffix] = /^\/repos\/([^/]+)\/([^/]+)(.*)$/u.exec(route);
      const repo = repos.get(owner + '/' + name);
      if (!repo) return new Response(null, {status: 404});
      if (suffix === '') return Response.json(repo);
      if (suffix === '/branches' || suffix === '/tags') return Response.json(repo.hasBranches ? [{name: 'main'}] : []);
      assert.equal(method, 'PUT');
      assert.equal(suffix, '/topics');
      assert.deepEqual(JSON.parse(body), {names: ['scratch']});
      actions.push('topics');
      return Response.json({names: ['scratch']});
    }
  };
}

async function newService (t, journal, github, overrides = {}) {
  const service = await startRepositoryCreation({
    clientId, contract, journal, request: github.request, wait: async () => {},
    confirmCreate: async () => true, confirmAdoption: async () => false, ...overrides
  });
  t.after(() => service.close());
  const code = await service.begin();
  assert.equal(code.userCode, device.user_code);
  assert.equal(JSON.stringify(code).includes(device.device_code), false);
  const grant = await service.finish();
  assert.match(grant.bearer, /^create\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(JSON.stringify(grant).includes(accessToken), false);
  assert.deepEqual(service.getGrant(), grant);
  const call = (route, {origin = editorOrigin, bearer = grant.bearer, data, headers = {}, ...rest} = {}) =>
    fetch(service.connection.proxyOrigin + route, {headers: {
      Origin: origin, Authorization: 'Bearer ' + bearer, ...(data && {'Content-Type': 'application/json'}), ...headers
    }, ...(data && {body: JSON.stringify(data)}), ...rest});
  return {service, grant, call};
}

test('encrypted repository creation journal serializes and persists, rejecting corrupted records', async t => {
  const {journal, reopen, directory} = await makeJournal(t);
  const entry = {intent: draft, status: 'unknown', startedAt: 123};
  const trace = [];
  await Promise.all([
    journal.exclusive(draft.operationId, async () => {
      trace.push('first started');
      await journal.write(entry);
      trace.push('first done');
    }),
    journal.exclusive(draft.operationId, async () => {
      trace.push('second started');
      assert.deepEqual(await journal.read(draft.operationId), entry);
    })
  ]);
  assert.deepEqual(trace, ['first started', 'first done', 'second started']);
  assert.deepEqual(await reopen().read(draft.operationId), entry);
  const root = path.join(directory, 'github-repository-creation');
  const [file] = await fs.readdir(root);
  const saved = path.join(root, file);
  assert.equal((await fs.readFile(saved)).includes(draft.description), false);
  await fs.writeFile(saved, 'invalid');
  await assert.rejects(reopen().read(draft.operationId), {code: 'STORAGE_FAILURE'});
  await assert.rejects(reopen().read('../escape'), {code: 'BAD_REQUEST'});
});

test('creation routes and initial Git push use disjoint grants and the repository receipt', {skip: !contract}, async t => {
  const {journal} = await makeJournal(t);
  const github = fakeGitHub();
  let prompts = 0;
  const {call, service, grant} = await newService(t, journal, github, {confirmCreate: async intent => {
    assert.equal(intent.account, 'octocat');
    assert.equal(intent.visibility, 'private');
    prompts++;
    return true;
  }});
  const options = {method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'
  }};
  assert.equal((await call(creationRoot + '/repos', options)).status, 204);
  assert.equal((await call(creationRoot + '/owners', {origin: 'https://not-editor.invalid'})).status, 403);
  assert.equal((await call(creationRoot + '/owners', {bearer: 'a'.repeat(43)})).status, 401);
  assert.equal((await call(gitDiscovery)).status, 401);
  assert.deepEqual((await (await call(creationRoot + '/owners')).json()).owners.map(owner => owner.login), ['octocat', 'team']);
  assert.equal((await call(creationRoot + '/repos', {method: 'POST', data: {...draft, owner: 'arbitrary'}})).status, 403);
  const create = (data = draft) => call(creationRoot + '/repos', {method: 'POST', data});
  const [first, second] = await Promise.all([create(), create()]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(await first.json(), {id: 123, owner: 'octocat', name: 'project', visibility: 'private', remote});
  assert.equal(prompts, 1);
  assert.deepEqual(github.actions, ['create octocat']);
  await assert.rejects(service.authorizeInitialPush(draft.operationId, 444), {code: 'REAUTH_REQUIRED'});
  const write = await service.authorizeInitialPush(draft.operationId, 123);
  assert.equal(write.remote, remote);
  assert.equal(write.repositoryId, 123);
  assert.notEqual(write.session.bearer, grant.bearer);
  assert.equal((await call(creationRoot + '/owners', {bearer: write.session.bearer})).status, 401);
  assert.equal((await call(gitDiscovery.replace('project.git', 'other.git'), {bearer: write.session.bearer})).status, 403);
  assert.equal((await call(gitDiscovery, {bearer: write.session.bearer})).status, 200);
  const push = () => call(gitReceive, {bearer: write.session.bearer, method: 'POST', headers: pushHeaders, body: 'pack'});
  assert.equal((await push()).status, 200);
  assert.equal((await push()).status, 409);
  assert.equal((await call(creationRoot + '/repos/123/topics',
    {method: 'PUT', data: {operationId: draft.operationId}})).status, 403);
  assert.deepEqual(github.actions, ['create octocat', 'receive-pack']);
  service.revokeInitialPush(draft.operationId, 123, 'another-grant');
  assert.equal((await call(gitDiscovery, {bearer: write.session.bearer})).status, 200);
  service.revokeInitialPush(draft.operationId, 123, write.session.bearer);
  assert.equal((await call(gitDiscovery, {bearer: write.session.bearer})).status, 401);
  service.disconnect();
  assert.equal(service.getGrant(), null);
  assert.equal((await call(gitDiscovery, {bearer: write.session.bearer})).status, 401);
});

test('a lost response uses the durable receipt and verifies native adoption before Topics or push', {skip: !contract}, async t => {
  const {journal, reopen} = await makeJournal(t);
  const github = fakeGitHub({unknown: true, topics: true});
  const first = await newService(t, journal, github);
  const route = creationRoot + '/repos';
  assert.equal((await first.call(route, {method: 'POST', data: draft})).status, 502);
  assert.deepEqual(github.actions, ['create octocat']);
  await first.service.close();
  let confirmations = 0;
  const next = await newService(t, reopen(), github, {confirmAdoption: async candidate => {
    assert.equal(candidate.id, 123);
    confirmations++;
    return confirmations === 2;
  }});
  assert.equal((await next.call(route, {method: 'POST', data: draft})).status, 502);
  await assert.rejects(next.service.authorizeInitialPush(draft.operationId, 123), {code: 'REAUTH_REQUIRED'});
  assert.equal((await next.service.inspectUnknown(draft.operationId)).id, 123);
  assert.equal((await next.service.inspectCreation(draft.operationId)).status, 'unknown');
  assert.equal(await next.service.adoptUnknown(draft.operationId, 123), null);
  assert.equal((await next.service.adoptUnknown(draft.operationId, 123)).id, 123);
  assert.equal((await next.service.inspectCreation(draft.operationId)).repository.id, 123);
  const topics = id => next.call(creationRoot + '/repos/' + id + '/topics',
    {method: 'PUT', data: {operationId: draft.operationId}});
  assert.equal((await topics(444)).status, 401);
  assert.equal((await topics(123)).status, 204);
  assert.equal((await topics(123)).status, 204);
  assert.deepEqual(github.actions, ['create octocat', 'topics']);
  const write = await next.service.authorizeInitialPush(draft.operationId, 123);
  github.repos.get('octocat/project').hasBranches = true;
  assert.equal((await next.call(gitReceive,
    {bearer: write.session.bearer, method: 'POST', headers: pushHeaders, body: 'pack'})).status, 409);
  github.repos.get('octocat/project').id = 321;
  await assert.rejects(next.service.authorizeInitialPush(draft.operationId, 123), {code: 'FORBIDDEN'});
});

test('the shared creation client can create a public organization repository and report a conflict', {skip: !contract}, async t => {
  const {journal} = await makeJournal(t);
  const github = fakeGitHub({expectedPrivate: false});
  const {service} = await newService(t, journal, github, {confirmCreate: async intent => {
    assert.equal(intent.owner, 'team');
    assert.equal(intent.visibility, 'public');
    return true;
  }});
  const client = contract.createRepositoryCreationClient({connection: service.connection, authorize: async () => service.getGrant(),
    fetch: (url, options) => fetch(url, {...options, headers: {...options.headers, Origin: editorOrigin}})});
  const session = await client.connectForCreation();
  assert.equal(session.owners.find(owner => owner.login === 'team').type, 'Organization');
  const intent = {...draft, owner: 'team', visibility: 'public', topics: []};
  const repository = await client.createRepository(session, intent);
  assert.equal(repository.visibility, 'public');
  assert.equal(repository.remote, 'https://github.com/team/project.git');
  await assert.rejects(client.createRepository(session, {...intent, operationId: 'different-attempt'}), {code: 'nameConflict'});
});

test('creation preload routes are available only to the Plus Editor main frame', async () => {
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name, callback) => handlers.set(name, callback);
  const contents = new EventEmitter();
  const frame = {url: 'tw-editor://./plus-gui/gui.html'};
  contents.mainFrame = frame;
  installRepositoryCreation(ipc, contents, {contract: {RepositoryCreationError: Error}});
  const event = {sender: contents, senderFrame: frame};
  ipc.emit('local-git-creation-enabled', event);
  assert.equal(event.returnValue, true);
  const child = {sender: contents, senderFrame: {url: frame.url}};
  ipc.emit('local-git-creation-enabled', child);
  assert.equal(child.returnValue, false);
  await assert.rejects(handlers.get('local-git-creation-grant')(child), {message: 'GIT_UNAVAILABLE'});
  assert.equal(await handlers.get('local-git-creation-grant')(event), null);
  assert.equal(loadCreationContract('./arbitrary.js', false), null);
  assert.equal(loadCreationContract('/tmp/arbitrary.js', true), loadCreationContract(undefined, true));
});
