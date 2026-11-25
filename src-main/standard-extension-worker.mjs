import {buildStandardExtension} from '@kubohiroya/sb3-toolchain/standard-extension-build';

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
  process.stdout.write(JSON.stringify(Array.from(files, ([name, data]) => [name, Buffer.from(data).toString('base64')])));
} catch {
  // Do not forward compiler output containing local source code across the IPC boundary.
  process.exitCode = 2;
}
