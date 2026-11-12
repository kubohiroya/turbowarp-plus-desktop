const {execFile} = require('node:child_process');
const {mkdtemp, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {promisify} = require('node:util');
const {GitServiceError} = require('./github-auth');

const exec = promisify(execFile);
const credentialFields = new Set(['protocol', 'host', 'path', 'username', 'password']);
const credentialPattern = /^(?:github_pat_|gh[opu]_)[A-Za-z0-9_]{1,1024}$/u;

function readCredential (output, repositoryPath) {
  const fields = new Map();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) break;
    const separator = line.indexOf('=');
    if (separator < 1) return null;
    const name = line.slice(0, separator);
    if (!credentialFields.has(name)) continue;
    if (fields.has(name)) return null;
    fields.set(name, line.slice(separator + 1));
  }
  const password = fields.get('password');
  if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com' ||
      (fields.has('path') && fields.get('path') !== repositoryPath) ||
      !fields.get('username') || !credentialPattern.test(password ?? '')) return null;
  return password;
}

async function runGit (args, input, signal) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'tw-git-credential-'));
  try {
    signal?.throwIfAborted();
    // Use the user's Git configuration outside any project repository.
    const env = {...process.env};
    for (const name of Object.keys(env)) {
      const key = name.toUpperCase();
      if (key.startsWith('GIT_TRACE') || key.startsWith('GCM_TRACE') ||
          ['GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_COMMON_DIR',
            'GIT_WORK_TREE', 'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'SSH_ASKPASS', 'GCM_INTERACTIVE'].includes(key)) delete env[name];
    }
    const pending = exec('git', args, {
      cwd, signal, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
      env: {
        ...env, GIT_DIR: path.join(cwd, '.git'), GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'false', GCM_TRACE: '0', GCM_TRACE_SECRETS: '0'
      }
    });
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(input);
    const {stdout} = await pending;
    return stdout;
  } finally {
    await rm(cwd, {recursive: true, force: true}).catch(() => {});
  }
}

function createGitCredentialHelper ({run = runGit} = {}) {
  function repositoryPath ({owner, repo}) {
    return owner + '/' + repo + '.git';
  }

  return {
    async available (remote, signal) {
      try {
        const helper = await run(['config', '--get-urlmatch', 'credential.helper',
          'https://github.com/' + repositoryPath(remote)], undefined, signal);
        signal?.throwIfAborted();
        return helper.trim() !== '';
      } catch {
        signal?.throwIfAborted();
        return false;
      }
    },
    async read (remote, login, signal) {
      const repoPath = repositoryPath(remote);
      const input = ['protocol=https', 'host=github.com', 'path=' + repoPath, 'username=' + login, '', ''].join('\n');
      let token;
      try {
        const output = await run(['-c', 'core.askPass=', '-c', 'credential.interactive=false',
          'credential', 'fill'], input, signal);
        signal.throwIfAborted();
        token = readCredential(output, repoPath);
      } catch {
        signal.throwIfAborted();
      }
      if (!token) throw new GitServiceError(401, 'REAUTH_REQUIRED');
      return token;
    }
  };
}

module.exports = {createGitCredentialHelper};
