#!/usr/bin/env bash
# Cross-compile BreachWeave desktop for Windows (NSIS) from Linux/macOS host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="x86_64-pc-windows-msvc"
BUNDLE="nsis"

need_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "缺少命令: $1"
        return 1
    fi
}

ensure_llvm_rc() {
    if command -v llvm-rc >/dev/null 2>&1; then
        return 0
    fi
    local shim_dir="${ROOT}/.cache/win-cross/bin"
    mkdir -p "${shim_dir}"
    for candidate in /usr/bin/llvm-rc-21 /usr/bin/llvm-rc-18 /usr/bin/llvm-rc-17; do
        if [[ -x "${candidate}" ]]; then
            ln -sf "${candidate}" "${shim_dir}/llvm-rc"
            export PATH="${shim_dir}:${PATH}"
            return 0
        fi
    done
    echo "缺少 llvm-rc（请安装: sudo apt-get install -y clang lld llvm）"
    return 1
}

echo "==> 检查 Windows 交叉编译工具链"
need_cmd rustc
need_cmd cargo
need_cmd clang
ensure_llvm_rc

if ! rustup target list --installed | grep -q "^${TARGET}$"; then
    echo "==> rustup target add ${TARGET}"
    rustup target add "${TARGET}"
fi

if ! command -v cargo-xwin >/dev/null 2>&1; then
    echo "==> 安装 cargo-xwin"
    cargo install cargo-xwin --locked
fi

echo "==> prepare Windows sidecar"
bun run scripts/prepare-desktop-sidecar.ts --platform=windows

echo "==> install desktop CLI deps"
cd apps/desktop
bun install --ignore-scripts

echo "==> tauri build (Windows NSIS, cross-compile)"
bun run tauri build --runner cargo-xwin --target "${TARGET}" --bundles "${BUNDLE}"

OUT="src-tauri/target/${TARGET}/release/bundle/nsis"
echo ""
echo "Windows bundle complete."
find "${OUT}" -maxdepth 1 -type f \( -name '*.exe' -o -name '*.msi' \) -print 2>/dev/null || ls -la "${OUT}" 2>/dev/null || true
