import {buildStandardExtension} from '@kubohiroya/sb3-toolchain/standard-extension-build';
const sourceFile = /^src\/(?:[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\/)*[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\.(?:ts|js|json)$/u;

try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 6 * 1024 * 1024) throw new Error('Input limit');
    chunks.push(chunk);
  }
  const entries = JSON.parse(Buffer.concat(chunks, length));
  const {files, receipt} = await buildStandardExtension(new Map(entries.map(
    ([name, data]) => [name, Buffer.from(data, 'base64')])));
  if (receipt.execution !== 'sandboxed') throw new Error('Sandboxed extensions only');
  process.stdout.write(JSON.stringify({formatVersion: 1, receipt,
    environment: {electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch},
    files: Array.from(files, ([name, data]) => [name, Buffer.from(data).toString('base64')])}));
} catch (error) {
  // Forward only codes and relative source coordinates, never messages or source snippets.
  const diagnostics = (Array.isArray(error.errors) ? error.errors : []).slice(0, 16).flatMap(item => {
    const location = item.loc;
    const file = location?.file?.replace(/^\/__turbowarp_extension_source__\//u, '');
    if (!file || !sourceFile.test(file) ||
        !Number.isSafeInteger(location.line) || location.line < 1 || !Number.isSafeInteger(location.column) || location.column < 0) return [];
    return [{code: /^[A-Z_]{1,64}$/u.test(item.code) ? item.code : 'COMPILER_ERROR', file, line: location.line, column: location.column + 1}];
  });
  process.stdout.write(JSON.stringify({formatVersion: 1, diagnostics}));
  process.exitCode = 2;
}
