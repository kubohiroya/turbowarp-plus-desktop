const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {EventEmitter} = require('node:events');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {installEditorGit} = require('../src-main/local-git/editor-ipc');
const {startDesktopGit} = require('../src-main/local-git/service');
const {createDesktopPublication, createPublicationJournal, loadPublicationContract, publicationCapabilities} =
  require('../src-main/local-git/publication');

const contract = loadPublicationContract(process.env.TW_PLUS_DESKTOP_GIT_PUBLICATION_MODULE_DIR, false);
const clientId = 'Iv1_fixture';
const token = 'ghu_publication_fixture';
const remote = 'https://github.com/fixture/work.git';
const id = 'e9c66e25-283c-4bea-9d02-4d4be215005a';
const mergeId = 'ce66442c-d571-45bc-afc7-e73f6f1ead4e';
const head = 'tw-plus/pr-' + id;
const baseOid = 'a'.repeat(40);
const commitOid = 'b'.repeat(40);
const mergeOid = 'c'.repeat(40);
const intent = {id, remote, repositoryId: 7, head, base: 'main', baseOid, commitOid, title: 'Approved title',
  body: 'Approved body', goal: 'merge'};
const target = {id, remote, repositoryId: 7};
const all = publicationCapabilities('pulls-read,pulls-write,checks-read,merge,issues-read,issues-write');
const fakeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from(value).map(byte => byte ^ 0xef),
  decryptStringAsync: async bytes => ({result: bytes.map(byte => byte ^ 0xef).toString()})
};

function fakeGitHub () {
  let pullBody;
  const writes = [];
  const state = {branch: null, checks: 'PENDING', merged: false};
  const pull = () => ({
    number: 13, state: state.merged ? 'closed' : 'open', merged: state.merged, merge_commit_sha: state.merged ? mergeOid : null,
    changed_files: 1, body: pullBody, head: {ref: head, sha: commitOid, repo: {id: 7}},
    base: {ref: 'main', sha: baseOid, repo: {id: 7}}
  });
  return {
    writes, state,
    async request (url, {headers, method = 'GET', body}) {
      const target = new URL(url);
      if (target.pathname === '/login/device/code') return Response.json({
        device_code: 'device_fixture', user_code: 'FIXT-1234', verification_uri: 'https://github.com/login/device',
        interval: 1, expires_in: 900
      });
      if (target.pathname === '/login/oauth/access_token') return Response.json({
        access_token: token, refresh_token: 'ghr_fixture', expires_in: 1800, refresh_token_expires_in: 9000
      });
      assert.equal(target.origin, 'https://api.github.com');
      assert.equal(headers.Authorization, 'Bearer ' + token);
      if (target.pathname === '/user') return Response.json({login: 'fixture'});
      if (target.pathname === '/repos/fixture/work') return Response.json({
        id: 7, full_name: 'fixture/work', permissions: {pull: true, push: true}
      });
      if (target.pathname === '/repos/fixture/work/pulls/11') return Response.json({
        number: 11, state: 'open', head: {ref: 'parent', sha: baseOid, repo: {id: 7}},
        base: {ref: 'main', sha: mergeOid, repo: {id: 7}}
      });
      if (target.pathname === '/graphql') {
        assert.equal(method, 'POST');
        assert.deepEqual(JSON.parse(body).variables, {owner: 'fixture', name: 'work', number: 13});
        return Response.json({data: {repository: {databaseId: 7, pullRequest: {
          headRefOid: commitOid, baseRefOid: baseOid, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
          reviewDecision: null, closingIssuesReferences: {totalCount: 0},
          commits: {nodes: [{commit: {oid: commitOid, statusCheckRollup: {
            state: state.checks, contexts: {totalCount: 1}
          }}}]}
        }}}});
      }
      assert.ok(target.pathname.startsWith('/repos/fixture/work/'));
      const route = target.pathname.slice('/repos/fixture/work'.length);
      if (route.startsWith('/git/ref/heads/')) {
        const branch = route.slice('/git/ref/heads/'.length);
        assert.ok(branch === 'main' || branch === head);
        const sha = branch === 'main' ? baseOid : state.branch;
        return sha ? Response.json({ref: 'refs/heads/' + branch, object: {type: 'commit', sha}}) :
          new Response(null, {status: 404});
      }
      if (route === '/pulls' && method === 'GET') return Response.json(pullBody ? [pull()] : []);
      if (route === '/pulls' && method === 'POST') {
        const payload = JSON.parse(body);
        assert.equal(payload.head, head);
        assert.equal(payload.base, 'main');
        assert.equal(payload.title, intent.title);
        assert.ok(payload.body.startsWith(intent.body));
        pullBody = payload.body;
        writes.push('pull');
        return Response.json(pull(), {status: 201});
      }
      if (route === '/pulls/13' && method === 'GET') return Response.json(pull());
      if (route === '/pulls/13/files' && method === 'GET') return Response.json([
        {filename: 'project/project.source.json', sha: 'd'.repeat(40), status: 'modified', additions: 1, deletions: 0}
      ]);
      if (route === '/pulls/13/merge-async' && method === 'PUT') {
        assert.deepEqual(JSON.parse(body), {sha: commitOid, merge_method: 'squash', merge_action: 'default', bypass_rules: false});
        writes.push('merge');
        return Response.json({status: 'pending', details: {uuid: mergeId}}, {status: 202});
      }
      assert.fail('Unexpected GitHub endpoint: ' + route);
    }
  };
}

test('Desktop publication advances a confirmed immutable PR after a scoped branch push and waits for CI', {skip: !contract}, async t => {
  const github = fakeGitHub();
  const service = await startDesktopGit({clientId, request: github.request, wait: async () => {}});
  t.after(() => service.close());
  await service.begin();
  await service.finish();
  await service.createSession(remote, false);
  await assert.rejects(service.authorizePublication(remote, 7), {code: 'FORBIDDEN'});
  await service.createSession(remote, true);
  await assert.rejects(service.authorizePublication(remote, 8), {code: 'FORBIDDEN'});
  await assert.rejects(service.authorizePublication('https://github.com/fixture/other.git', 7), {code: 'FORBIDDEN'});

  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tw-desktop-publication-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const journalOptions = {directory, clientId, safeStorage: fakeStorage, platform: 'darwin'};
  let prompts = 0;
  const open = (capabilities = all) => createDesktopPublication({contract, journal: createPublicationJournal(journalOptions),
    capabilities, authorize: service.authorizePublication, request: github.request, async confirm (approved, login) {
      assert.equal(approved.commitOid, commitOid);
      assert.equal(approved.baseOid, baseOid);
      assert.equal(login, 'fixture');
      assert.equal(approved.goal, 'merge');
      return ++prompts > 1;
    }
  });
  await assert.rejects(open(['pulls-read', 'pulls-write']).enqueue(intent), {code: 'FORBIDDEN'});
  const publication = open();
  assert.deepEqual(await publication.repository(remote), {repositoryId: 7});
  await assert.rejects(publication.repository('https://github.com/fixture/other.git'), {code: 'FORBIDDEN'});
  const withStacks = open([...all, 'stacks']);
  const parent = {number: 11, head: 'parent', headOid: baseOid, targetBase: 'main'};
  await assert.rejects(publication.stackParent(remote, 11), {code: 'FORBIDDEN'});
  assert.deepEqual(await withStacks.stackParent(remote, 11), parent);
  await assert.rejects(withStacks.enqueue({...intent, base: parent.head, stackParent: {...parent, targetBase: 'other'}}),
    {code: 'PUBLICATION_CHANGED'});
  assert.equal(prompts, 0);
  assert.equal(await publication.enqueue(intent), null);
  assert.equal(await publication.get(target), null);
  assert.equal((await publication.enqueue(intent)).status, 'queued');
  assert.equal((await publication.enqueue(intent)).status, 'queued');
  assert.equal(prompts, 2);
  await assert.rejects(publication.enqueue({...intent, title: 'Changed'}), {code: 'PUBLICATION_CHANGED'});
  const pendingPush = await publication.advance(target);
  assert.equal(pendingPush.awaitingPush, true);
  const session = service.getSession();
  assert.equal(pendingPush.pushAccount, session.account.login);
  assert.equal(pendingPush.pushSessionId, createHash('sha256').update(session.bearer).digest('hex'));
  assert.equal(JSON.stringify(pendingPush).includes(session.bearer), false);
  assert.deepEqual(github.writes, []);

  github.state.branch = commitOid;
  const restarted = open();
  assert.equal((await restarted.advance(target)).status, 'pushed');
  assert.equal((await restarted.advance(target)).status, 'issueReady');
  assert.equal((await restarted.advance(target)).status, 'waiting');
  assert.equal((await restarted.advance(target)).status, 'waiting');
  assert.deepEqual(github.writes, ['pull']);
  github.state.checks = 'SUCCESS';
  assert.equal((await restarted.advance(target)).status, 'ready');
  assert.equal((await restarted.advance(target)).mergeRequestId, mergeId);
  github.state.merged = true;
  assert.equal((await restarted.advance(target)).status, 'merged');
  const final = await restarted.advance(target);
  assert.equal(final.status, 'done');
  assert.equal(final.mergeOid, mergeOid);
  assert.deepEqual(github.writes, ['pull', 'merge']);
  assert.equal(JSON.stringify(final).includes(token), false);
  await service.disconnect();
  await assert.rejects(restarted.advance(target), {code: 'FORBIDDEN'});
});

test('publication capability setup and IPC allow only the configured Plus Editor top frame', async () => {
  assert.deepEqual(publicationCapabilities('pulls-read,pulls-write'), ['pulls-read', 'pulls-write']);
  assert.equal(publicationCapabilities('pulls-write'), null);
  assert.equal(publicationCapabilities('pulls-read,pulls-write,pulls-write'), null);
  assert.equal(publicationCapabilities('pulls-read,pulls-write,unknown'), null);
  assert.equal(loadPublicationContract('./relative', false), null);
  const ipc = new EventEmitter();
  const handles = new Map();
  ipc.handle = (name, handle) => handles.set(name, handle);
  const contents = new EventEmitter();
  const frame = {url: 'tw-editor://./plus-gui/gui.html'};
  contents.mainFrame = frame;
  installEditorGit(ipc, contents, {clientId, publication: {capabilities: all}});
  const event = {sender: contents, senderFrame: frame};
  ipc.emit('local-git-publication-enabled', event);
  assert.equal(event.returnValue, true);
  assert.deepEqual(await handles.get('local-git-publication-capabilities')(event), all);
  const child = {sender: contents, senderFrame: {url: frame.url}};
  ipc.emit('local-git-publication-enabled', child);
  assert.equal(child.returnValue, false);
  await assert.rejects(handles.get('local-git-publication-advance')(child, target), {message: 'GIT_UNAVAILABLE'});
  await assert.rejects(handles.get('local-git-publication-stack-parent')(child, remote, 11), {message: 'GIT_UNAVAILABLE'});
});
