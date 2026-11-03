#!/usr/bin/env bash
# Upload the verified ArNS promo SPA to Arweave (Turbo / bundler). Does NOT change ArNS.
# Name sejire is owned by the owner — set Target ID manually after upload.
#
# Usage (on YOUR computer — never paste wallet into chat):
#   1. Export Wander/ArConnect keyfile → ./wallet.json at repo root (gitignored)
#   2. npm run deploy:permaweb
#   3. Copy printed manifest TX id
#   4. Delete wallet.json
#   5. Phantom → arns.ar.io → sejire → Target ID = manifest id → Save
#
# This script builds the promo-funded Preservation V2 pack (Worker URL baked in).
# It deliberately does NOT use the old self-only web:build:arns path.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WALLET="${WALLET_PATH:-$ROOT/wallet.json}"
CLEANUP_WALLET=0
if [[ -n "${PERMAWEB_JWK:-}" && ! -f "$WALLET" ]]; then
  printf '%s' "$PERMAWEB_JWK" > "$WALLET"
  CLEANUP_WALLET=1
  trap 'rm -f "$WALLET"' EXIT
fi
if [[ ! -f "$WALLET" ]]; then
  echo "Нет файла кошелька: $WALLET"
  echo "Экспортируйте keyfile из Wander → сохраните как wallet.json в корне репо."
  echo "Или задайте PERMAWEB_JWK (JSON keyfile) в GitHub Actions secret."
  echo "Не присылайте этот файл в чат."
  exit 1
fi

if [[ "${ARNS_USE_EXISTING_DIST:-0}" == "1" ]]; then
  echo "Using existing apps/web/dist (ARNS_USE_EXISTING_DIST=1)"
  node "$ROOT/scripts/verify-arns-dist.mjs" "$ROOT/apps/web/dist" \
    "${VITE_FUND_API_URL:-https://sejire-sponsor.azovskaya-alissa.workers.dev}"
else
  bash "$ROOT/scripts/build-arns-promo.sh"
fi

DIST="$ROOT/apps/web/dist"
# ArNS gateways often request "/" — without manifest fallback that returns "Not found".
cp "$DIST/index.html" "$DIST/404.html"

SIZE=$(du -sh "$DIST" | awk '{print $1}')
echo "Uploading $DIST ($SIZE)…"
echo "ArNS не обновляем автоматически (имя sejire у владельца)."

npx permaweb-deploy upload \
  --wallet "$WALLET" \
  --deploy-folder "$DIST" \
  --sig-type arweave

echo ""
echo "Готово. Скопируйте manifest / transaction id из вывода выше."
echo "Дальше: Phantom → arns.ar.io → sejire → Target ID = этот id → Save."
echo "Затем удалите wallet.json с диска."
echo "Smoke: https://sejire.ar.io → сохранить по промокоду (Worker CORS уже допускает этот origin)."
