const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const maximum = 256 * 1024;
const limit = 100;
const validKey = key => typeof key === 'string' && /^[0-9a-f]{64}$/u.test(key);
const validLayout = layout => typeof layout === 'string' && Buffer.byteLength(layout, 'utf8') <= maximum;

function createDockviewLayoutStore (root) {
  const directory = path.join(root, 'dockview-layouts');
  const fileFor = key => {
    if (!validKey(key)) throw new Error('Invalid workspace key.');
    return path.join(directory, key + '.json');
  };
  // When the layout last changed. Reading a layout moves its modification time, which orders the least recently
  // used projects, so the save time is kept beside it. Layouts saved by earlier versions have none.
  const timeFileFor = file => file.slice(0, -'.json'.length) + '.saved-at';

  function replace (file, contents) {
    const temporary = file + '.' + randomUUID();
    try {
      fs.writeFileSync(temporary, contents, {flag: 'wx', mode: 0o600});
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, {force: true});
    }
  }

  function readSavedAt (file) {
    try {
      const savedAt = Number(fs.readFileSync(timeFileFor(file), 'utf8'));
      return Number.isSafeInteger(savedAt) && savedAt > 0 ? savedAt : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function read (key) {
    const file = fileFor(key);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > maximum) return null;
      const layout = fs.readFileSync(file, 'utf8');
      fs.utimesSync(file, stat.atime, new Date());
      return layout;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** The layout with the time it last changed, in milliseconds since the epoch, or `null` without a layout. */
  function readRecord (key) {
    const layout = read(key);
    if (layout === null) return null;
    const savedAt = readSavedAt(fileFor(key));
    return savedAt === null ? {layout} : {layout, savedAt};
  }

  /**
   * Saves the layout and returns when it last changed, or `true` for an unchanged layout saved by an earlier version.
   * Returns `false` for a layout that is too large.
   */
  function write (key, layout, now = Date.now()) {
    if (!validLayout(layout)) return false;
    const file = fileFor(key);
    const previous = read(key);
    if (previous === layout) return readSavedAt(file) ?? true;
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    replace(file, layout);
    replace(timeFileFor(file), String(now));
    if (previous === null) {
      const others = fs.readdirSync(directory, {withFileTypes: true})
        .filter(entry => entry.isFile() && entry.name.endsWith('.json') && validKey(entry.name.slice(0, -5)))
        .map(entry => path.join(directory, entry.name))
        .filter(entry => entry !== file);
      if (others.length >= limit) {
        const oldest = others.map(file => ({file, used: fs.statSync(file).mtimeMs}))
          .sort((a, b) => b.used - a.used).slice(limit - 1);
        for (const entry of oldest) {
          fs.rmSync(entry.file, {force: true});
          fs.rmSync(timeFileFor(entry.file), {force: true});
        }
      }
    }
    return now;
  }

  return {read, readRecord, write};
}

module.exports = {createDockviewLayoutStore, validDockviewLayout: validLayout, validDockviewKey: validKey};
