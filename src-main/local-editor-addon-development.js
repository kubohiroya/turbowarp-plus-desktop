const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {parse} = require('postcss');
const {openDirectory, readDevelopmentFile} = require('./local-extension-development');

const cssPath = /^(?:[a-z\d_-][a-z\d_.-]*\/)*[a-z\d_-][a-z\d_.-]*\.css$/iu;
const scriptPath = /^(?:[a-z\d_-][a-z\d_.-]*\/)*[a-z\d_-][a-z\d_.-]*\.m?js$/iu;
const addonId = /^(?:@[a-z\d_-]+\/)?[a-z\d][a-z\d_.-]{0,100}$/u;
const editorDocument = 'tw-editor://./plus-gui/gui.html';
const isEditorDocument = url => url?.split(/[?#]/u, 1)[0] === editorDocument;
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
  let scripts;
  let activation = 'live';
  let defaults = [];
  const permissions = manifest.turbowarpPlusEditor?.addon?.permissions ?? [];
  if (!Array.isArray(permissions) || permissions.some(permission =>
    permission !== 'workspace.viewport' && (!turbo || permission !== 'paint.clipboard-offset'))) {
    return {...row, unavailable: 'LOCAL_ADDON_RUNTIME_UNSUPPORTED'};
  }
  const paintClipboard = permissions.includes('paint.clipboard-offset');
  const viewport = permissions.includes('workspace.viewport');
  if (turbo) {
    const supportedEntries = entries => Array.isArray(entries) && entries.every(entry =>
      entry && entry.if === undefined && (entry.matches === undefined || (Array.isArray(entry.matches) &&
        entry.matches.length && entry.matches.every(pattern => editorPatterns.has(pattern)))));
    if (!supportedEntries(manifest.userstyles ?? []) || !supportedEntries(manifest.userscripts ?? [])) {
      return {...row, unavailable: 'LOCAL_ADDON_RUNTIME_UNSUPPORTED'};
    }
    styles = (manifest.userstyles ?? []).map(style => style.url);
    scripts = (manifest.userscripts ?? []).map(script => script.url);
    if (manifest.dynamicEnable === false || manifest.dynamicDisable === false) activation = 'startup';
    if (Array.isArray(manifest.settings)) {
      defaults = manifest.settings.filter(setting => typeof setting?.id === 'string' &&
        /^[a-z\d_-]{1,80}$/iu.test(setting.id) &&
        ['boolean', 'number', 'string'].includes(typeof setting.default)).map(setting => [setting.id, setting.default]);
    }
  } else {
    const addon = manifest.turbowarpPlusEditor?.addon;
    if (!addon || (addon.activation !== undefined && !['live', 'startup'].includes(addon.activation)) ||
        (addon.styles !== undefined && (!Array.isArray(addon.styles) || addon.styles.length > 1))) {
      return {...row, unavailable: 'LOCAL_ADDON_RUNTIME_UNSUPPORTED'};
    }
    activation = addon.activation ?? 'live';
    styles = addon.styles ?? [];
    scripts = addon.entry === undefined ? [] : [addon.entry];
  }
  if (!styles.length && !scripts.length) return {...row, unavailable: 'LOCAL_ADDON_RUNTIME_UNSUPPORTED'};
  if (styles.length > 8 || scripts.length > 4 || styles.some(name => typeof name !== 'string' || !cssPath.test(name)) ||
      scripts.some(name => typeof name !== 'string' || !scriptPath.test(name))) throw error('LOCAL_ADDON_MANIFEST');
  const inputs = [...styles.map(name => [name, 256 * 1024]), ...scripts.map(name => [name, 512 * 1024])];
  const readInputs = () => Promise.all(inputs.map(([name, limit]) => readAddonFile(path.join(root, name), limit)));
  const files = await readInputs();
  const css = files.slice(0, styles.length).map(contents => validateStylesheet(decode(contents))).join('\n');
  const sources = files.slice(styles.length).map(decode);
  const [currentManifest, current] = await Promise.all([readAddonFile(file, 65536), readInputs()]);
  await verifyRoot(directory);
  if (!bytes.equals(currentManifest) || files.some((contents, index) => !contents.equals(current[index]))) {
    throw error('LOCAL_ADDON_INCOMPLETE');
  }
  const digest = createHash('sha256').update(JSON.stringify([decode(bytes), css, sources])).digest('hex');
  if ((paintClipboard || viewport) && !sources.length) return {...row, unavailable: 'LOCAL_ADDON_RUNTIME_UNSUPPORTED'};
  return {...row, activation, defaults, css, sources, digest, paintClipboard, viewport};
}

function installLocalEditorAddonDevelopment (ipc, webContents, {chooseDirectory, confirm, intervalMs = 500}) {
  const sessions = new Map();
  const waiting = new Map();
  let opening = false;
  let generation = 0;
  let queue = Promise.resolve();
  let timer;
  let resume = false;
  const activeFrame = event => event.sender === webContents && event.senderFrame === webContents.mainFrame &&
    isEditorDocument(event.senderFrame?.url);
  const currentDigest = session => session.applied ? session.lastGood?.digest : null;
  const needsReload = session => session.activation === 'startup' &&
    (session.enabled ? currentDigest(session) !== session.nextDigest : session.applied);
  const list = () => Array.from(sessions.values(), session => {
    const {token, directory, id, format, metadata, enabled, failure, unavailable, activation, removing} = session;
    return {token, directory: directory.root, id, format, metadata, enabled, error: failure ?? unavailable, unavailable,
      activation, removing, appliedDigest: currentDigest(session), reloadRequired: needsReload(session)};
  });
  const readFailure = cause => cause.code?.startsWith('LOCAL_ADDON_') ? cause.code : 'LOCAL_ADDON_INCOMPLETE';
  const publish = () => { if (!webContents.isDestroyed()) webContents.send('local-editor-addon-change', list()); };
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const live = (session, epoch) => generation === epoch && sessions.get(session.token) === session;
  const runtime = message => {
    if (!webContents.isDestroyed()) webContents.send('local-editor-addon-runtime', message);
  };
  const prepare = (session, build, runtimeId, startup) => new Promise((resolve, reject) => {
    const finish = success => {
      clearTimeout(timeout);
      waiting.delete(runtimeId);
      if (success) resolve();
      else reject(error('LOCAL_ADDON_RUNTIME_FAILED'));
    };
    const timeout = setTimeout(() => finish(false), 5000);
    waiting.set(runtimeId, finish);
    runtime({type: 'prepare', runtimeId, token: session.token, format: session.format, id: session.id,
      defaults: build.defaults, sources: build.sources, startup: startup && build.activation === 'startup',
      paintClipboard: build.paintClipboard, viewport: build.viewport});
  });
  const apply = async (session, build, epoch, startup = false) => {
    const runtimeId = build.sources.length ? randomUUID() : null;
    let key = null;
    let accepted = false;
    try {
      if (runtimeId) await prepare(session, build, runtimeId, startup);
      if (!live(session, epoch)) return;
      if (build.css) key = await webContents.insertCSS(build.css, {cssOrigin: 'author'});
      if (!live(session, epoch)) return;
      if (session.key) await webContents.removeInsertedCSS(session.key);
      if (!live(session, epoch)) return;
      if (runtimeId) runtime({type: 'accept', runtimeId, token: session.token});
      else if (session.runtimeId) runtime({type: 'remove', token: session.token});
      Object.assign(session, {key, runtimeId, lastGood: build, nextDigest: build.digest,
        metadata: build.metadata, applied: true, failure: null});
      accepted = true;
    } finally {
      if (!accepted && runtimeId) runtime({type: 'discard', runtimeId});
      if (!accepted && key && !webContents.isDestroyed()) await webContents.removeInsertedCSS(key).catch(() => {});
    }
  };
  const unload = async session => {
    if (session.key) await webContents.removeInsertedCSS(session.key);
    if (session.runtimeId) runtime({type: 'remove', token: session.token});
    Object.assign(session, {key: null, runtimeId: null, applied: false, pending: null, failure: null});
  };
  const compatible = async session => {
    const build = await readEditorAddon(session.directory);
    if (build.id !== session.id || build.format !== session.format || build.unavailable ||
        build.activation !== session.activation || (build.sources.length > 0 && !session.permitsScripts) ||
        (build.paintClipboard && !session.permitsPaintClipboard) ||
        (build.viewport && !session.permitsViewport)) throw error('LOCAL_ADDON_CHANGED');
    return build;
  };
  const update = async epoch => {
    for (const session of sessions.values()) {
      if (generation !== epoch) return;
      if (!session.enabled) continue;
      try {
        const build = await compatible(session);
        if (!live(session, epoch)) return;
        if (session.activation === 'startup' && session.nextDigest === build.digest) {
          session.pending = null;
          if (session.failure && session.failure !== 'LOCAL_ADDON_RUNTIME_FAILED') {
            session.failure = null;
            publish();
          }
          continue;
        }
        if (currentDigest(session) === build.digest) {
          session.pending = null;
          if (session.failure || session.nextDigest !== build.digest) {
            Object.assign(session, {failure: null, nextDigest: build.digest});
            publish();
          }
          continue;
        }
        if (session.pending !== build.digest) { session.pending = build.digest; continue; }
        if (session.activation === 'startup') Object.assign(session, {nextDigest: build.digest, failure: null});
        else await apply(session, build, epoch);
        if (live(session, epoch)) publish();
      } catch (cause) {
        session.pending = null;
        if (!live(session, epoch)) return;
        const failure = readFailure(cause);
        if (session.failure !== failure) { session.failure = failure; publish(); }
      }
    }
  };
  const schedule = () => {
    if (resume || timer || !Array.from(sessions.values()).some(session => session.enabled)) return;
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
  handle('prepared', (runtimeId, success) => waiting.get(runtimeId)?.(success === true));
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
      if (!build.unavailable && !(await confirm(directory.root, build.id, {
        scripts: build.sources.length > 0, activation: build.activation, paintClipboard: build.paintClipboard,
        viewport: build.viewport
      }))) return;
      if (generation !== epoch) return;
      await serial(async () => {
        if (generation !== epoch) return;
        const {id, format, metadata, unavailable, activation} = build;
        const session = {token: randomUUID(), directory, id, format, metadata, unavailable, activation,
          enabled: !unavailable, applied: false, nextDigest: build.digest ?? null,
          permitsScripts: Boolean(build.sources?.length), permitsPaintClipboard: build.paintClipboard,
          permitsViewport: build.viewport};
        sessions.set(session.token, session);
        try {
          if (session.enabled && activation === 'live') await apply(session, build, epoch);
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
      if (!session || generation !== epoch || session.unavailable || session.removing ||
          typeof enabled !== 'boolean' || session.enabled === enabled) return;
      if (enabled) {
        const build = await compatible(session);
        if (!live(session, epoch)) return;
        if (session.activation === 'live') await apply(session, build, epoch);
        else Object.assign(session, {nextDigest: build.digest, failure: null});
      } else if (session.activation === 'live') {
        await unload(session);
      }
      if (live(session, epoch)) { session.enabled = enabled; publish(); schedule(); }
    });
  });
  handle('remove', token => {
    const epoch = generation;
    return serial(async () => {
      const session = sessions.get(token);
      if (!session || generation !== epoch) return;
      if (session.activation === 'startup' && session.applied) {
        Object.assign(session, {enabled: false, removing: true, pending: null});
        publish();
      } else {
        await unload(session);
        if (live(session, epoch)) { sessions.delete(token); publish(); }
      }
    });
  });
  handle('ready', () => {
    const epoch = generation;
    return serial(async () => {
      if (generation !== epoch || !resume) return;
      for (const session of sessions.values()) {
        if (generation !== epoch) return;
        if (!session.enabled) continue;
        let attemptedDigest;
        try {
          const build = await compatible(session);
          if (!live(session, epoch)) return;
          attemptedDigest = session.nextDigest = build.digest;
          await apply(session, build, epoch, true);
        } catch (cause) {
          if (!live(session, epoch)) return;
          const {lastGood, nextDigest} = session;
          if (lastGood && lastGood.digest !== attemptedDigest) {
            try { await apply(session, lastGood, epoch, true); }
            catch { /* The build could not be restored in the replacement renderer. */ }
          }
          if (live(session, epoch)) Object.assign(session, {nextDigest, failure: readFailure(cause)});
        }
      }
      if (generation === epoch) { resume = false; publish(); schedule(); }
    });
  });
  const reset = (keep = false) => {
    generation++;
    resume = keep;
    for (const finish of waiting.values()) finish(false);
    runtime({type: 'reset'});
    clearTimeout(timer);
    timer = null;
    for (const [token, session] of sessions) {
      if (session.key && !webContents.isDestroyed()) void webContents.removeInsertedCSS(session.key).catch(() => {});
      if (!keep || session.removing) sessions.delete(token);
      else Object.assign(session, {key: null, runtimeId: null, applied: false, pending: null});
    }
  };
  webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) {
      reset(isEditorDocument(webContents.mainFrame?.url) && isEditorDocument(details.url));
    }
  });
  webContents.on('render-process-gone', () => reset());
  webContents.once('destroyed', () => reset());
}

module.exports = {installLocalEditorAddonDevelopment, readEditorAddon};
