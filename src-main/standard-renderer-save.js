const {createReadStream, promises: fs} = require('node:fs');
const {promisify} = require('node:util');
const yauzl = require('yauzl');

const openZip = promisify(yauzl.open);
// Match the Plus Editor's project.json limit without reading the entire SB3.
const maxMetadataBytes = 32 * 1024 * 1024;
const denialCode = 'STANDARD_RENDERER_SAVE_PROTECTED';

const denial = (message, cause) => Object.assign(new Error(message, {cause}), {code: denialCode});

async function readProject(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxMetadataBytes) throw new Error('Project metadata is too large to inspect.');
    chunks.push(chunk);
  }
  const project = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error('Invalid project metadata.');
  }
  if (Object.keys(project).some(key => key.startsWith('turboWarpPlus'))) return true;

  const storage = project.extensionStorage;
  if (Object.values(storage ?? {}).some(owner => owner?.documentSourceLocations)) return true;
  const documentOwners = [
    storage?.twpeyamlsettings,
    storage?.kubohiroyakamishibairuntime4,
    storage?.kubohiroyakamishibai4?.components?.kubohiroyakamishibairuntime4
  ];
  if (documentOwners.some(owner => owner?.documents || owner?.source || owner?.sourceDocuments)) return true;

  return Array.isArray(project.targets) && project.targets.some(target =>
    Object.values(target?.blocks ?? {}).some(block => {
      const reference = block?.fields?.DOCUMENT?.[0];
      return typeof reference === 'string' && reference.startsWith('tw-embedded-yaml:');
    }));
}

async function inspectZip(filename) {
  const zip = await openZip(filename, {lazyEntries: true, autoClose: false});
  try {
    const {project, hasPlusFiles} = await new Promise((resolve, reject) => {
      let project;
      zip.on('error', reject);
      zip.on('entry', entry => {
        if (/^(extensions|plus-payloads)\/[^/]/.test(entry.fileName)) {
          resolve({hasPlusFiles: true});
          return;
        }
        if (entry.fileName === 'project.json') {
          if (project) {
            reject(new Error('Archive contains multiple project.json entries.'));
            return;
          }
          project = entry;
        }
        zip.readEntry();
      });
      zip.once('end', () => resolve({project, hasPlusFiles: false}));
      zip.readEntry();
    });
    if (hasPlusFiles) return true;
    if (!project || project.uncompressedSize > maxMetadataBytes) {
      throw new Error('Cannot inspect project.json.');
    }
    return await readProject(await promisify(zip.openReadStream.bind(zip))(project));
  } finally {
    zip.close();
  }
}

async function assertStandardRendererCanOverwrite(filename) {
  let before;
  try {
    before = await fs.stat(filename, {bigint: true});
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw denial('The existing file could not be checked. Save to a new file.', error);
  }

  let isPlus;
  try {
    if (!before.isFile()) throw new Error('The save destination is not a regular file.');
    const header = Buffer.alloc(2);
    const file = await fs.open(filename, 'r');
    try {
      await file.read(header, 0, header.length, 0);
    } finally {
      await file.close();
    }
    isPlus = header.toString('ascii') === 'PK' ?
      await inspectZip(filename) : await readProject(createReadStream(filename));
    const after = await fs.stat(filename, {bigint: true});
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('The save destination changed during inspection.');
    }
  } catch (error) {
    throw denial('The existing file could not be checked. Save to a new file.', error);
  }
  if (isPlus) {
    throw denial('The standard editor cannot overwrite a TurboWarp Plus project. Reopen it with the Plus editor or save to a new file.');
  }
}

module.exports = {assertStandardRendererCanOverwrite, denialCode};
