#!/usr/bin/env bash
# BreachWeave 一键启动 Web UI（默认 http://127.0.0.1:3000）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LISTEN="${TCH_WEB_LISTEN:-127.0.0.1:3000}"
HOST="${LISTEN%:*}"
PORT="${LISTEN##*:}"
URL="http://${HOST}:${PORT}"

LOG_DIR="${HOME}/.tch-agent/logs"
PID_FILE="${LOG_DIR}/web.pid"
LOG_FILE="${LOG_DIR}/breachweave-web.log"
mkdir -p "$LOG_DIR"

notify() {
    if command -v notify-send >/dev/null 2>&1; then
        notify-send "BreachWeave" "$1" 2>/dev/null || true
    fi
}

die() {
    echo "错误: $1" >&2
    notify "$1"
    exit 1
}

ensure_bun() {
    export PATH="${HOME}/.bun/bin:${PATH}"
    command -v bun >/dev/null 2>&1 || die "未找到 Bun。请安装: curl -fsSL https://bun.sh/install | bash"
}

ensure_deps() {
    if [[ ! -d "${ROOT}/node_modules" ]]; then
        echo "首次运行，正在安装依赖（可能需要几分钟）…"
        (cd "$ROOT" && bun run install) || die "bun run install 失败"
    fi
}

stop_old() {
    if [[ -f "$PID_FILE" ]]; then
        local old_pid
        old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
        if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
            echo "停止旧进程 PID ${old_pid}…"
            kill "$old_pid" 2>/dev/null || true
            sleep 1
            kill -9 "$old_pid" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi
    if command -v fuser >/dev/null 2>&1; then
        fuser -k "${PORT}/tcp" 2>/dev/null || true
        sleep 1
    fi
}

wait_ready() {
    local i
    for i in $(seq 1 90); do
        if curl --noproxy '*' -sf -o /dev/null "${URL}/api/auth/status" 2>/dev/null; then
            return 0
        fi
        if [[ -f "$PID_FILE" ]]; then
            local pid
            pid="$(cat "$PID_FILE")"
            if ! kill -0 "$pid" 2>/dev/null; then
                die "Web 进程已退出，请查看日志: ${LOG_FILE}"
            fi
        fi
        sleep 2
    done
    die "启动超时，请查看日志: ${LOG_FILE}"
}

open_browser() {
    if [[ "${TCH_NO_BROWSER:-}" == "1" ]]; then
        return 0
    fi
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$URL" >/dev/null 2>&1 &
    elif command -v sensible-browser >/dev/null 2>&1; then
        sensible-browser "$URL" >/dev/null 2>&1 &
    fi
}

main() {
    ensure_bun
    ensure_deps

    if ! command -v docker >/dev/null 2>&1; then
        echo "警告: 未检测到 docker，Solver 容器将无法启动。" >&2
    elif ! docker info >/dev/null 2>&1; then
        echo "警告: Docker 未运行，请先启动 docker 服务。" >&2
    fi

    stop_old

    echo "正在启动 BreachWeave → ${URL}"
    echo "日志: ${LOG_FILE}"

    nohup bun run apps/cli/src/main.ts web --listen "$LISTEN" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"

    wait_ready
    open_browser
    notify "已启动 ${URL}"
    echo "BreachWeave 已就绪: ${URL}"
}

main "$@"
