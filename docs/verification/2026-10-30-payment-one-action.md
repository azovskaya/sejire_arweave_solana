# Solana paid preservation: one explicit action

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

Real Chrome Phantom approval and the final state of the owner's existing order still require owner-side acceptance with the original browser data. Final Arweave settlement is distinct from the application's verified archive retrieval.
