# Checkout asset: USDC vs SOL

Date: 2026-09-30. Status: recommendation for the next approval, NOT final production asset authorization.
Scope: A0/A1 pure order/validator foundation. No real checkout, wallet signature, transfer or treasury created.

| Purpose | SOL | USDC |
|---|---|---|
| $3 service | Needs named USD/SOL rate source, timestamp, TTL and integer rounding | 3,000,000 micro-USDC; USD peg is a disclosed assumption |
| Fund contribution | Volatile budget valuation; a dollar promise needs a haircut/hedge or prefunded credits | Easier budget/commitment accounting; issuer, depeg/freeze and liquidity dependencies |
| Network fees | Native fee currency | Still needs SOL for fees and possibly token account rent |
| Devnet demo | Reuses current direct Turbo integration | Circle devnet token, no financial value; must test wallet display and split transfers |
| Production | Already prototyped but actual paid extension acceptance is unverified | Transfer support does not prove Turbo top-up support, signer custody, liquidity or paid upload execution |

Recommendation for hackathon: USDC for the new checkout's service and optional contribution, SOL only for network fees. No third token, automatic swap, staking or yield. Preserve the direct SOL/Turbo flow and its independent 0.01 SOL funding cap. This is a recommendation, not enabled functionality.

The A1 data model can describe SOL or USDC to test the decision without coupling contribution acceptance to spending limits. Per-order asset policy is server-owned. USDC/SOL substitution is never accepted merely by a matching dollar value. A future SOL-priced service must name the rate source and conservative rounding policy before enabling it. A1 does not implement exchange rates.

USDC identity (Circle list checked 2026-09-30):
- Devnet: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- Mainnet: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- Six decimals, classic SPL Token program. Mainnet constants are identifiers only: no mainnet RPC/client/transaction is implemented.

Sources, checked 2026-09-30:
- https://developers.circle.com/stablecoins/usdc-contract-addresses — network-specific mint identities; test tokens have no monetary value.
- https://solana.com/docs/payments/accept-payments/verification-tools — server verification, mint/program, finality, multiple transfers and duplicate fulfillment.
- https://docs.solanapay.com/spec — exact amount, token identity and reference; reference alone is not payment proof.
- https://docs.ar.io/build/upload/turbo-credits — irreversible credits and service fees; free tier is conditional. Documentation tables and SDK capabilities can differ.

Applicability: existing web locks `@ardrive/turbo-sdk` 2.1.0 and `@solana/web3.js` 1.99.0. The prior audit inspected SDK 2.1.0 types exposing `solana-usdc`/credit sharing; no actual USDC funding was tested. Solana documentation examples using Kit must not be copied as API-compatible with web3.js. A1 introduces no chain SDK and no raw RPC decoder.

Required proof before choosing/launching: approved real extension devnet payment; exact two-recipient display; official mint/account ownership verification; rejection/account switch; fee/rent disclosure; persisted signature and dropped-response reconciliation; restricted sponsor credits and paid execution. Production additionally needs custody, treasury participants, accounting/legal terms and separately approved live acceptance. Never present tests with normalized fixtures as those proofs.
