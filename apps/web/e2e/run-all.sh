#!/usr/bin/env bash
# Boots api + web once against an ISOLATED, freshly-migrated PGlite database and
# runs every e2e spec (apps/web/e2e/*.mjs, minus _helpers) against it. Each spec
# signs up fresh users, so a shared server is safe and fast. Exits non-zero if
# any spec fails. Used by CI and `make e2e-all`.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
set -a; . ./.env; set +a

export DISABLE_RATE_LIMITS=1  # 19 specs x fresh signups would trip the 10/min limit
export DATABASE_URL="pglite://.pglite-e2e"
rm -rf "$ROOT/.pglite-e2e"
pnpm --filter @tandem/db exec node --import tsx src/migrate-run.ts >/tmp/rt-migrate.log 2>&1

PORT=3001 pnpm --filter @tandem/server exec node --import tsx src/serve.ts >/tmp/rt-http.log 2>&1 &
SRV=$!
pnpm --filter @tandem/web exec vite --port 5173 >/tmp/rt-vite.log 2>&1 &
WEB=$!
trap 'kill $SRV $WEB 2>/dev/null || true' EXIT

echo "waiting for the stack…"
for _ in $(seq 1 80); do
  curl -sf http://localhost:5173/ >/dev/null 2>&1 &&
    curl -sf http://localhost:3001/health >/dev/null 2>&1 && break
  sleep 0.5
done

mapfile -t SPECS < <(cd "$ROOT/apps/web/e2e" && ls *.mjs | grep -v '^_' | sed 's/\.mjs$//' | sort)

fail=0
passed=()
failed=()
for spec in "${SPECS[@]}"; do
  echo "──────── e2e: $spec ────────"
  if node "$ROOT/apps/web/e2e/$spec.mjs"; then
    passed+=("$spec")
  else
    echo "::error::e2e spec failed: $spec"
    failed+=("$spec")
    fail=1
  fi
done

echo "════════════════════════════════"
echo "passed (${#passed[@]}): ${passed[*]:-none}"
echo "failed (${#failed[@]}): ${failed[*]:-none}"
[ "$fail" -ne 0 ] && { echo "--- server log tail ---"; tail -30 /tmp/rt-http.log; echo "--- vite log tail ---"; tail -30 /tmp/rt-vite.log; }
exit $fail
