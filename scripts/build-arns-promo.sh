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
case "$FUND_API_URL" in
  https://*) ;;
  *)
    echo "VITE_FUND_API_URL must be https://… (got: $FUND_API_URL)" >&2
    exit 1
    ;;
esac

if [[ ! -d "$ROOT/apps/web/node_modules/vite" ]]; then
  echo "Installing apps/web dependencies…"
  npm ci --prefix apps/web
fi

echo "Building ArNS promo SPA with Fund API: $FUND_API_URL"
# Match CI native:build + baked Worker origin used by accepted Pages artifacts.
export VITE_FUND_API_URL="$FUND_API_URL"
export VITE_CHECKOUT_API_URL="${VITE_CHECKOUT_API_URL:-$FUND_API_URL}"
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
