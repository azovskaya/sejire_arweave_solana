# Build from the repository root: docker build -f deployment/Dockerfile .
FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
COPY apps/sponsor/package.json apps/sponsor/package-lock.json apps/sponsor/
RUN npm ci --prefix apps/sponsor
COPY apps/sponsor/src apps/sponsor/src
COPY apps/sponsor/linux-server.mjs apps/sponsor/linux-writer.mjs apps/sponsor/trusted-ingress.mjs apps/sponsor/
COPY apps/sponsor/ledger-snapshot.mjs apps/sponsor/ledger-snapshot.mjs
COPY apps/sponsor/bin/import-ledger.mjs apps/sponsor/bin/import-ledger.mjs
COPY apps/web/src/lib/crypto/envelope.ts apps/web/src/lib/crypto/envelope.ts
COPY apps/web/src/lib/solana/policy.ts apps/web/src/lib/solana/policy.ts
COPY packages packages
COPY scripts/linux-backup.mjs scripts/linux-backup-cli.mjs scripts/
COPY deployment/build-server.mjs deployment/server-entry.mjs deployment/
RUN node deployment/build-server.mjs

FROM node:24.22.3-bookworm-slim AS dependencies
WORKDIR /app
COPY apps/sponsor/package.json apps/sponsor/package-lock.json apps/sponsor/
RUN npm ci --prefix apps/sponsor --omit=dev --ignore-scripts \
    && npm audit --prefix apps/sponsor --omit=dev --audit-level=high \
    && npm cache clean --force

FROM node:24.22.3-bookworm-slim
ENV NODE_ENV=production \
    SEJIRE_LINUX_HOST=0.0.0.0 \
    SEJIRE_LINUX_PORT=8787 \
    SEJIRE_LINUX_DB=/data/sejire.sqlite \
    SEJIRE_BACKUP_DIR=/data/backups \
    CHECKOUT_API_ENABLED=false \
    CHECKOUT_PAID_ENABLED=false \
    CHECKOUT_PAID_EXECUTION_ENABLED=false \
    FUND_API_ENABLED=false
WORKDIR /app/apps/sponsor
COPY --from=dependencies /app/apps/sponsor/package.json ./package.json
COPY --from=dependencies /app/apps/sponsor/node_modules ./node_modules
COPY --from=build /app/apps/sponsor/build ./build
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:8787/healthz",{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
STOPSIGNAL SIGTERM
CMD ["node", "build/server.mjs"]
