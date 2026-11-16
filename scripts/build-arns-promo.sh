#!/usr/bin/env bash
# Build the verified promo-funded SPA for static ArNS hosting (sejire.ar.io).
# Does NOT upload, change ArNS, spend AR/SOL, or read wallet secrets.
#
# Product: Preservation V2 + Fund/promo against the existing Cloudflare Worker.
# Solana mainnet client spend stays OFF (same as accepted native:build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FUND_API_URL="${VITE_FUND_API_URL:-https://sejire-sponsor.azovskaya-alissa.workers.dev}"
CHECKOUT_API_URL="${VITE_CHECKOUT_API_URL:-$FUND_API_URL}"
# Both clients require exact HTTPS origins: a trailing slash/path passes a loose
# shell prefix test but causes invalid_*_endpoint in the browser.
node --input-type=module - "$FUND_API_URL" "$CHECKOUT_API_URL" <<'JS'
for (const raw of process.argv.slice(2)) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.origin !== raw || url.username || url.password) throw Error('ArNS API configuration must be an exact HTTPS origin');
}
JS

if [[ ! -d "$ROOT/apps/web/node_modules/vite" ]]; then
  echo "Installing apps/web dependencies…"
  npm ci --prefix apps/web
fi

echo "Building ArNS promo SPA with Fund API: $FUND_API_URL"
# Match CI native:build + baked Worker origin used by accepted Pages artifacts.
export VITE_FUND_API_URL="$FUND_API_URL"
export VITE_CHECKOUT_API_URL="$CHECKOUT_API_URL"
export VITE_DECENTRALIZED_MODE=false
export VITE_PRESERVATION_V2_TEST=0
export VITE_PRESERVATION_V2_ENABLED=1
export VITE_NATIVE_AR_PILOT=1
export VITE_NATIVE_AR_ENABLED=1
export VITE_NATIVE_AR_BROADCAST=0
export VITE_NATIVE_SOL_MAINNET=0
export VITE_PUBLISH_MODE=solana
export VITE_SOLANA_NETWORK=devnet
export VITE_QA_TOOLS=0
unset VITE_RECOVERY_TEST || true

npm run web:build

DIST="$ROOT/apps/web/dist"
if [[ ! -f "$DIST/index.html" ]]; then
  echo "Build failed: missing $DIST/index.html" >&2
  exit 1
fi

node "$ROOT/scripts/verify-arns-dist.mjs" "$DIST" "$FUND_API_URL"
echo "ArNS promo dist OK: $DIST"
