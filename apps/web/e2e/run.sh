#!/usr/bin/env bash
# Boots api + web against an ISOLATED, freshly-migrated DB (so the UI starts
# clean and navigation is deterministic), runs a browser test, tears down.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
set -a; . ./.env; set +a

# Dedicated e2e database, wiped each run. Exported so all children inherit it;
# we invoke node directly (not the *:env-file* scripts) so .env can't override.
export DATABASE_URL="pglite://.pglite-e2e"
rm -rf "$ROOT/.pglite-e2e"
pnpm --filter @realtime/db exec node --import tsx src/migrate-run.ts >/tmp/rt-migrate.log 2>&1

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
