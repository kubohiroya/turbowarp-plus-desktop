"""Overlay this checkout's native project-process code on a disposable official 1.17.1 macOS app."""
import argparse
import hashlib
import json
import plistlib
from pathlib import Path
import struct
import subprocess
parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--renderer", type=Path)
args = parser.parse_args()
source, output = args.source, args.output
root = Path(__file__).resolve().parent.parent
info_path = Path("Contents/Info.plist")
asar_path = Path("Contents/Resources/app.asar")
info = plistlib.loads((source / info_path).read_bytes())
assert info["CFBundleShortVersionString"] == "1.17.1" and not output.exists()
archive = (source / asar_path).read_bytes()
_, header_size, _, json_size = struct.unpack_from("<4I", archive)
raw_header = archive[16:16 + json_size]
digest = lambda data: hashlib.sha256(data).hexdigest()
integrity = info["ElectronAsarIntegrity"]["Resources/app.asar"]
assert digest(raw_header) == integrity["hash"]
header = json.loads(raw_header)
data = bytearray(archive[8 + header_size:])
paths = (
    "config/feature-flags.js", "src-main/atomic-write-stream.js", "src-main/brand.js",
    "src-main/entrypoint.js", "src-main/index.js", "src-main/project-lock.js",
    "src-main/project-process.js", "src-main/project-assets.js", "src-main/external-yaml-files.js", "src-main/windows/editor.js",
    "src-preload/editor.js",
)
def overlay(name, contents):
    parents, leaf = name.split("/")[:-1], name.split("/")[-1]
    folder = header["files"]
    for component in parents:
        folder = folder.setdefault(component, {"files": {}})["files"]
    block_size = 4 * 1024 * 1024
    folder[leaf] = {
        "size": len(contents), "offset": str(len(data)),
        "integrity": {
            "algorithm": "SHA256", "hash": digest(contents), "blockSize": block_size,
            "blocks": [digest(contents[i:i+block_size]) for i in range(0, len(contents), block_size)],
        },
    }
    data.extend(contents)


for name in paths:
    contents = (root / name).read_bytes()
    if name == "src-main/entrypoint.js":
        # Route the test's explicit fixture choices through the real IPC handlers.
        contents = b"""
if (process.env.TW_D3_TEST_DIALOG_PATH) {
  const {dialog} = require('electron');
  const read = () => JSON.parse(require('node:fs').readFileSync(process.env.TW_D3_TEST_DIALOG_PATH, 'utf8'));
  dialog.showOpenDialog = async () => {
    const file = read().open;
    return file ? {canceled: false, filePaths: [file]} : {canceled: true, filePaths: []};
  };
  dialog.showSaveDialog = async () => ({canceled: false, filePath: read().save});
  dialog.showErrorBox = (_, message) => console.error(message);
}
""" + contents
    overlay(name, contents)

if args.renderer:
    assert (args.renderer / "gui.html").is_file()
    for asset in sorted(args.renderer.rglob("*")):
        relative = asset.relative_to(args.renderer)
        if asset.is_file() and relative.parts[0] != "translation-messages":
            overlay(f"dist-renderer-webpack/editor/gui/{relative.as_posix()}", asset.read_bytes())

raw_header = json.dumps(header, separators=(",", ":")).encode()
payload = struct.pack("<I", len(raw_header)) + raw_header + b"\0" * (-len(raw_header) % 4)
pickle = struct.pack("<I", len(payload)) + payload
integrity["hash"] = digest(raw_header)
original_id = info["CFBundleIdentifier"]
test_id = "io.github.kubohiroya.turbowarpplus.desktop.d3-test"
info["CFBundleIdentifier"] = test_id
info.pop("CFBundleDocumentTypes", None)
info.pop("CFBundleURLTypes", None)
subprocess.run(["/usr/bin/ditto", str(source), str(output)], check=True)
(output / asar_path).write_bytes(struct.pack("<II", 4, len(pickle)) + pickle + data)
(output / info_path).write_bytes(plistlib.dumps(info))
for helper_path in (output / "Contents/Frameworks").glob("*.app/Contents/Info.plist"):
    helper = plistlib.loads(helper_path.read_bytes())
    identifier = helper["CFBundleIdentifier"]
    if identifier.startswith(original_id + ".helper"):
        helper["CFBundleIdentifier"] = test_id + identifier[len(original_id):]
        helper_path.write_bytes(plistlib.dumps(helper))
subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(output)], check=True)
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(output)], check=True)
