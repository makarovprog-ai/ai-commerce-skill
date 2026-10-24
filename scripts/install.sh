#!/bin/sh
# Run this reviewed local file; do not pipe a network response into a shell.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)' >/dev/null 2>&1; then
  exec node "$script_dir/install.mjs" "$@"
fi

case $(uname -s) in Linux) platform=linux ;; Darwin) platform=darwin ;; *) echo 'Unsupported OS. Supply Node.js 24 LTS and run scripts/install.mjs.' >&2; exit 1 ;; esac
case $(uname -m) in x86_64|amd64) platform=$platform-x64 ;; arm64|aarch64) platform=$platform-arm64 ;; *) echo 'Unsupported architecture.' >&2; exit 1 ;; esac
manifest="$script_dir/runtime-manifest.json"
# The repository pins this simple manifest; accept only the expected filename/hash shape.
archive=$(awk -F '"' -v platform="$platform" '$2 == platform { print $6 }' "$manifest")
expected=$(awk -F '"' -v platform="$platform" '$2 == platform { print $10 }' "$manifest")
case "$archive" in "node-v24.22.1-$platform.tar.gz") ;; *) echo 'Invalid runtime manifest.' >&2; exit 1 ;; esac
case "$expected" in *[!0-9a-f]*|'') echo 'Invalid runtime checksum.' >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { echo 'Invalid runtime checksum length.' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required to fetch the pinned Node runtime; alternatively provide Node.js 24.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then checksum=sha256sum
elif command -v shasum >/dev/null 2>&1; then checksum=shasum
else echo 'A SHA256 utility is required.' >&2; exit 1
fi
stage=$(mktemp -d "${TMPDIR:-/tmp}/ai-commerce-runtime.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 --output "$stage/runtime.tar.gz" "https://nodejs.org/dist/v24.22.1/$archive"
if [ "$checksum" = sha256sum ]; then actual=$(sha256sum "$stage/runtime.tar.gz" | awk '{ print $1 }')
else actual=$(shasum -a 256 "$stage/runtime.tar.gz" | awk '{ print $1 }'); fi
[ "$actual" = "$expected" ] || { echo 'Runtime checksum mismatch; nothing was extracted.' >&2; exit 1; }
top=${archive%.tar.gz}
tar -tzf "$stage/runtime.tar.gz" > "$stage/entries"
# Reject absolute paths, dot components and every unexpected top-level name.
awk -v top="$top" 'BEGIN {ok=1} { if ($0 != top && index($0, top "/") != 1) ok=0; n=split($0,a,"/"); for(i=1;i<=n;i++) if(a[i]==".." || a[i]==".") ok=0 } END {exit !ok}' "$stage/entries" || { echo 'Unsafe runtime archive paths.' >&2; exit 1; }
awk -v node="$top/bin/node" '$0 == node {count++} END {exit count != 1}' "$stage/entries" || { echo 'Runtime executable missing or duplicated.' >&2; exit 1; }
# Official archives contain npm links. They are not selected or extracted.
tar -tvzf "$stage/runtime.tar.gz" "$top/bin/node" > "$stage/types"
awk 'substr($0,1,1) != "-" {bad=1} END {exit bad}' "$stage/types" || { echo 'Runtime executable is not a regular file.' >&2; exit 1; }
# Extract only the executable, never the rest of the archive.
mkdir "$stage/extracted"
tar -xzf "$stage/runtime.tar.gz" -C "$stage/extracted" "$top/bin/node"
"$stage/extracted/$top/bin/node" "$script_dir/install.mjs" "$@"
