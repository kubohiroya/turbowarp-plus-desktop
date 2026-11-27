const measurementNames = [
  'inputBytes', 'outputBytes', 'payloadBytes', 'additionalRuntimeDownloadBytes',
  'cacheBytes', 'temporaryDiskBytes', 'sampledPeakResidentBytes', 'elapsedMs'
];
const sourceFile = /^src\/(?:[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\/)*[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\.(?:ts|js|json)$/u;

export const sourceBuildDiagnostics = value => Array.isArray(value) ? value.slice(0, 16).filter(item =>
  item && typeof item.code === 'string' && /^[A-Z_]{1,64}$/u.test(item.code) &&
  typeof item.file === 'string' && item.file.length <= 512 && sourceFile.test(item.file) &&
  Number.isSafeInteger(item.line) && item.line > 0 && item.line <= 9999999 &&
  Number.isSafeInteger(item.column) && item.column > 0 && item.column <= 9999999
).map(({code, file, line, column}) => ({code, file, line, column})) : [];

export const sourceBuildMeasurements = value => {
  if (!value || typeof value !== 'object') return undefined;
  const entries = measurementNames.filter(name => Number.isSafeInteger(value[name]) && value[name] >= 0)
    .map(name => [name, value[name]]);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

export const formatBuildBytes = bytes => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};
