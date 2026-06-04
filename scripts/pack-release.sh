#!/usr/bin/env bash
# 打包项目为可分发的 tar.gz（不含 node_modules / 编译产物，首次启动会自动 install）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(date +%Y%m%d)"
NAME="breachweave-${VERSION}"
OUT_DIR="${ROOT}/dist"
mkdir -p "$OUT_DIR"

TMP_ARCHIVE="$(mktemp "/tmp/${NAME}.XXXXXX.tar.gz")"
ARCHIVE="${OUT_DIR}/${NAME}.tar.gz"

echo "打包 → ${ARCHIVE}"

tar -czf "$TMP_ARCHIVE" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='bin' \
    --exclude='.cursor' \
    --exclude='packages/ui-web/dist-test' \
    --exclude='packages/libs/pi-mcp-adapter/examples' \
    -C "$(dirname "$ROOT")" \
    "$(basename "$ROOT")"

mv -f "$TMP_ARCHIVE" "$ARCHIVE"
ls -lh "$ARCHIVE"
echo ""
echo "分发包说明:"
echo "  1. 解压: tar -xzf ${ARCHIVE} -C ~/桌面"
echo "  2. 安装图标: cd ~/桌面/$(basename "$ROOT") && ./scripts/install-desktop-shortcut.sh"
echo "  3. 双击桌面「BreachWeave」或运行 ./scripts/start-breachweave.sh"
echo "  需已安装: Bun、Docker（Solver 容器）"
