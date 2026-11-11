const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {identify} = require('./project-lock');

/**
 * The key the editor keeps the Dockview layout of an SB3 under. It is the hash of the file's canonical path, so the
 * same file opened through another link or letter case finds the same layout, and the path itself stays here.
 */
const workspaceProjectKey = filePath => {
  let key;
  try {
    key = identify(filePath).key;
  } catch {
    key = path.resolve(filePath);
  }
  return createHash('sha256').update(key).digest('hex');
};

/** Earlier versions kept layouts as files here. The editor keeps them in IndexedDB now, so they are removed unread. */
const discardWorkspaceLayouts = dataRoot => {
  try {
    fs.rmSync(path.join(dataRoot, 'workspace-layouts'), {recursive: true, force: true});
  } catch (error) {
    console.error(error.message);
  }
};

module.exports = {workspaceProjectKey, discardWorkspaceLayouts};
