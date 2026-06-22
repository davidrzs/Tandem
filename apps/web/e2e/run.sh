#!/usr/bin/env bash
# Boots the api + web dev servers, runs the browser smoke test, tears down.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
set -a; . ./.env; set +a

PORT=3001 pnpm --filter @realtime/server exec node --import tsx src/serve.ts >/tmp/rt-http.log 2>&1 &
SRV=$!
pnpm --filter @realtime/web exec vite --port 5173 >/tmp/rt-vite.log 2>&1 &
WEB=$!
trap 'kill $SRV $WEB 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -sf http://localhost:5173/ >/dev/null 2>&1 &&
    curl -sf http://localhost:3001/health >/dev/null 2>&1 && break
  sleep 0.5
done

node "$ROOT/apps/web/e2e/${1:-smoke}.mjs"
