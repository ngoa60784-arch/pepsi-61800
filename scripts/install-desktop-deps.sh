#!/usr/bin/env bash
# Linux build deps for Tauri 2 (BreachWeave desktop shell).
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "install-desktop-deps.sh is Linux-only"
    exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
    echo "No supported package manager found. Install Tauri Linux deps manually:"
    echo "https://v2.tauri.app/start/prerequisites/"
    exit 1
fi

# Clash/V2Ray 等全局 http_proxy 常导致 apt 拉取 Kali 镜像（如 mirror.freedif.org）502。
# 对 apt 禁用代理，走直连。
APT_NO_PROXY=(
    -o Acquire::http::Proxy=false
    -o Acquire::https::Proxy=false
)

echo "==> apt update（apt 直连，不走 http_proxy）"
sudo env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    apt-get update "${APT_NO_PROXY[@]}"

REQUIRED_PKGS=(
    libwebkit2gtk-4.1-dev
    build-essential
    curl
    wget
    file
    libxdo-dev
    libssl-dev
    librsvg2-dev
    pkg-config
)

OPTIONAL_PKGS=(
    libayatana-appindicator3-dev
)

APT_ENV=(env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY)

echo "==> 安装 Tauri 必需构建依赖（WebKit/GTK）"
if ! sudo "${APT_ENV[@]}" apt-get install -y "${APT_NO_PROXY[@]}" --fix-missing "${REQUIRED_PKGS[@]}"; then
    echo ""
    echo "必需依赖安装失败。若日志出现「连接失败 / 502 / 198.18.0.x」，多半是代理劫持 apt 流量。"
    echo "可手动重试："
    echo "  sudo env -u http_proxy -u https_proxy -u all_proxy apt-get update"
    echo "  sudo env -u http_proxy -u https_proxy -u all_proxy apt-get install -y --fix-missing \\"
    echo "    libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev librsvg2-dev pkg-config"
    echo "或临时关闭系统代理后再执行: bun run desktop:deps"
    exit 100
fi

echo "==> 可选：系统托盘依赖（失败不影响 desktop:dev）"
if ! sudo "${APT_ENV[@]}" apt-get install -y "${APT_NO_PROXY[@]}" --fix-missing "${OPTIONAL_PKGS[@]}"; then
    echo "警告: libayatana-appindicator3-dev 未安装（多为 libdbusmenu-glib-dev 镜像拉取失败）。"
    echo "桌面开发/编译可继续；发行打包若需托盘图标请稍后单独安装。"
fi

if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    echo "Desktop build dependencies installed (webkit2gtk-4.1 OK)."
else
    echo "错误: libwebkit2gtk-4.1-dev 未就绪，pkg-config 找不到 webkit2gtk-4.1。"
    echo "诊断: dpkg -l 'libwebkit2gtk*' ; find /usr -name 'webkit2gtk-4.1.pc' 2>/dev/null"
    exit 1
fi
