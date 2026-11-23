#!/usr/bin/env bash
# Boots api + web against an ISOLATED, freshly-migrated DB (so the UI starts
# clean and navigation is deterministic), runs a browser test, tears down.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
set -a; . ./.env; set +a

# Refuse to start if something already listens on the stack's ports (the dev
# server, or a stack a previous run left behind): the specs would silently talk
# to it, and its database, instead of this run's.
for port in 3001 5173; do
  if curl -s -o /dev/null "http://localhost:$port/"; then
    echo "port $port is already in use; stop the dev server or leftover e2e stack first" >&2
    exit 1
  fi
done

# Dedicated e2e database, wiped each run. Exported so all children inherit it;
# we invoke node directly (not the *:env-file* scripts) so .env can't override.
export DISABLE_RATE_LIMITS=1  # 19 specs x fresh signups would trip the 10/min limit
export DATABASE_URL="pglite://.pglite-e2e"
rm -rf "$ROOT/.pglite-e2e"
pnpm --filter @tandem/db exec node --import tsx src/migrate-run.ts >/tmp/rt-migrate.log 2>&1

# exec node directly rather than via `pnpm exec`: then $! is the server itself
# and the EXIT trap stops it. Killing a pnpm wrapper leaves node running.
(cd apps/server && PORT=3001 exec node --import tsx src/serve.ts) >/tmp/rt-http.log 2>&1 &
SRV=$!
(cd apps/web && exec node_modules/.bin/vite --port 5173) >/tmp/rt-vite.log 2>&1 &
WEB=$!
trap 'kill $SRV $WEB 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -sf http://localhost:5173/ >/dev/null 2>&1 &&
    curl -sf http://localhost:3001/health >/dev/null 2>&1 && break
  sleep 0.5
done

node "$ROOT/apps/web/e2e/${1:-smoke}.mjs"
