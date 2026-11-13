const path = require('node:path');
const {GitServiceError} = require('./github-auth');
const {isTrustedEditorGitEvent} = require('./editor-ipc');
const {startRepositoryCreation} = require('./repository-creation-service');

const prefix = 'local-git-creation-';

function loadCreationContract (developmentModule, packaged) {
  const override = packaged ? undefined : developmentModule;
  if (override && !path.isAbsolute(override)) return null;
  try {
    const contract = require(override || '@kubohiroya/turbowarp-plus-editor-auth');
    return typeof contract.createRepositoryCreationHost === 'function' &&
      typeof contract.RepositoryCreationError === 'function' ? contract : null;
  } catch {
    return null;
  }
}

function installRepositoryCreation (ipc, webContents, options) {
  let pending = null;
  const enabled = !!options;
  ipc.on(prefix + 'enabled', event => { event.returnValue = enabled && isTrustedEditorGitEvent(event, webContents); });
  if (!enabled) return;

  function service (start) {
    if (!pending && start) {
      const started = startRepositoryCreation(options);
      pending = started;
      void started.catch(() => {
        if (pending === started) pending = null;
      });
    }
    return pending;
  }

  const handle = (name, action) => ipc.handle(prefix + name, async (event, ...args) => {
    if (!isTrustedEditorGitEvent(event, webContents)) throw new Error('GIT_UNAVAILABLE');
    try {
      return await action(...args);
    } catch (error) {
      throw new Error(error instanceof GitServiceError || error instanceof options.contract.RepositoryCreationError ? error.code :
        error?.name === 'AbortError' ? 'ABORTED' : 'GIT_UNAVAILABLE');
    }
  });
  handle('connection', async () => (await service(true)).connection);
  handle('begin', async () => (await service(true)).begin());
  handle('finish', async () => (await service(false))?.finish() ?? null);
  handle('grant', async () => (await service(false))?.getGrant() ?? null);
  handle('initial-push', async (operationId, repositoryId) =>
    (await service(false))?.authorizeInitialPush(operationId, repositoryId) ?? null);
  handle('revoke-initial-push', async (operationId, repositoryId, bearer) =>
    (await service(false))?.revokeInitialPush(operationId, repositoryId, bearer));
  handle('inspect-unknown', async operationId => (await service(false))?.inspectUnknown(operationId) ?? null);
  handle('inspect-operation', async operationId => {
    const instance = await service(false);
    if (!instance) throw new Error('GIT_UNAVAILABLE');
    return instance.inspectCreation(operationId);
  });
  handle('adopt-unknown', async (operationId, repositoryId) =>
    (await service(false))?.adoptUnknown(operationId, repositoryId) ?? null);
  handle('disconnect', async () => (await service(false))?.disconnect());

  const close = () => {
    const previous = pending;
    pending = null;
    void previous?.then(instance => instance.close()).catch(() => {});
  };
  webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) close();
  });
  webContents.on('render-process-gone', close);
  webContents.once('destroyed', close);
}

module.exports = {installRepositoryCreation, loadCreationContract};
