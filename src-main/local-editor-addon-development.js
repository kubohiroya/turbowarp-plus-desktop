const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {parse} = require('postcss');
const {openDirectory, readDevelopmentFile} = require('./local-extension-development');

const cssPath = /^(?:[a-z\d_-][a-z\d_.-]*\/)*[a-z\d_-][a-z\d_.-]*\.css$/iu;
const addonId = /^(?:@[a-z\d_-]+\/)?[a-z\d][a-z\d_.-]{0,100}$/u;
const editorPatterns = new Set(['projects', 'https://scratch.mit.edu/projects/*']);
const allowedAtRules = new Set(['media', 'supports', 'layer', 'container', 'keyframes', 'starting-style']);
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const error = code => Object.assign(new Error(code), {code});
const decode = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes);
const readAddonFile = (file, limit) => readDevelopmentFile(file, limit).catch(cause => {
  if (cause.code === 'LOCAL_EXTENSION_BOUNDARY') throw error('LOCAL_ADDON_BOUNDARY');
  throw cause;
});
const optionalFile = (file, limit) => readAddonFile(file, limit).catch(cause => {
  if (cause.code === 'ENOENT') return null;
  throw cause;
});

const verifyRoot = async ({root, identity}) => {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.ino !== identity.ino || stat.dev !== identity.dev || await fs.realpath(root) !== root) {
    throw error('LOCAL_ADDON_BOUNDARY');
  }
};

function validateStylesheet (css) {
  // The development profile has no resource URLs. Deny escapes and resource-loading syntax
  // before handing the stylesheet to Chromium, including in conditional rules and variables.
  if (/[\\\0]/u.test(css) || /\b(?:url|src|image|image-set|paint)\s*\(/iu.test(css)) {
    throw error('LOCAL_ADDON_STYLE_UNSUPPORTED');
  }
  let stylesheet;
  try { stylesheet = parse(css); }
  catch { throw error('LOCAL_ADDON_INCOMPLETE'); }
  if (!stylesheet.nodes.some(node => node.type === 'rule' || node.type === 'atrule')) throw error('LOCAL_ADDON_INCOMPLETE');
  stylesheet.walkAtRules(rule => {
    if (!allowedAtRules.has(rule.name.toLowerCase())) throw error('LOCAL_ADDON_STYLE_UNSUPPORTED');
  });
  return css;
}

async function readEditorAddon (directory) {
  await verifyRoot(directory);
  const {root} = directory;
  const turboFile = path.join(root, 'addon.json');
  const turbo = await optionalFile(turboFile, 65536);
  const file = turbo ? turboFile : path.join(root, 'package.json');
  const bytes = turbo ?? await readAddonFile(file, 65536);
  const manifest = JSON.parse(decode(bytes));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw error('LOCAL_ADDON_MANIFEST');
  const id = turbo ? manifest.id ?? path.basename(root) : manifest.name;
  if (typeof id !== 'string' || !addonId.test(id)) throw error('LOCAL_ADDON_MANIFEST');
  const metadata = {
    name: text(turbo ? manifest.name : manifest.displayName ?? manifest.name, 160),
    description: text(manifest.description, 800),
    version: text(manifest.version, 60),
    author: text(typeof manifest.author === 'object' ? manifest.author?.name : manifest.author, 160)
  };
  const format = turbo ? 'turbowarp' : 'plus';
  const row = {id, metadata, format};
  let styles;
  if (turbo) {
    if ((manifest.userscripts !== undefined && (!Array.isArray(manifest.userscripts) || manifest.userscripts.length)) ||
        !Array.isArray(manifest.userstyles) || manifest.userstyles.some(style =>
      !style || style.if !== undefined || (style.matches !== undefined && (!Array.isArray(style.matches) ||
        !style.matches.length || style.matches.some(pattern => !editorPatterns.has(pattern)))))) {
      return {...row, unavailable: 'LOCAL_ADDON_RUNTIME_UNSUPPORTED'};
    }
    styles = manifest.userstyles.map(style => style.url);
  } else {
    const addon = manifest.turbowarpPlusEditor?.addon;
    if (!addon || addon.entry !== undefined || !Array.isArray(addon.styles) || addon.styles.length !== 1) {
      return {...row, unavailable: 'LOCAL_ADDON_RUNTIME_UNSUPPORTED'};
    }
    styles = addon.styles;
  }
  if (!styles.length || styles.length > 8 || styles.some(name => typeof name !== 'string' || !cssPath.test(name))) {
    throw error('LOCAL_ADDON_MANIFEST');
  }
  const paths = styles.map(name => path.join(root, name));
  const files = await Promise.all(paths.map(name => readAddonFile(name, 256 * 1024)));
  const css = files.map(contents => validateStylesheet(decode(contents))).join('\n');
  const current = await Promise.all([readAddonFile(file, 65536), ...paths.map(name => readAddonFile(name, 256 * 1024))]);
  await verifyRoot(directory);
  if (!bytes.equals(current[0]) || files.some((contents, index) => !contents.equals(current[index + 1]))) {
    throw error('LOCAL_ADDON_INCOMPLETE');
  }
  const digest = createHash('sha256').update(JSON.stringify([decode(bytes), css])).digest('hex');
  return {...row, css, digest};
}

function installLocalEditorAddonDevelopment (ipc, webContents, {chooseDirectory, confirm, intervalMs = 500}) {
  const sessions = new Map();
  let opening = false;
  let generation = 0;
  let queue = Promise.resolve();
  let timer;
  const activeFrame = event => event.sender === webContents && event.senderFrame === webContents.mainFrame &&
    event.senderFrame?.url?.split(/[?#]/u, 1)[0] === 'tw-editor://./plus-gui/gui.html';
  const list = () => Array.from(sessions.values(), ({token, directory, id, format, metadata, enabled, failure, unavailable}) =>
    ({token, directory: directory.root, id, format, metadata, enabled, error: failure ?? unavailable, unavailable}));
  const publish = () => { if (!webContents.isDestroyed()) webContents.send('local-editor-addon-change', list()); };
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const live = (session, epoch) => generation === epoch && sessions.get(session.token) === session;
  const apply = async (session, build, epoch) => {
    const key = await webContents.insertCSS(build.css, {cssOrigin: 'author'});
    try {
      if (!live(session, epoch)) return;
      if (session.key) await webContents.removeInsertedCSS(session.key);
      if (!live(session, epoch)) return;
      Object.assign(session, {key, digest: build.digest, metadata: build.metadata, enabled: true, failure: null});
    } finally {
      if (session.key !== key && !webContents.isDestroyed()) await webContents.removeInsertedCSS(key).catch(() => {});
    }
  };
  const compatible = async session => {
    const build = await readEditorAddon(session.directory);
    if (build.id !== session.id || build.format !== session.format || build.unavailable) throw error('LOCAL_ADDON_CHANGED');
    return build;
  };
  const update = async epoch => {
    for (const session of sessions.values()) {
      if (generation !== epoch) return;
      if (!session.enabled) continue;
      try {
        const build = await compatible(session);
        if (!live(session, epoch)) return;
        if (session.digest === build.digest) {
          session.pending = null;
          if (session.failure) { session.failure = null; publish(); }
          continue;
        }
        if (session.pending !== build.digest) { session.pending = build.digest; continue; }
        await apply(session, build, epoch);
        if (live(session, epoch)) publish();
      } catch (cause) {
        session.pending = null;
        if (!live(session, epoch)) return;
        const failure = cause.code?.startsWith('LOCAL_ADDON_') ? cause.code : 'LOCAL_ADDON_INCOMPLETE';
        if (session.failure !== failure) { session.failure = failure; publish(); }
      }
    }
  };
  const schedule = () => {
    if (timer || !Array.from(sessions.values()).some(session => session.enabled)) return;
    const epoch = generation;
    timer = setTimeout(() => {
      timer = null;
      void serial(() => update(epoch)).finally(schedule);
    }, intervalMs);
    timer.unref();
  };
  const handle = (name, operation) => ipc.handle(`local-editor-addon-${name}`, (event, ...args) => {
    if (!activeFrame(event)) throw error('LOCAL_ADDON_UNAVAILABLE');
    return operation(...args);
  });
  ipc.on('local-editor-addon-enabled', event => { event.returnValue = activeFrame(event); });
  handle('list', list);
  handle('start', async () => {
    if (opening) return;
    opening = true;
    const epoch = generation;
    try {
      const selected = await chooseDirectory();
      if (!selected || generation !== epoch) return;
      const directory = await openDirectory(selected);
      const build = await readEditorAddon(directory);
      if (Array.from(sessions.values()).some(item => item.id === build.id || item.directory.root === directory.root)) {
        throw error('LOCAL_ADDON_DUPLICATE');
      }
      if (!build.unavailable && !(await confirm(directory.root, build.id))) return;
      if (generation !== epoch) return;
      await serial(async () => {
        if (generation !== epoch) return;
        const {id, format, metadata, unavailable} = build;
        const session = {token: randomUUID(), directory, id, format, metadata, unavailable, enabled: false};
        sessions.set(session.token, session);
        try {
          if (!unavailable) await apply(session, build, epoch);
        } catch (cause) {
          sessions.delete(session.token);
          throw cause;
        }
        if (live(session, epoch)) { publish(); schedule(); }
      });
    } finally { opening = false; }
  });
  handle('set-enabled', (token, enabled) => {
    const epoch = generation;
    return serial(async () => {
      const session = sessions.get(token);
      if (!session || generation !== epoch || session.unavailable || typeof enabled !== 'boolean' || session.enabled === enabled) return;
      if (enabled) {
        const build = await compatible(session);
        if (!live(session, epoch)) return;
        await apply(session, build, epoch);
      } else {
        await webContents.removeInsertedCSS(session.key);
        Object.assign(session, {key: null, enabled: false, pending: null, failure: null});
      }
      if (live(session, epoch)) { publish(); schedule(); }
    });
  });
  handle('remove', token => {
    const epoch = generation;
    return serial(async () => {
      const session = sessions.get(token);
      if (!session || generation !== epoch) return;
      if (session.key) await webContents.removeInsertedCSS(session.key);
      if (live(session, epoch)) { sessions.delete(token); publish(); }
    });
  });
  const reset = () => {
    generation++;
    clearTimeout(timer);
    timer = null;
    const active = Array.from(sessions.values());
    sessions.clear();
    if (!webContents.isDestroyed()) for (const {key} of active) {
      if (key) void webContents.removeInsertedCSS(key).catch(() => {});
    }
  };
  webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) reset(); });
  webContents.on('render-process-gone', reset);
  webContents.once('destroyed', reset);
}

module.exports = {installLocalEditorAddonDevelopment, readEditorAddon};
