# SOL recipients in Fund Admin

Requested: two owner-editable public Solana receiving addresses in the existing protected Fund Admin.

- The form labels are «Получатель оплаты сохранений» and «Получатель помощи».
- GET/POST `/api/fund/admin/solana-recipients` use the existing server admin authentication, explicit origin checks, bounded JSON, and rate limits. No new credentials are created or stored in the browser.
- Both addresses are validated together, including decoded 32-byte Base58 length, separate roles, rejection of the system account and known disposable pilot addresses. Format validation is not proof of ownership.
- Settings and their public-address audit are durably stored in the existing SQLite Durable Object, not localStorage or an in-memory fallback. Compare-and-set revisions protect against stale tabs; an identical retry does not add a second revision.
- The configured entry adapter resolves recipients for new modern offers/orders only. Existing orders, signed bytes, payments, archives, promo settings and treasury keys are unchanged. Admission is serialized with settings changes; idempotent retries retain their original order.
- Saving recipients does NOT enable admission/execution, select a network, allocate storage funds or perform a transaction. The UI explicitly shows the disabled state.
- `wrangler.toml` uses `src/configuredEntry.ts`, which delegates unchanged routes to the existing Worker and re-exports the same Durable Object. Payment flags remain false.

Verification commands:

```
npm run check --prefix apps/sponsor
npm run test:recipients --prefix apps/sponsor
npm run test:paid-runtime
npm run lint --prefix apps/web
npm run native:build
cd apps/web && npx playwright test --config playwright.sol-recipients.config.mjs
```

The SQLite/HTTP tests deny external network calls and use synthetic addresses. Browser tests use mocked admin responses. Neither constitutes a real SOL payment or live archive publication. Record actual CI/deployment results separately; do not mark them successful until executed.
