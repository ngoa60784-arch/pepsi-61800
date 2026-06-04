#!/usr/bin/env bash
# 安装桌面图标与应用程序菜单快捷方式
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ICON_SRC="${ROOT}/docs/ez-logo.png"
ICON_DST="${ROOT}/deploy/icons/breachweave.png"
DESKTOP_TEMPLATE="${ROOT}/deploy/breachweave.desktop"

chmod +x "${ROOT}/scripts/start-breachweave.sh" "${ROOT}/scripts/stop-breachweave.sh" "${ROOT}/scripts/pack-release.sh"

mkdir -p "${ROOT}/deploy/icons"
cp -f "$ICON_SRC" "$ICON_DST"

install -Dm644 "$ICON_DST" "${HOME}/.local/share/icons/hicolor/256x256/apps/breachweave.png" 2>/dev/null || true

DESKTOP_CONTENT="$(sed "s|@@INSTALL_ROOT@@|${ROOT}|g" "$DESKTOP_TEMPLATE")"

DESKTOP_DIR="${HOME}/.local/share/applications"
mkdir -p "$DESKTOP_DIR"
printf '%s\n' "$DESKTOP_CONTENT" >"${DESKTOP_DIR}/breachweave.desktop"
chmod +x "${DESKTOP_DIR}/breachweave.desktop"

# 桌面快捷方式（支持中文「桌面」路径）
for desk in "${HOME}/Desktop" "${HOME}/桌面" "${XDG_DESKTOP_DIR:-}"; do
    [[ -n "$desk" && -d "$desk" ]] || continue
    printf '%s\n' "$DESKTOP_CONTENT" >"${desk}/BreachWeave.desktop"
    chmod +x "${desk}/BreachWeave.desktop"
    if command -v gio >/dev/null 2>&1; then
        gio set "${desk}/BreachWeave.desktop" metadata::trusted true 2>/dev/null || true
    fi
    echo "已创建: ${desk}/BreachWeave.desktop"
done

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${HOME}/.local/share/applications" 2>/dev/null || true
fi

echo ""
echo "安装完成。可从应用程序菜单或桌面双击「BreachWeave」启动。"
echo "项目目录: ${ROOT}"
echo "停止服务: ${ROOT}/scripts/stop-breachweave.sh"
