#!/usr/bin/env bash
# 安装桌面图标与应用程序菜单快捷方式（启动 + 停止）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ICON_SRC="${ROOT}/docs/ez-logo.png"
ICON_DST="${ROOT}/deploy/icons/breachweave.png"

chmod +x "${ROOT}/scripts/start-breachweave.sh" \
    "${ROOT}/scripts/stop-breachweave.sh" \
    "${ROOT}/scripts/pack-release.sh" \
    "${ROOT}/start.sh" \
    "${ROOT}/stop.sh" 2>/dev/null || true
chmod +x "${ROOT}/start.sh" "${ROOT}/stop.sh"

mkdir -p "${ROOT}/deploy/icons"
cp -f "$ICON_SRC" "$ICON_DST"
install -Dm644 "$ICON_DST" "${HOME}/.local/share/icons/hicolor/256x256/apps/breachweave.png" 2>/dev/null || true

install_one() {
    local template="$1"
    local app_id="$2"
    local desk_name="$3"
    local content
    content="$(sed "s|@@INSTALL_ROOT@@|${ROOT}|g" "$template")"

    mkdir -p "${HOME}/.local/share/applications"
    printf '%s\n' "$content" >"${HOME}/.local/share/applications/${app_id}.desktop"
    chmod +x "${HOME}/.local/share/applications/${app_id}.desktop"
    echo "已创建: ${HOME}/.local/share/applications/${app_id}.desktop"

    for desk in "${HOME}/Desktop" "${HOME}/桌面" "${XDG_DESKTOP_DIR:-}"; do
        [[ -n "$desk" && -d "$desk" ]] || continue
        printf '%s\n' "$content" >"${desk}/${desk_name}.desktop"
        chmod +x "${desk}/${desk_name}.desktop"
        if command -v gio >/dev/null 2>&1; then
            gio set "${desk}/${desk_name}.desktop" metadata::trusted true 2>/dev/null || true
        fi
        echo "已创建: ${desk}/${desk_name}.desktop"
    done
}

install_one "${ROOT}/deploy/breachweave.desktop" "breachweave" "BreachWeave"
install_one "${ROOT}/deploy/breachweave-stop.desktop" "breachweave-stop" "停止 BreachWeave"

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${HOME}/.local/share/applications" 2>/dev/null || true
fi

echo ""
echo "安装完成。"
echo "  启动: 双击「BreachWeave」"
echo "  停止: 双击「停止 BreachWeave」"
echo "项目目录: ${ROOT}"
