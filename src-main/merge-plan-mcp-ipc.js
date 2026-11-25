const {randomUUID} = require('node:crypto');
const {openMergePlanMcp} = require('./merge-plan-mcp');
const {isTrustedEditorGitEvent: isTrustedEditorEvent} = require('./local-git/editor-ipc');

/** The main frame owns the journal. Requests can only reach the frame that authorized this connection. */
function installMergePlanMcp (ipc, webContents, confirm) {
  let share;
  let attempt;
  const pending = new Map();
  const trusted = event => isTrustedEditorEvent(event, webContents);

  function revoke () {
    attempt = undefined;
    share?.close();
    share = undefined;
    for (const finish of pending.values()) finish(false);
  }

  function read (tool, args) {
    if (!share || pending.size >= 8) throw new Error('The project is unavailable or busy.');
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => finish(false), 5000);
      function finish (ok, result) {
        clearTimeout(timer);
        pending.delete(requestId);
        if (ok) resolve(result);
        else reject(new Error(typeof result === 'string' ? result.slice(0, 200) : 'The project is unavailable.'));
      }
      pending.set(requestId, finish);
      try {
        webContents.mainFrame.send('merge-plan-mcp-read', requestId, tool, args);
      } catch {
        finish(false);
      }
    });
  }

  ipc.on('merge-plan-mcp-enabled', event => { event.returnValue = trusted(event); });
  ipc.handle('merge-plan-mcp-start', async (event, project) => {
    if (!trusted(event)) throw new Error('The editor is unavailable.');
    if (share || attempt) throw new Error('The window already has a merge plan share.');
    if (typeof project?.repository !== 'string' || !project.repository || project.repository.length > 255 ||
        typeof project.folder !== 'string' || project.folder.length > 4096) throw new Error('Invalid project.');
    const current = attempt = Symbol();
    try {
      if (!await confirm(project) || attempt !== current) return null;
      const connection = await openMergePlanMcp(read);
      if (attempt !== current) {
        connection.close();
        return null;
      }
      share = connection;
      return {url: share.url, token: share.token};
    } finally {
      if (attempt === current) attempt = undefined;
    }
  });
  ipc.handle('merge-plan-mcp-stop', (event, token) => {
    if (trusted(event) && share?.token === token) revoke();
  });
  ipc.on('merge-plan-mcp-result', (event, requestId, ok, result) => {
    if (trusted(event)) pending.get(requestId)?.(ok === true, result);
  });
  webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) revoke();
  });
  webContents.on('render-process-gone', revoke);
  webContents.once('destroyed', revoke);
}

module.exports = {installMergePlanMcp};
