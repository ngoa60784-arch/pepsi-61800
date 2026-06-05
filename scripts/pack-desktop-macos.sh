#!/usr/bin/env bash
# Build BreachWeave desktop for macOS (.dmg). Must run on macOS with Xcode CLI tools.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "macOS 安装包必须在 macOS 上构建（需 Xcode Command Line Tools + WebKit）。"
    echo "本机可先准备 sidecar：bun run desktop:prepare:macos"
    echo "然后在 Mac 上执行：bun run desktop:build:macos"
    exit 2
fi

ARCH="$(uname -m)"
if [[ "${ARCH}" == "arm64" ]]; then
    PLATFORM="macos-arm64"
else
    PLATFORM="macos-x64"
fi

echo "==> prepare macOS sidecar (${PLATFORM})"
bun run scripts/prepare-desktop-sidecar.ts --platform="${PLATFORM}"

echo "==> install desktop CLI deps"
cd apps/desktop
bun install --ignore-scripts

echo "==> tauri build (dmg)"
bun run tauri build -- --bundles dmg

OUT="src-tauri/target/release/bundle/dmg"
echo ""
echo "macOS bundle complete."
ls -lh "${OUT}" 2>/dev/null || true
