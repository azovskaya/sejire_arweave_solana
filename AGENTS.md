# SEJIRE — project instructions

When continuing this project on another computer, first read `docs/CONTINUE_ON_ANOTHER_MAC.md`, then `docs/SOLANA_PRESERVATION.md`. Communicate with the owner in Russian unless requested otherwise.

- Before editing or updating Git, inspect the current branch, working tree and remote. Preserve existing work. Do not reset, force-push or merge into `main` as part of the handoff.
- Current continuation branch: `feat/solana-preservation`. The immediate priority is real Chrome wallet-extension acceptance on **devnet**, not a redesign or a new payment system.
- Distinguish software-signer tests from real Phantom/Solflare extension tests, free upload from a SOL payment, and Turbo acceptance from final Arweave settlement.
- Never request, read, log, store in Git or transmit wallet recovery phrases/private keys. SEJIRE archive words are a different secret. Use synthetic family data; wallet approvals are performed by the owner.
- Do not enable mainnet, spend real funds, submit a hackathon entry or deploy without separate explicit authorization. A testnet payment also requires the owner to review its amount and approve it in the wallet.
- Preserve encryption/envelope compatibility, all trees and history, quote limits, journaled retry/reconciliation and separate funding consent. Never replace an unresolved payment with a fresh one automatically.
- Run relevant tests before handing off. Root `npm test` covers web and sponsor suites; `npm run web:build` checks TypeScript/build. See the handoff for installation, lint and opt-in live-test commands.
- Update the handoff with actual evidence and remaining blockers. End each session by stating whether changes are only local, committed, or pushed, with branch and commit when applicable. Push only when authorized by the owner.
