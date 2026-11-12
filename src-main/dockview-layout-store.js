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

  function write (key, layout) {
    if (!validLayout(layout)) return false;
    const file = fileFor(key);
    const previous = read(key);
    if (previous === layout) return true;
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const temporary = file + '.' + randomUUID();
    try {
      fs.writeFileSync(temporary, layout, {flag: 'wx', mode: 0o600});
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, {force: true});
    }
    if (previous === null) {
      const others = fs.readdirSync(directory, {withFileTypes: true})
        .filter(entry => entry.isFile() && entry.name.endsWith('.json') && validKey(entry.name.slice(0, -5)))
        .map(entry => path.join(directory, entry.name))
        .filter(entry => entry !== file);
      if (others.length >= limit) {
        const oldest = others.map(file => ({file, used: fs.statSync(file).mtimeMs}))
          .sort((a, b) => b.used - a.used).slice(limit - 1);
        for (const entry of oldest) fs.rmSync(entry.file, {force: true});
      }
    }
    return true;
  }

  return {read, write};
}

module.exports = {createDockviewLayoutStore, validDockviewLayout: validLayout, validDockviewKey: validKey};
