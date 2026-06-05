#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${HOME}/.tch-agent/logs"
PID_FILE="${LOG_DIR}/web.pid"
PORT="${TCH_WEB_PORT:-3000}"

stopped=0

if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
        echo "已停止 BreachWeave (PID ${pid})"
        stopped=1
    fi
    rm -f "$PID_FILE"
fi

if command -v fuser >/dev/null 2>&1; then
    if fuser "${PORT}/tcp" 2>/dev/null; then
        fuser -k "${PORT}/tcp" 2>/dev/null || true
        stopped=1
    fi
fi

if [[ "$stopped" -eq 1 ]]; then
    command -v notify-send >/dev/null 2>&1 && notify-send "BreachWeave" "Web 服务已停止" 2>/dev/null || true
else
    echo "BreachWeave 未在运行（端口 ${PORT} 无服务）"
    command -v notify-send >/dev/null 2>&1 && notify-send "BreachWeave" "未在运行" 2>/dev/null || true
fi
