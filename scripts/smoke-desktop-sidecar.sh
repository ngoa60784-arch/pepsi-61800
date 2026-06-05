#!/usr/bin/env bash
# Smoke test desktop sidecar without Tauri/GTK (CI-friendly).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LISTEN="${TCH_DESKTOP_LISTEN:-127.0.0.1:38472}"
HOST="${LISTEN%:*}"
PORT="${LISTEN##*:}"
export PATH="${HOME}/.bun/bin:${PATH}"
export TCH_DESKTOP=1
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="127.0.0.1,localhost"

if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null || true
    sleep 1
fi

echo "==> starting sidecar on http://${LISTEN}"
bun run apps/cli/src/main.ts web -l "$LISTEN" &
PID=$!

cleanup() {
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
    if curl --noproxy '*' -sf "http://${LISTEN}/health" >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "sidecar exited before becoming ready"
        exit 1
    fi
    sleep 1
done

HEALTH="$(curl --noproxy '*' -sf "http://${LISTEN}/health")"
echo "health: ${HEALTH}"

ROOT_CODE="$(curl --noproxy '*' -s -o /tmp/tch-desktop-smoke.html -w '%{http_code}' "http://${LISTEN}/")"
ROOT_SIZE="$(wc -c < /tmp/tch-desktop-smoke.html | tr -d ' ')"
echo "root: HTTP ${ROOT_CODE}, ${ROOT_SIZE} bytes"

if [[ "$ROOT_CODE" != "200" ]]; then
    echo "expected HTTP 200 from /"
    exit 1
fi
if [[ "$ROOT_SIZE" -lt 100 ]]; then
    echo "expected non-empty HTML from /"
    exit 1
fi
if ! head -1 /tmp/tch-desktop-smoke.html | grep -qi '<!doctype html'; then
    echo "expected HTML doctype from /"
    exit 1
fi

echo "desktop sidecar smoke: OK"
