#!/usr/bin/env bash
# Build the self-custody Arweave client. Never uploads or reads wallet secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node scripts/build-arns-independent.mjs
