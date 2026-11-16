#!/usr/bin/env bash
# Upload-only release from an exact, successful CI artifact. Never rebuilds or changes ArNS.
# scripts/permaweb-release.mjs must first recover the accepted artifact in the manual workflow.
# PERMAWEB_JWK is supplied only to this reviewed upload step; no wallet file is created.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

exec node scripts/upload-permaweb.mjs --upload
