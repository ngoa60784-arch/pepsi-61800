#!/usr/bin/env bash
# Build desktop bundles for all platforms available on this host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OS="$(uname -s)"
FAILED=0

echo "==> shared: typecheck + tests"
bun run typecheck:all
bun test packages/core

echo "==> prepare all sidecar binaries"
bun run scripts/prepare-desktop-sidecar.ts --all-platforms

if [[ "${OS}" == "Linux" ]]; then
    echo "==> Linux bundle"
    bash scripts/pack-desktop.sh || FAILED=1

    echo "==> Windows bundle (cross-compile)"
    bash scripts/pack-desktop-windows.sh || FAILED=1

    echo ""
    echo "macOS .dmg 需在 Mac 上执行: bun run desktop:build:macos"
elif [[ "${OS}" == "Darwin" ]]; then
    echo "==> macOS bundle"
    bash scripts/pack-desktop-macos.sh || FAILED=1
else
    echo "Unsupported host OS: ${OS}"
    exit 1
fi

if [[ "${FAILED}" -ne 0 ]]; then
    echo "部分平台打包失败，请查看上方日志。"
    exit 1
fi

echo "All available platform bundles complete."
