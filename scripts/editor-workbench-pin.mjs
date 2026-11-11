import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

export const workbenchPackage = '@kubohiroya/turbowarp-plus-editor-workbench';
const registryTarball = version =>
  `https://registry.npmjs.org/${workbenchPackage}/-/turbowarp-plus-editor-workbench-${version}.tgz`;

/**
 * Resolve the Workbench release (formerly @kubohiroya/turbowarp-plus-editor-layout) the pinned Editor adopts from its manifest and lockfile, the way the
 * Editor's own `scripts/site/source.ts` checks its other family packages. Workbench is not a
 * `site/source.json` pin: the Editor fixes it as an exact npm version with its SHA-512 integrity.
 */
export function resolveEditorWorkbench ({manifest, lock}) {
  const specified = {...manifest.dependencies, ...manifest.devDependencies}[workbenchPackage];
  const root = lock.packages?.[''] || {};
  const locked = {...root.dependencies, ...root.devDependencies}[workbenchPackage];
  const entry = lock.packages?.[`node_modules/${workbenchPackage}`];
  assert.ok(specified, `The Editor does not depend on ${workbenchPackage}`);
  assert.ok(entry, `The Editor lockfile does not contain ${workbenchPackage}`);
  assert.equal(locked, specified, 'Workbench root lock differs from the Editor manifest');
  assert.match(entry.integrity || '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'Workbench lock must carry a SHA-512 integrity');
  if (entry.resolved?.startsWith('https://registry.npmjs.org/')) {
    assert.equal(specified, entry.version, 'The Editor must pin the exact npm Workbench version');
    assert.equal(entry.resolved, registryTarball(entry.version), 'Workbench must resolve to the published npm tarball');
  } else {
    assert.ok(entry.resolved, 'Workbench lock must record where the package was resolved from');
  }
  return {package: workbenchPackage, version: entry.version, resolved: entry.resolved, integrity: entry.integrity};
}

/** Read one Editor checkout, resolve its Workbench pin and check the installed copy is that version. */
export async function verifyEditorWorkbench (editor) {
  const json = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
  const workbench = resolveEditorWorkbench({
    manifest: await json(path.join(editor, 'package.json')),
    lock: await json(path.join(editor, 'package-lock.json'))
  });
  // Resolve from the Editor install, as its webpack configuration does. The package does not export
  // its package.json, so walk up from its entry to the manifest that names it, and read it uncached.
  const require = createRequire(path.join(editor, 'package.json'));
  let directory = path.dirname(require.resolve(workbenchPackage));
  let installed;
  for (;;) {
    installed = await json(path.join(directory, 'package.json')).catch(() => null);
    if (installed?.name === workbenchPackage) break;
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, 'Cannot find the installed Workbench package manifest');
    directory = parent;
  }
  assert.equal(installed.version, workbench.version, 'Installed Workbench differs from the Editor lockfile');
  return workbench;
}
