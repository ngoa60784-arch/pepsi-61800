#!/usr/bin/env bash
exec "$(cd "$(dirname "$0")" && pwd)/scripts/stop-breachweave.sh" "$@"
