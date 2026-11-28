const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/**
 * Renames the open project folder (the repository root) when the project is renamed (TurboWarp Plus Editor #681).
 * The renderer opens folders through File System Access handles, so the main process never learns their paths. The
 * user therefore picks the folder in a native dialog, which is the confirmation; the main process renames it only when
 * the picked folder carries the open folder's name. The renderer reopens the folder afterwards, because the old handle
 * no longer resolves.
 */

const messages = {
  en: {
    title: 'Rename the project folder',
    message: (current, next) => `Choose the project folder “${current}” to rename it to “${next}”.`,
    button: 'Rename'
  },
  ja: {
    title: '作品フォルダの名前を変える',
    message: (current, next) => `名前を「${next}」に変える作品フォルダ「${current}」を選んでください。`,
    button: '名前を変える'
  }
};
const strings = locale => messages[/^ja(?:-|$)/iu.test(locale ?? '') ? 'ja' : 'en'];

/**
 * A folder name the project's save name allows: letters, digits, `-`, `_` and `.`, at most 100 characters, not `.`
 * or `..`, without the `.git` suffix. It is the GitHub repository name rule, so the folder and the repository match.
 */
function isFolderName (name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && /^[A-Za-z0-9_.-]+$/u.test(name) &&
    name !== '.' && name !== '..' && !name.toLowerCase().endsWith('.git');
}

/** The name of an open folder as the renderer reports it: one path element. */
function isCurrentName (name) {
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[/\\\u0000-\u001f]/u.test(name) &&
    name !== '.' && name !== '..';
}

/**
 * `dialogs.chooseDirectory({title, message, buttonLabel})` returns the picked path or `null`.
 * `rename(currentName, newName)` returns `{renamed: true, name}` or `{renamed: false, reason}`, where `reason` is
 * `canceled`, `mismatch` (another folder was picked), `exists` (the new name is taken) or `invalid`.
 */
function createProjectFolderRename ({dialogs, locale = () => undefined, home = os.homedir()}) {
  let running = false;
  return {
    async rename (currentName, newName) {
      if (!isCurrentName(currentName) || !isFolderName(newName)) return {renamed: false, reason: 'invalid'};
      if (currentName === newName) return {renamed: true, name: newName};
      if (running) return {renamed: false, reason: 'invalid'};
      running = true;
      try {
        const words = strings(locale());
        const picked = await dialogs.chooseDirectory({
          title: words.title, message: words.message(currentName, newName), buttonLabel: words.button
        });
        if (!picked) return {renamed: false, reason: 'canceled'};
        if (!path.isAbsolute(picked)) return {renamed: false, reason: 'invalid'};
        const folder = await fs.realpath(picked).catch(() => null);
        const stat = folder && await fs.lstat(folder).catch(() => null);
        if (!folder || !stat?.isDirectory()) return {renamed: false, reason: 'invalid'};
        const parent = path.dirname(folder);
        if (parent === folder || folder === path.resolve(home)) return {renamed: false, reason: 'invalid'};
        if (path.basename(folder) !== currentName) return {renamed: false, reason: 'mismatch'};
        const target = path.join(parent, newName);
        const existing = await fs.lstat(target).catch(() => null);
        // On a case-insensitive file system a change of case finds the folder itself.
        if (existing && !(existing.ino === stat.ino && existing.dev === stat.dev)) return {renamed: false, reason: 'exists'};
        await fs.rename(folder, target);
        return {renamed: true, name: newName};
      } finally {
        running = false;
      }
    }
  };
}

module.exports = {createProjectFolderRename, isFolderName};
