const {execFile} = require('node:child_process');
const {tmpdir} = require('node:os');
const {promisify} = require('node:util');

const exec = promisify(execFile);

/** Read the user's default author without looking at the current working tree or launching a credential helper. */
async function readGlobalGitAuthor ({run = exec} = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE)$/iu.test(key) ||
      /^(?:GIT_TRACE|GIT_CONFIG_(?:KEY|VALUE)_)/iu.test(key)) delete env[key];
  }
  try {
    const {stdout} = await run('git', ['config', '--global', '--includes', '--null', '--get-regexp', '^user\\.(name|email)$'], {
      cwd: tmpdir(), env, windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024
    });
    const values = new Map();
    for (const entry of stdout.split('\0')) {
      const separator = entry.indexOf('\n');
      if (separator < 0) continue;
      values.set(entry.slice(0, separator), entry.slice(separator + 1).trim());
    }
    const name = values.get('user.name');
    const email = values.get('user.email');
    if (!name || !email || /[\u0000-\u001f\u007f<>]/u.test(name + email)) return null;
    return {name, email};
  } catch {
    return null;
  }
}

module.exports = {readGlobalGitAuthor};
