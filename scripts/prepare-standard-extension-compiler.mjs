import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync, realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Arch} from 'electron-builder';
import payloadTools from '../src-main/standard-extension-payload.js';

const desktop = path.resolve(import.meta.dirname, '..');
const toolchain = '@kubohiroya/sb3-toolchain';
const manifest = '@kubohiroya/turbowarp-extension-manifest';

function packageDirectory (name, from) {
  const resolve = createRequire(path.join(from, 'package.json')).resolve;
  const location = resolve.paths(name).map(dir => path.join(dir, name))
    .find(dir => existsSync(path.join(dir, 'package.json')));
  if (!location) throw new Error('Missing installed compiler package ' + name);
  return realpathSync(location);
}

async function prepare (arch) {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('Unsupported macOS compiler architecture');
  const target = path.join(desktop, 'dist-standard-extension-compiler', arch);
  const root = packageDirectory(toolchain, desktop);
  const packageJSON = async dir => JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const config = await packageJSON(root);
  const desktopConfig = await packageJSON(desktop);
  const dependencyLock = JSON.parse(await readFile(path.join(desktop, 'package-lock.json'), 'utf8'));
  const packages = {};
  const record = (name, version) => {
    const entries = Object.entries(dependencyLock.packages).filter(([file, entry]) =>
      file.endsWith('node_modules/' + name) && entry.version === version).map(([, entry]) => entry);
    const integrities = new Set(entries.map(entry => entry.integrity));
    if (integrities.size !== 1 || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entries[0]?.integrity)) throw new Error('Missing pinned compiler integrity for ' + name);
    packages[name] = {version, integrity: entries[0].integrity};
  };
  if (config.version !== desktopConfig.devDependencies[toolchain]) throw new Error('Compiler pin differs from the install');

  await rm(target, {recursive: true, force: true});
  const modules = path.join(target, 'node_modules');
  const installed = new Map();
  const install = async (name, source, requiredVersion) => {
    const directory = packageDirectory(name, source);
    const pkg = await packageJSON(directory);
    if ((requiredVersion && pkg.version !== requiredVersion) || (installed.has(name) && installed.get(name) !== pkg.version)) {
      throw new Error('Unexpected compiler dependency version for ' + name);
    }
    if (installed.has(name)) return;
    installed.set(name, pkg.version);
    record(name, pkg.version);
    await mkdir(path.dirname(path.join(modules, name)), {recursive: true});
    await cp(directory, path.join(modules, name), {
      recursive: true, filter: file => file === directory || !path.relative(directory, file).split(path.sep).includes('node_modules')
    });
    for (const dependency of Object.keys(pkg.dependencies ?? {})) await install(dependency, directory);
  };
  try {
    const localToolchain = path.join(modules, toolchain);
    await mkdir(path.join(localToolchain, 'dist'), {recursive: true});
    record(toolchain, config.version);
    for (const file of ['package.json', 'LICENSE', 'dist']) await cp(path.join(root, file), path.join(localToolchain, file), {recursive: true});
    await install(manifest, root, config.dependencies[manifest]);
    if (config.dependencies['@noble/hashes']) await install('@noble/hashes', root, config.dependencies['@noble/hashes']);
    await install('rolldown', root, config.dependencies.rolldown);
    await install('@rolldown/binding-darwin-' + arch, packageDirectory('rolldown', root), config.dependencies.rolldown);
    await cp(path.join(desktop, 'src-main/standard-extension-worker.mjs'), path.join(target, 'worker.mjs'));
    const observed = payloadTools.inspectPayload(target);
    await writeFile(path.join(target, 'compiler-lock.json'), JSON.stringify({
      formatVersion: 1, recipe: 'turbowarp-standard-worker-v1', platform: 'darwin', arch,
      electronVersion: dependencyLock.packages['node_modules/electron'].version, packages, ...observed
    }) + '\n');
  } catch (error) {
    await rm(target, {recursive: true, force: true});
    throw error;
  }
}

export default async function beforePack ({electronPlatformName, arch, targets}) {
  if (electronPlatformName !== 'darwin' || targets.some(target => target.name === 'mas' || target.name === 'mas-dev')) return;
  await prepare(Arch[arch]);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.platform === 'darwin') await prepare(process.arch);
