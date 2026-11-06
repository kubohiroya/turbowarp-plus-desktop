const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const maximum = 1024 * 1024;

function filename (root, key) {
  const id = createHash('sha256').update(key).digest('hex');
  return path.join(root, 'workspace-layouts', id + '.json');
}

function readWorkspaceLayout (root, key) {
  const file = filename(root, key);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maximum) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeWorkspaceLayout (root, key, raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maximum) return;
  const file = filename(root, key);
  const previous = readWorkspaceLayout(root, key);
  if (previous === raw) return;
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = file + '.' + randomUUID();
  try {
    fs.writeFileSync(temporary, raw, {flag: 'wx', mode: 0o600});
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, {force: true});
  }
}

module.exports = {readWorkspaceLayout, writeWorkspaceLayout};
