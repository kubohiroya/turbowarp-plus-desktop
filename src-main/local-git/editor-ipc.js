const {GitServiceError} = require('./github-auth');
const {startDesktopGit, PERSONAL_TOKEN, GIT_CREDENTIAL_HELPER} = require('./service');
const {parseRemote} = require('./git-proxy');

const EDITOR_DOCUMENT = 'tw-editor://./plus-gui/gui.html';
let active = null;

function installEditorGit (ipc, webContents, {
  clientId, store, githubApi, promptPersonalToken, gitCredentialHelper, confirmGitCredential
}) {
  const methods = [];
  if (clientId) methods.push('github-app');
  if (promptPersonalToken) methods.push(PERSONAL_TOKEN);
  const hasGitCredentialHelper = !!(gitCredentialHelper && confirmGitCredential);

  function trusted (event) {
    return event.sender === webContents && event.senderFrame === webContents.mainFrame &&
      typeof event.senderFrame?.url === 'string' && event.senderFrame.url.split(/[?#]/u, 1)[0] === EDITOR_DOCUMENT;
  }

  async function getService (start) {
    if (!active && start) {
      const service = startDesktopGit({
        clientId, store, githubApi, promptPersonalToken, gitCredentialHelper, confirmGitCredential
      });
      const lease = {owner: webContents, service};
      active = lease;
      service.catch(() => { if (active === lease) active = null; });
    }
    if (active?.owner === webContents && !active.closing) return active.service;
    if (start) throw new GitServiceError(409, 'GIT_IN_USE');
    return null;
  }

  async function release (forget) {
    const lease = active;
    if (lease?.owner !== webContents) {
      if (forget) {
        if (lease) throw new GitServiceError(409, 'GIT_IN_USE');
        await store?.clear();
      }
      return;
    }
    if (lease.closing) {
      await lease.closing;
      if (forget) return release(true);
      return;
    }
    lease.closing = (async () => {
      const service = await lease.service;
      try {
        if (forget) await service.disconnect();
      } finally {
        await service.close();
      }
    })();
    try {
      await lease.closing;
    } finally {
      if (active === lease) active = null;
    }
  }

  ipc.on('local-git-enabled', event => { event.returnValue = !!clientId && trusted(event); });
  ipc.on('local-git-auth-enabled', event => {
    event.returnValue = (methods.length > 0 || hasGitCredentialHelper) && trusted(event);
  });
  const handle = (name, action) => ipc.handle('local-git-' + name, async (event, ...args) => {
    if (!trusted(event)) throw new Error('GIT_UNAVAILABLE');
    try {
      return await action(...args);
    } catch (error) {
      throw new Error(error instanceof GitServiceError ? error.code :
        error?.name === 'AbortError' ? 'ABORTED' : 'GIT_UNAVAILABLE');
    }
  });
  handle('auth-methods', async remote => {
    if (hasGitCredentialHelper && remote !== undefined && await gitCredentialHelper.available(parseRemote(remote))) {
      return [...methods, GIT_CREDENTIAL_HELPER];
    }
    return methods;
  });

  async function connect (action) {
    const pending = getService(true);
    const lease = active;
    const service = await pending;
    try {
      return await action(service);
    } finally {
      if (active === lease && service.getState().status === 'disconnected') await release(false);
    }
  }
  handle('connect-personal-access-token', (remote, remember) => {
    if (!promptPersonalToken) throw new GitServiceError(403, 'GIT_UNAVAILABLE');
    return connect(service => service.connectPersonalAccessToken(remote, remember));
  });
  handle('connect-git-credential', (remote, login) => {
    if (!hasGitCredentialHelper) throw new GitServiceError(403, 'GIT_UNAVAILABLE');
    return connect(service => service.connectGitCredential(remote, login));
  });
  handle('connection', async () => (await getService(false))?.connection ?? null);
  handle('state', async () => (await getService(false))?.getState() ?? {status: 'disconnected'});
  handle('begin', async remember => {
    if (!clientId) throw new GitServiceError(403, 'GIT_UNAVAILABLE');
    return (await getService(true)).begin(remember);
  });
  handle('restore', async () => {
    const restored = await (await getService(true)).restore();
    if (!restored) await release(false);
    return restored;
  });
  handle('finish', async () => (await getService(false))?.finish() ?? null);
  handle('authorize', async (remote, write, review) =>
    (await getService(false))?.createSession(remote, write, review) ?? null);
  handle('session', async () => (await getService(false))?.getSession() ?? null);
  handle('disconnect', () => release(true));

  const close = () => { void release(false).catch(() => {}); };
  webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) close();
  });
  webContents.on('render-process-gone', close);
  webContents.once('destroyed', close);
}

module.exports = {installEditorGit};
