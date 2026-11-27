# SEJIRE sponsor edge + permaweb ops

> **Исторический профиль.** Sponsor edge и Turbo не нужны текущему Arweave-only
> runtime, выбранному владельцем 27 ноября 2026. Для нового выпуска применять
> [актуальные инструкции](INDEPENDENT_RELEASE.md); этот текст сохранён для
> прежних операций и не разрешает загрузку из Actions.

## Why your scheme works — and what we change

**Your idea:** project wallet funds the network; user pays ~$3 / ₸ to you; you top up Arweave “under the hood”.

**Keep:** fiat for users, project treasury for AR/Turbo, no token shopping.

**Change (more optimal):**

| Your sketch | Recommended |
|-------------|-------------|
| Card → bank → manual AR top-up | **Kaspi Pay** → verify → **Turbo upload instantly** |
| User wallet needs AR | User never holds AR; edge pays (self-fund = fallback only) |
| Site somehow “runs” from wallet balance | Site is a **one-time permaweb deploy** + rare redeploys from treasury |
| GitHub Pages only | Pages = mirror; **ArNS** = canonical URL |

**Locked for KZ:** Kaspi Business (ИП/ТОО). Stripe is **not** the primary path (`LOCKED_DECISIONS.ru.md`).

## Two wallets (conceptually)

1. **Treasury (project)** — Turbo credits + AR for SPA / ArNS redeploys + sponsoring vault uploads after payment.
2. **User seed wallet** — still derived for encryption identity / optional later Credit Share; **not** funded by the user in sponsor MVP.

## Implementation slices

### Slice 1 — Docs + skeleton ✓
- ADR-0006, flow 10, Worker stub.

### Slice 2 — Cashier + client wire ✓
- Worker: `mock` provider + **live Kaspi Merchant API v2** (`/v1/checkout` → invoice, `/v1/session` poll, `/v1/kaspi-webhook`, `/v1/publish`).
- Client: `VITE_PUBLISH_MODE=sponsor` + `VITE_SPONSOR_URL`; PublishSeedModal pay step + poll.
- Self-fund AR remains as fallback button.
- Live Turbo upload when `TURBO_JWK` is set (else mock tx in mock provider). Mock + treasury is refused.

### Slice 3 — Permaweb site
- Local: `npm run deploy:permaweb` with gitignored `wallet.json`.
- CI: Actions workflow **Upload SEJIRE SPA to Arweave (manual)** — type `pack-ready`; secret `PERMAWEB_JWK`. Never on push. Does not bind ArNS.
- Owner then: Phantom → `sejire` → Target ID.

### Slice 4 — Hardening
- KV idempotency in prod; size quotas; Kaspi refunds; optional Credit Share.

## Env (web)

See `apps/web/.env.sponsor.example`:

```
VITE_PUBLISH_MODE=sponsor
VITE_SPONSOR_URL=http://127.0.0.1:8787
```

Default without these vars: **self-fund** path (unchanged).

## What we need from you to go live

1. **ИП/ТОО** + Kaspi для бизнеса + merchant API token.
2. Exact ₸ price for “навсегда”.
3. Treasury Turbo top-up + `TURBO_JWK` secret.
4. Bind `sejire.ar.io` after first permaweb deploy.
