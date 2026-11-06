import * as fs from 'node:fs';
import * as pathUtil from 'node:path';
import { computeSHA256, persistentFetch } from './lib.mjs';
import packagerInfo from './packager.json' with { type: 'json' };
import {patchPackagerPreview} from './patch-packager-preview.mjs';

const path = pathUtil.join(import.meta.dirname, '../src-renderer/packager/standalone.html');

const readExisting = () => {
  try {
    return fs.readFileSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
};

const existing = readExisting();
const existingHash = existing && computeSHA256(existing);
if (existingHash === packagerInfo.desktopSha256) {
  console.log('Packager already updated');
} else {
  let upstream = existing;
  if (existingHash !== packagerInfo.sha256) {
    console.log(`Downloading ${packagerInfo.src}`);
    upstream = Buffer.from(await (await persistentFetch(packagerInfo.src)).arrayBuffer());
  }
  const upstreamHash = computeSHA256(upstream);
  if (upstreamHash !== packagerInfo.sha256) {
    throw new Error(`Packager hash mismatch: expected ${packagerInfo.sha256} but found ${upstreamHash}`);
  }
  const desktop = Buffer.from(patchPackagerPreview(upstream.toString('utf8')));
  const desktopHash = computeSHA256(desktop);
  if (desktopHash !== packagerInfo.desktopSha256) {
    throw new Error(`Desktop Packager hash mismatch: expected ${packagerInfo.desktopSha256} but found ${desktopHash}`);
  }
  fs.mkdirSync(pathUtil.dirname(path), {recursive: true});
  fs.writeFileSync(path, desktop);
}
