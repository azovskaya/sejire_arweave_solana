#!/usr/bin/env bash
set -euo pipefail

# Synthetic, disabled API, network-isolated container and disposable volume.
sejire_ci_container="sejire-portable-ci-${GITHUB_RUN_ID:-local}-$$"
trap 'docker rm -fv "$sejire_ci_container" >/dev/null 2>&1 || true' EXIT
docker build -f deployment/Dockerfile -t sejire-portable-ci:review .
docker run --detach --name "$sejire_ci_container" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
  --env "SEJIRE_BUILD_COMMIT=${GITHUB_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" \
  sejire-portable-ci:review

sejire_health_check='const fs=require("node:fs");(async()=>{let r;for(let n=0;n<50;n++){try{r=await fetch("http://127.0.0.1:8787/healthz",{signal:AbortSignal.timeout(1000)});if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,200))}if(!r?.ok)throw Error("service_not_healthy");const h=await r.json();if(h.runtime!=="linux-sqlite"||h.sourceCommit!==process.env.SEJIRE_BUILD_COMMIT)throw Error("wrong_runtime");if(!fs.existsSync("/data/sejire.sqlite"))throw Error("database_missing");console.log(JSON.stringify(h))})().catch(e=>{console.error(e.message);process.exit(1)})'
docker exec "$sejire_ci_container" node -e "$sejire_health_check"
docker stop --time 20 "$sejire_ci_container"
test "$(docker inspect --format '{{.State.ExitCode}}' "$sejire_ci_container")" = 0
docker start "$sejire_ci_container"
docker exec "$sejire_ci_container" node -e "$sejire_health_check"
docker exec "$sejire_ci_container" node -e 'const fs=require("node:fs");if(!fs.readdirSync("/data/backups").length)throw Error("backup_missing");console.log("Persistent SQLite and backup directory survived restart")'
docker stop --time 20 "$sejire_ci_container"
test "$(docker inspect --format '{{.State.ExitCode}}' "$sejire_ci_container")" = 0
