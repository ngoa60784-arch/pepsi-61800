#!/usr/bin/env bash
# P5-D/EN-08: build control-plane sidecar + Tauri desktop bundle (Linux first).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" == "Linux" ]]; then
    if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
        echo "缺少 Tauri Linux 构建依赖（webkit2gtk-4.1）。请先运行: bun run desktop:deps"
        exit 1
    fi
fi

echo "==> typecheck"
bun run typecheck:all

echo "==> core tests"
bun test packages/core

echo "==> prepare Linux sidecar binary"
bun run scripts/prepare-desktop-sidecar.ts --platform=linux

echo "==> install desktop CLI deps"
cd apps/desktop
bun install --ignore-scripts

if [[ ! -f src-tauri/icons/icon.png ]]; then
    echo "==> generate tauri icons from deploy/icons/breachweave.png"
    bunx tauri icon "$ROOT/deploy/icons/breachweave.png" -o src-tauri/icons
fi

echo "==> tauri build (deb + rpm)"
bun run tauri build

BUNDLE_DIR="src-tauri/target/release/bundle"
echo ""
echo "Desktop bundle complete."
echo "  deb: $BUNDLE_DIR/deb/BreachWeave_0.0.1_amd64.deb"
echo "  rpm: $BUNDLE_DIR/rpm/BreachWeave-0.0.1-1.x86_64.rpm"
echo "  bin: src-tauri/target/release/breachweave-desktop"
echo ""
echo "安装: sudo dpkg -i $BUNDLE_DIR/deb/BreachWeave_0.0.1_amd64.deb"
echo "AppImage 需额外系统依赖（libfuse2 等），可设置 TAURI_BUNDLE_TARGETS=appimage 单独构建。"
