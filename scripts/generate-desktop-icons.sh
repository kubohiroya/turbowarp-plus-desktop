#!/usr/bin/env bash
set -euo pipefail

icon_tool=${1:?Usage: bash scripts/generate-desktop-icons.sh /path/to/icon-tool.js}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/tw-plus-icons.XXXXXX")
trap 'rm -rf -- "$temp_dir"' EXIT

for format in set icns ico; do
  node "$icon_tool" --input="$root/art/icon.svg" --format="$format" --out="$temp_dir/$format"
done

cp "$temp_dir/set/512x512.png" "$root/art/icon.png"
cp "$temp_dir/set/512x512.png" "$root/build/512x512.png"
cp "$temp_dir/icns/icon.icns" "$root/build/icon.icns"
cp "$temp_dir/ico/icon.ico" "$root/build/icon.ico"
