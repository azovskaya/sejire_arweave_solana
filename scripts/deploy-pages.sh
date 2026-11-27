#!/usr/bin/env bash
# Historical Pages mirror for the legacy profile, not the current Arweave-only release.
# Deploy apps/web/dist to origin/gh-pages (GitHub Pages for this repo).
# Preserves /presentation from the previous gh-pages tip (pptx, pdf, screenshots).
# Does NOT upload to Arweave — use npm run deploy:permaweb for that.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/web"
export VITE_DECENTRALIZED_MODE=false
# GitHub test mirror: same 12-words → derived AR path as the future ArNS build.
# Override with VITE_PUBLISH_MODE=demo to save only in the browser.
export VITE_PUBLISH_MODE="${VITE_PUBLISH_MODE:-self}"
# Pages is the test mirror: keep the 13-knee demo. Unset for ArNS.
export VITE_QA_TOOLS="${VITE_QA_TOOLS:-1}"
echo "Building Pages with VITE_PUBLISH_MODE=${VITE_PUBLISH_MODE} VITE_QA_TOOLS=${VITE_QA_TOOLS}"
npm run build
STAGE=$(mktemp -d)
cp -R dist/. "$STAGE/"
touch "$STAGE/.nojekyll"

# Keep investor deck / screenshots from the live Pages branch, then overlay source.
git -C "$ROOT" fetch origin gh-pages 2>/dev/null || true
if git -C "$ROOT" rev-parse --verify origin/gh-pages >/dev/null 2>&1; then
  git -C "$ROOT" archive origin/gh-pages presentation 2>/dev/null | tar -x -C "$STAGE" || true
  git -C "$ROOT" archive origin/gh-pages qa-13gen 2>/dev/null | tar -x -C "$STAGE" || true
  git -C "$ROOT" archive origin/gh-pages qa-7gen 2>/dev/null | tar -x -C "$STAGE" || true
fi
if [[ -d "$ROOT/presentation" ]]; then
  mkdir -p "$STAGE/presentation"
  cp -a "$ROOT/presentation/." "$STAGE/presentation/"
fi
if [[ -d "$ROOT/artifacts/qa-7gen" ]]; then
  mkdir -p "$STAGE/qa-7gen"
  cp -a "$ROOT/artifacts/qa-7gen/." "$STAGE/qa-7gen/"
fi
if [[ -d "$ROOT/artifacts/qa-13gen" ]]; then
  mkdir -p "$STAGE/qa-13gen"
  cp -a "$ROOT/artifacts/qa-13gen/." "$STAGE/qa-13gen/"
  rm -rf "$STAGE/qa-13gen/live-arns" 2>/dev/null || true
  git -C "$ROOT" archive origin/gh-pages qa-13gen/live-arns 2>/dev/null | tar -x -C "$STAGE" || true
fi

cd "$STAGE"
git init -b gh-pages
git config user.email "sejire-deploy@users.noreply.github.com"
git config user.name "SEJIRE Deploy"
git add -A
git commit -m "Deploy SEJIRE Pages $(date -u +%Y-%m-%dT%H:%MZ)"
git remote add origin "$(git -C "$ROOT" remote get-url origin)"
git push -f origin gh-pages
echo "Published: https://azovskaya.github.io/Sejire_arweave/"
echo "Arweave / ArNS was not updated."
