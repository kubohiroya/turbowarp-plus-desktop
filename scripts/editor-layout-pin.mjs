import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

export const layoutPackage = '@kubohiroya/turbowarp-plus-editor-layout';
const registryTarball = version =>
  `https://registry.npmjs.org/${layoutPackage}/-/turbowarp-plus-editor-layout-${version}.tgz`;

/**
 * Resolve the Layout release the pinned Editor adopts from its manifest and lockfile, the way the
 * Editor's own `scripts/site/source.ts` checks its other family packages. Layout is not a
 * `site/source.json` pin: the Editor fixes it as an exact npm version with its SHA-512 integrity.
 */
export function resolveEditorLayout ({manifest, lock}) {
  const specified = {...manifest.dependencies, ...manifest.devDependencies}[layoutPackage];
  const root = lock.packages?.[''] || {};
  const locked = {...root.dependencies, ...root.devDependencies}[layoutPackage];
  const entry = lock.packages?.[`node_modules/${layoutPackage}`];
  assert.ok(specified, `The Editor does not depend on ${layoutPackage}`);
  assert.ok(entry, `The Editor lockfile does not contain ${layoutPackage}`);
  assert.equal(locked, specified, 'Layout root lock differs from the Editor manifest');
  assert.match(entry.integrity || '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Layout lock must carry a SHA-512 integrity');
  if (entry.resolved?.startsWith('https://registry.npmjs.org/')) {
    assert.equal(specified, entry.version, 'The Editor must pin the exact npm Layout version');
    assert.equal(entry.resolved, registryTarball(entry.version), 'Layout must resolve to the published npm tarball');
  } else {
    assert.ok(entry.resolved, 'Layout lock must record where the package was resolved from');
  }
  return {package: layoutPackage, version: entry.version, resolved: entry.resolved, integrity: entry.integrity};
}

/** Read one Editor checkout, resolve its Layout pin and check the installed copy is that version. */
export async function verifyEditorLayout (editor) {
  const json = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
  const layout = resolveEditorLayout({
    manifest: await json(path.join(editor, 'package.json')),
    lock: await json(path.join(editor, 'package-lock.json'))
  });
  // Resolve from the Editor install, as its webpack configuration does. The package does not export
  // its package.json, so walk up from its entry to the manifest that names it, and read it uncached.
  const require = createRequire(path.join(editor, 'package.json'));
  let directory = path.dirname(require.resolve(layoutPackage));
  let installed;
  for (;;) {
    installed = await json(path.join(directory, 'package.json')).catch(() => null);
    if (installed?.name === layoutPackage) break;
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, 'Cannot find the installed Layout package manifest');
    directory = parent;
  }
  assert.equal(installed.version, layout.version, 'Installed Layout differs from the Editor lockfile');
  return layout;
}
