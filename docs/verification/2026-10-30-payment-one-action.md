# Solana paid preservation: one explicit action

## Follow-up: expired unsigned preparation

The first released one-action flow classified an elapsed `paymentExpiresAt` as `previous_payment_unresolved` in `payPaidOperation`. The panel only entered the existing explicit recovery path for `payment_preparation_expired`, so an unsigned preparation left after a balance/RPC preflight refusal or a Phantom `4001` rejection could stay stuck on the primary button. The corrected client emits `payment_preparation_expired` only after it has checked that no local or server signature, payment, execution, recovery intent or cancellation exists. The panel then asks the server to reconcile and fence the old preparation for the same immutable order. An unresolved signed attempt still cannot request a new signature.

The client also checks the payment window and finalized block height again after journaling `signingStarted`, immediately before `signTransaction`. If this check fails, it clears that intent because the wallet was never called. Once the wallet has actually been called, any returned signature and signed bytes remain journaled even if the preparation expires while Phantom is open. New synthetic browser cases cover the unsigned preflight and `4001` retries, time and block-height expiry before the wallet call, and a known signature that cannot trigger renewal. The original 17 browser cases remain in the suite. TypeScript and syntax checks passed locally; the complete browser/build gate is run in Ubuntu CI because the installed esbuild binary is incompatible with this Catalina machine.

## Scope and evidence

The production build inspected before this change identified source `9f43026` in `build-provenance.json`. The user-reported order cannot be assigned a precise server state without the original browser journal and authorized backend access. This note contains no personal order identifier or family data. The proposed `2026-10-30-payment-preflight.md` did not exist in the inspected working trees or fetched feature branch.

Confirmed code causes:

- `PaidSolanaFlow.pay` returned immediately after `preparePaidOperation`, requiring a second click and the separate checkbox before `payPaidOperation`. The same flow exposed connect, recovery, refresh and status buttons at once.
- `PaidSolanaFlow.check` cleared its general error after every successful poll, including an unchanged result. A transient failure could therefore disappear without a successful transition. The earlier recovery-specific fix did not cover general errors.
- `payPaidOperation` checked fee and balance but did not compare finalized block height with the prepared transaction's `lastValidBlockHeight` before invoking Phantom. A transaction can expire before the 15-minute order window. `getFeeForMessage: null` was parsed as an opaque error, without first determining whether the blockhash had expired.

The reported disappearing message is consistent with the unconditional poll clear. The exact original network/worker failure remains unproven.

## Design choice

Three workable approaches were considered: (1) keep the existing explicit technical buttons; (2) introduce a new backend orchestration protocol; (3) orchestrate the existing durable order, preparation, signature reserve, reconciliation and archive executor behind one explicit client action. Option 3 keeps the server's immutable order and atomic reserve/recovery fence, avoids a new payment contract, and makes the normal path a single button. Polling performs reconciliation only and never opens a wallet.

The client click now connects Phantom if needed, creates or adopts the durable order, prepares an exact transaction, checks current fee, balance, network genesis and finalized block height, then invokes `signTransaction`. The wallet status begins only after that call has actually been made. Signed bytes are written to the journal before `POST /reserve`; reserve precedes `sendTransaction`. A lost response continues the same operation. An expired unsigned preparation invokes the existing server recovery protocol only inside the explicit click. That protocol checks old payment evidence and finalized expiry before issuing a successor for the same immutable order. A late signature remains journaled even if the panel closes or its blockhash expires.

The primary panel shows configured price, a separate estimated fee when available, Mainnet destinations and one primary action. Technical controls, order ID, alternate wallet and encrypted backup are in “Подробнее”. Optional contribution defaults to zero; the promo path and SEJIRE words are unchanged.

## Safe continuation by failure stage

| Stage | What may have happened | Safe continuation |
| --- | --- | --- |
| Order | POST may have been admitted despite a lost reply | GET by idempotency key, then retry the identical request only after scoped 404 |
| Preparation | No wallet call yet; blockhash may have expired | Check the same order; server-fenced recovery only after finalized expiry and complete reference scan |
| Network/RPC, fee, balance | No wallet call if preflight failed | Keep the same order and retry the explicit action; never infer nonpayment from timeout or null |
| Wallet | 4001 is an explicit rejection; other outcomes are uncertain | 4001 permits a new explicit attempt; uncertain results reconcile first and do not auto-sign |
| Signature reserve | Signed bytes may be durable locally or accepted by server | Reuse the identical signature and preparation; do not broadcast before reserve acceptance |
| Broadcast, payment check | Transfer may have landed despite a lost response | Reconcile the original signature/reference and rebroadcast only identical signed bytes when allowed |
| Arweave | SOL payment can be confirmed while archive is pending | Continue the same paid job and signed archive plan; no new SOL payment |

The UI retains an error until an explicit retry or a meaningful paid/completed transition. Safe error stage and code are visible in “Подробнее”. No recovery words, wallet secrets, signed bytes or tree contents are included in messages or this report.

## Verification

TypeScript and syntax checks passed locally. The old macOS runtime cannot execute the current `esbuild` binary (`_SecTrustCopyCertificateChain`), so the full browser and build gates must run in the project's Ubuntu/Node 22 CI. Synthetic browser regressions cover the single click, first connection and reuse, rejection, unknown result, amount/fee/RPC/network preflight, expired preparation, lost create/reserve/send/verify replies, double click, another tab, late signature, reload, Arweave continuation and recovery of the encrypted archive. No live payment or archive upload was made.

The core flow at source `e2b0859` passed the complete [GitHub checks run 41394978816](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/41394978816), including 16 synthetic paid browser cases and the existing sponsor, promo, native, protocol, recovery and editor gates. Source `1755fa1459b0eba334ef3b1c1b08172af682b5f0` added RU/KK/EN labels and the optional-contribution regression. Its [full checks run 41396889140](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/41396889140) passed all gates, including 17 synthetic paid browser cases and the read-only two-gateway Arweave check. An earlier run of the same SHA passed all paid cases but was stopped by a temporary `arweave.net` HTTP/CORS failure; the later complete gate and a separate local read-only run passed without changing the gate. The second-tab regression tests the shared journal reservation while the first tab awaits Phantom; archive import and retrieval are covered by a separate complete-flow case.

On 2 November the production Worker's fixed, read-only `/api/checkout/rpc-health` returned `ready: true` after checking genesis, both recipients, blockhash, fee, balance, block height, signature history/status and transaction retrieval. This is current RPC availability evidence, not evidence that the owner's order was paid. [Pages run 41397869747](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/41397869747) published the verified artifact at the public root and passed its clean-browser HTTPS checks. The public `build-provenance.json` and loaded JS matched `1755fa1459b0eba334ef3b1c1b08172af682b5f0`; the JS contained the new primary payment action and no old primary confirmation button. A later documentation-only commit must have its own exact-SHA CI and Pages provenance before it becomes the public source head.

Real Chrome Phantom approval and the final state of the owner's existing order still require owner-side acceptance with the original browser data. Final Arweave settlement is distinct from the application's verified archive retrieval.
