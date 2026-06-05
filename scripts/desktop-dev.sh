#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" == "Linux" ]]; then
    if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
        echo "缺少 Tauri Linux 构建依赖（webkit2gtk-4.1）。"
        if dpkg -s libwebkit2gtk-4.1-0 >/dev/null 2>&1 && ! dpkg -s libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
            echo "已安装运行时库 libwebkit2gtk-4.1-0，但缺少开发头文件包 libwebkit2gtk-4.1-dev。"
            echo "若完整 desktop:deps 因 libayatana-appindicator3-dev 失败，可只装核心依赖："
            echo "  sudo env -u http_proxy -u https_proxy -u all_proxy apt-get install -y --fix-missing libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev librsvg2-dev pkg-config"
        fi
        echo "或运行: bash scripts/install-desktop-deps.sh"
        exit 1
    fi
fi

if [[ -z "${DISPLAY:-}" ]] && [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
    echo "未检测到 DISPLAY/WAYLAND_DISPLAY，无法启动桌面窗口。"
    exit 1
fi

export PATH="${HOME}/.bun/bin:${PATH}"
export BUN_EXECUTABLE="${BUN_EXECUTABLE:-$HOME/.bun/bin/bun}"
export TCH_DESKTOP=1
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="127.0.0.1,localhost"

bun run scripts/prepare-desktop-sidecar.ts --dev
cd apps/desktop
exec bun run dev
