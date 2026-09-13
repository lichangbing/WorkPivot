#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then
  echo "DMG 构建需要 macOS（Apple hdiutil），请在 Mac 上运行本脚本。" >&2
  exit 1
fi
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_dir/code"
if ! command -v node >/dev/null || ! command -v pnpm >/dev/null; then
  echo "请先安装 Node.js 22 或以上版本及 pnpm，然后重试。" >&2
  exit 1
fi
# Thin client: no local backend or model credentials enter the package.
pnpm install --frozen-lockfile
pnpm --filter @workpivot/desktop build
version="$(node -p "JSON.parse(require('fs').readFileSync('apps/desktop/package.json','utf8')).version")"
cd apps/desktop
pnpm exec electron-builder --mac dmg zip --arm64 --x64 --publish never \
  --config.directories.output="$repo_dir/releases/v$version/macos"
cd "$repo_dir/releases/v$version/macos"
shasum -a 256 ./*.dmg ./*.zip > SHA256SUMS.txt
echo "macOS 构建完成：$repo_dir/releases/v$version/macos"
