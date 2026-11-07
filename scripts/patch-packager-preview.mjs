const original = 'frame.src = URL.createObjectURL(e.data.blob);';
const originalBakeWrapper = '(function(Scratch) { ${await Z.fetchExtensionScript(n)} })(Scratch);';
// A fetched script can end in a line comment without a terminating newline.
const bakeWrapper = '(function(Scratch) { ${await Z.fetchExtensionScript(n)}\\n})(Scratch);';

// The data document has its own opaque origin. Its blob inherits that origin
// without forcing a new opaque origin on the SVG renderer's nested iframe.
const bridge = `<!doctype html><meta charset="utf-8"><script>
  const channel = new MessageChannel();
  channel.port1.onmessage = ({data}) => {
    if (!(data instanceof Blob)) return;
    channel.port1.close();
    location.replace(URL.createObjectURL(data));
  };
  parent.postMessage('tw-packager-preview-ready', 'tw-packager://.', [channel.port2]);
</script>`;

const bridgeURL = 'data:text/html;charset=utf-8,' + encodeURIComponent(bridge);
const replacement = [
  'const previewBlob = e.data.blob;',
  'window.addEventListener("message", function connect(event) {',
  '  if (event.source !== frame.contentWindow || event.origin !== "null" ||',
  '      event.data !== "tw-packager-preview-ready" || event.ports.length !== 1) return;',
  '  window.removeEventListener("message", connect);',
  '  event.ports[0].postMessage(previewBlob);',
  '  event.ports[0].close();',
  '});',
  'frame.sandbox.add("allow-same-origin");',
  'frame.src = ' + JSON.stringify(bridgeURL) + ';'
].join('\\n        ');

export const patchPackagerPreview = (html) => {
  const match = html.indexOf(original);
  if (match < 0 || match !== html.lastIndexOf(original)) {
    throw new Error('The pinned Packager preview template has changed');
  }
  const bakeMatch = html.indexOf(originalBakeWrapper);
  if (bakeMatch < 0 || bakeMatch !== html.lastIndexOf(originalBakeWrapper)) {
    throw new Error('The pinned Packager extension wrapper has changed');
  }
  return html.replace(original, () => replacement).replace(originalBakeWrapper, () => bakeWrapper);
};
