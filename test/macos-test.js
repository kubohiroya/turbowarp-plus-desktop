function macosTestSkip (...requiredEnv) {
  if (process.env.TW_PLUS_DESKTOP_NATIVE_TESTS !== '1') {
    return 'Run the matching npm run test:macos:* command to start Electron.';
  }
  if (process.platform !== 'darwin') {
    throw new Error('Native Desktop tests require macOS.');
  }
  const missing = requiredEnv.filter(name => !process.env[name]);
  if (missing.length) {
    throw new Error('Set the required test environment variables: ' + missing.join(', '));
  }
  return false;
}

module.exports = {macosTestSkip};
