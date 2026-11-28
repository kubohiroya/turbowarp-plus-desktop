const assert = require('node:assert/strict');
const {test} = require('node:test');
const {EDITOR_ORIGIN} = require('../src-main/local-git/git-proxy');
const {startDesktopGit} = require('../src-main/local-git/service');

// `POST /v1/github/<owner>/<repo>/name` of the loopback proxy, against a stand-in for api.github.com that keeps the
// repositories by ID and redirects a renamed repository's old name.

const remote = 'https://github.com/owner/project.git';

function upstream ({admin = true, patch} = {}) {
  let time = 100_000;
  const repositories = [
    {id: 1, owner: 'owner', name: 'project', admin},
    {id: 2, owner: 'owner', name: 'taken', admin: true}
  ];
  const patches = [];
  const find = (owner, name) => repositories.find(repository =>
    repository.owner.toLowerCase() === owner.toLowerCase() && repository.name.toLowerCase() === name.toLowerCase());
  return {
    repositories, patches,
    now: () => time,
    wait: async (milliseconds) => { time += milliseconds; },
    request: async (url, options) => {
      options.signal?.throwIfAborted();
      const {pathname} = new URL(url);
      if (pathname === '/login/device/code') {
        return Response.json({device_code: 'device_token', user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 1});
      }
      if (pathname === '/login/oauth/access_token') {
        return Response.json({access_token: 'ghu_one', refresh_token: 'ghr_one', expires_in: 3600,
          refresh_token_expires_in: 7200});
      }
      if (pathname === '/user') return Response.json({id: 1, login: 'fixture-user'});
      const match = /^\/repos\/([^/]+)\/([^/]+)$/u.exec(pathname);
      if (!match) return new Response(null, {status: 404});
      const repository = find(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      if (options.method === 'PATCH') {
        assert.equal(options.redirect, 'manual');
        const body = JSON.parse(options.body);
        assert.deepEqual(Object.keys(body), ['name']);
        patches.push({url, body});
        if (patch) return patch(body.name);
        const other = find('owner', body.name);
        if (other && other !== repository) return Response.json({message: 'name already exists'}, {status: 422});
        repository.name = body.name;
        return Response.json({id: repository.id, full_name: repository.owner + '/' + repository.name});
      }
      // The lookups use `redirect: 'error'`, so GitHub's redirect of an old name fails the request.
      if (!repository) throw new TypeError('redirect');
      return Response.json({id: repository.id, full_name: repository.owner + '/' + repository.name,
        permissions: {pull: true, push: true, admin: repository.admin}});
    }
  };
}

async function start (t, options = {}, githubApi = 'repository-rename') {
  const github = upstream(options);
  const service = await startDesktopGit({clientId: 'Iv1_test', ...github, githubApi});
  t.after(() => service.close());
  await service.begin();
  await service.finish();
  return {github, service};
}

function rename (service, session, repo, value) {
  const body = JSON.stringify(value);
  return fetch(service.connection.proxyOrigin + '/v1/github/owner/' + repo + '/name', {
    method: 'POST', body,
    headers: {Origin: EDITOR_ORIGIN, Authorization: 'Bearer ' + session.bearer, 'Content-Type': 'application/json'}
  });
}

async function failure (request, status, code) {
  const response = await request;
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  assert.equal(value.code, code);
}

test('renames the session repository and moves the session to the new name', async t => {
  const {github, service} = await start(t);
  const session = await service.createSession(remote, true);
  const response = await rename(service, session, 'project', {name: 'my-urashima'});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {owner: 'owner', repo: 'my-urashima', repositoryId: 1});
  assert.deepEqual(github.patches.map(patch => patch.url), ['https://api.github.com/repos/owner/project']);
  // The session now answers for the new name only.
  await failure(rename(service, session, 'project', {name: 'again'}), 403, 'FORBIDDEN');
  const again = await rename(service, session, 'my-urashima', {name: 'my-urashima'});
  assert.equal(again.status, 200);
  assert.equal(github.patches.length, 1);
});

test('completes a retry after an unknown outcome without renaming again', async t => {
  const {github, service} = await start(t);
  const session = await service.createSession(remote, true);
  github.repositories[0].name = 'my-urashima';
  const response = await rename(service, session, 'project', {name: 'my-urashima'});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {owner: 'owner', repo: 'my-urashima', repositoryId: 1});
  assert.equal(github.patches.length, 0);
});

test('reports a taken name, a missing admin role and a missing Administration permission', async t => {
  let {service} = await start(t);
  let session = await service.createSession(remote, true);
  await failure(rename(service, session, 'project', {name: 'taken'}), 409, 'REPOSITORY_NAME_UNAVAILABLE');

  ({service} = await start(t, {admin: false}));
  session = await service.createSession(remote, true);
  await failure(rename(service, session, 'project', {name: 'renamed'}), 403, 'FORBIDDEN');

  let github;
  ({github, service} = await start(t, {patch: () => Response.json({message: 'Resource not accessible by integration'},
    {status: 403})}));
  session = await service.createSession(remote, true);
  await failure(rename(service, session, 'project', {name: 'renamed'}), 403, 'ADMINISTRATION_PERMISSION_REQUIRED');
  assert.equal(github.patches.length, 1);
});

test('requires a write session and a valid name, and is off unless enabled', async t => {
  const {github, service} = await start(t);
  const readOnly = await service.createSession(remote, false);
  await failure(rename(service, readOnly, 'project', {name: 'renamed'}), 403, 'FORBIDDEN');
  const session = await service.createSession(remote, true);
  for (const value of [{name: ''}, {name: '..'}, {name: 'a.git'}, {name: '浦島'}, {name: 'a'.repeat(101)},
    {name: 'ok', private: true}]) {
    await failure(rename(service, session, 'project', value), 400, 'BAD_REQUEST');
  }
  assert.equal(github.patches.length, 0);

  const off = await start(t, {}, 'pulls-read');
  const offSession = await off.service.createSession(remote, true);
  await failure(rename(off.service, offSession, 'project', {name: 'renamed'}), 404, 'GITHUB_API_UNAVAILABLE');
});
