# SEJIRE: Crypto World's Fair preparation

Research rechecked: 2026-09-29 against the official event page, rules, FAQ and Superteam listing. Status: first Solana/devnet implementation is in development; no contest application submitted by this work. Account registration status is not verified. See SOLANA_PRESERVATION.md for verified and outstanding checks.

## Provenance

This repository imported an existing SEJIRE product; it was not built from scratch during this hackathon.
Original repository: https://github.com/azovskaya/Sejire_arweave
Imported source: cursor/ao-protocol-v03-82e4 at 22084ac99b69bf3971c3ed75626074ba9a04d078.
Import commit here: 37a1a230934e0bbd9cecb2beb4531c542ab1b5a4.
Exact imported tree: f2d8a4b42e0e628360a72fcb6180e3f98d70e19b.
The original repository retains the full history, including work before and during September 2026. Disclose it in the application. Track new work after this baseline separately; importing files is not new product development.

Existing features include a genealogy editor, PDF/JSON export, browser encryption and recovery, Arweave envelopes, AO code, and a mock/Kaspi payment service. Solana payments were absent from the imported baseline; the new browser-wallet flow is tracked separately. Deployment readiness must be tested separately from source-code availability.

## Contest selection

Primary: Crypto World's Fair, Solana ecosystem track.
The two submission targets are the global hackathon and its separately entered Kazakhstan regional sidetrack, not two independent global hackathons. Both are active as of the research date. SEJIRE fits the regional Consumer Apps category; eligibility still depends on the actual participants.
Official event: https://colosseum.com/worldsfair
Rules: https://colosseum.com/legal/Crypto%20World%27s%20Fair%20Hackathon%20Rules.pdf
FAQ and prior-work policy: https://colosseum.com/hackathon?year=fall2026

Main deadline: 2026-10-12 23:59 America/Los_Angeles, equivalent to 2026-10-13 11:59 Asia/Almaty.
Use October 11 as our internal submission target.
Check team eligibility, residence, prior funding and past contest participation before applying. Submitted materials must be English. Existing work must be disclosed; only in-period work is judged.

Conditional secondary: Superteam Kazakhstan, if residence/team eligibility is met.
https://superteam.fun/earn/listing/colosseum-crypto-worlds-fair-hackathon-superteam-kazakhstan-track
The live description gives October 8 registration and October 10 Demo Day. It requires a complete Colosseum application, accessible code, a working-product demo <=3 minutes and separate pitch <=2 minutes. Confirm the local cutoff timezone with the organizer. The prize card says USDG while the description says USDC; denomination needs confirmation.
On September 29 the official listing's page data reports `status: OPEN`, region Kazakhstan and the overall submission timestamp `2026-10-13T06:59:00.000Z` (October 13, 11:59 Almaty). This overall timestamp does not replace the earlier October 8 registration deadline in the program description. Plan to complete local registration by October 7. One form question still names the earlier Frontier hackathon; confirm that wording with the organizer before submitting. No application or organizer message was sent.
Superteam sidetracks require separate applications:
https://superteam.fun/earn/hackathon/crypto-worlds-fair

Do not expand into unrelated sponsor categories merely to chase rewards. Panta requires prediction-market integration and is not a natural match:
https://superteam.fun/earn/listing/panta-api-side-track

## Product hypothesis (recommendation, not an organizer requirement)

SEJIRE helps families preserve an encrypted family history across generations. Start with Kazakh shezhire and diaspora families; validate broader demand rather than claiming an established global market.

A compelling demonstration: create a family tree, pay from a Solana wallet, store an encrypted version, and recover it on a second device. A relative may pay for preservation without receiving the encryption key. Recovery remains independent of the payer.

Keep Arweave as storage. Use Solana for the payment experience. Never ask for a Phantom seed phrase; SEJIRE recovery words and the payment wallet are separate.

## Architecture decision to validate

First technical spike: direct SOL-funded Turbo upload using a browser wallet. Turbo documents SOL payments and Solana signing:
https://docs.ar.io/build/upload/turbo-credits
https://docs.ar.io/build/upload/bundling-services

This may avoid operating an additional payment cashier for the first demo. Verify browser wallet compatibility, test environments, quote expiry, credit attribution, retries, upload receipts, and recovery by existing tags. A Turbo acknowledgement is not automatically proof of final Arweave settlement. Expose states truthfully.

Alternative: USDC on Solana via Solana Pay plus the existing upload service:
https://docs.solanapay.com/spec
https://solana.com/docs/payments/accept-payments
This offers a stable displayed price but requires server-side verification and reconciliation. The inspected SDK 2.1.0 also exposes solana-usdc, while the documentation matrix inspected earlier lagged behind that capability. Neither path was validated end to end here; the implemented slice deliberately uses SOL.

Choose one complete payment path for the first release, not both. If direct Turbo succeeds, prioritize that integration. Add merchant USDC only if user validation and time justify its operational cost.

For a merchant checkout, bind an order to an immutable encrypted-envelope digest, network, recipient, token mint, integer amount, expiration and random reference. Verify successful finalized payment on the server and atomically reserve its signature. Reject wrong network/mint/amount/recipient/reference, failed transactions and reused signatures. Never trust a client 'paid' flag. Payment success and upload success are distinct states; retries must reuse the same order without double charging. Existing generic payment-session storage is not sufficient evidence of concurrency safety.

Preserve envelope schema, vault ID derivation and recovery compatibility. Publish only ciphertext and minimal metadata. Public wallet activity can reveal relationships even when contents are encrypted; do not claim anonymity. Do not put family names, dates of birth or recovery words in transaction memos.

Do not add a token or NFT merely for judging. A future Solana receipt registry is optional and must justify its cost; it cannot prove biological kinship or grant decryption rights by itself.

## Delivery plan and acceptance

1. Baseline and eligibility: retain provenance, confirm team profiles, validate selected tracks, draft English submission.
2. Payment spike: use a test environment, show quote and network, connect wallet, handle rejection and timeout. Exit criterion: documented reproducible payment/upload path with actual receipts.
3. Integrate publish flow: edit -> encrypt -> pay -> upload -> receipt -> recover. Keep failed/pending/final states explicit.
4. Reliability: test replay prevention if cashier used, duplicate requests, interrupted uploads, wrong-network handling, restore with a separate browser, and restoration of older vaults. Keep live and simulated data visibly distinct.
5. Product validation: recruit 5-10 consenting families. Measure completion rate, time to first saved tree, successful recoveries, and willingness to pay. These are targets, not claimed traction.
6. Submission: English README, architecture diagram, deployed demo, source links, clear old/new work disclosure, two-minute pitch and <=3-minute product demo using synthetic family data. Document actual measured costs and known limits.

Suggested calendar:
- September 28-30: eligibility, user interviews, payment spike.
- October 1-4: first end-to-end integration and recovery.
- October 5-7: user testing, fixes and video drafts.
- October 8: local registration cutoff; have the application materials ready earlier.
- October 9-10: final demo and local Demo Day if eligible.
- October 11: submit complete materials; October 12 reserved for corrections.

## Business validation

The existing $3 price is a hypothesis. Separate raw storage cost from service value. Small uploads may qualify for Turbo's free tier; do not invent a mandatory network charge.
Test willingness to pay for guided preservation, a family gift, or an assisted archive. Count only real users, transactions and revenue. Do not market immutable storage as an unconditional promise that data or keys survive forever.

## Open inputs

Team residence and eligibility; solo/team roster; prior investment and competition history; existing users; available test wallets; eventual public payment recipient and deployment access. Private keys and recovery phrases are never needed in chat.

Winning cannot be guaranteed. Prioritize demonstrable user value, a complete working flow, honest evidence and a clear founder story.
