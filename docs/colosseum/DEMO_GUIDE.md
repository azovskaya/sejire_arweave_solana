# SEJIRE judge demo guide

## Public links

- Protocol: https://azovskaya.github.io/sejire_arweave_solana/
- Recovery: https://azovskaya.github.io/sejire_arweave_solana/#/restore
- Source: https://github.com/azovskaya/sejire_arweave_solana
- Build provenance: https://azovskaya.github.io/sejire_arweave_solana/build-provenance.json

## What judges can test immediately

1. Open the public protocol.
2. Select English.
3. Create a new family tree without an account or wallet.
4. Add synthetic family members.
5. Review the tree and export options.
6. Open the recovery route and inspect the 12-word recovery interface.

## Full end-to-end demo

The complete preservation flow requires:

- the authorized pilot archive;
- the designated Solana Devnet payer;
- the designated Arweave reserve wallet;
- explicit Phantom and Wander approvals.

For safety, these credentials are not published in the repository.

The product-demo video shows the complete synthetic flow:

1. Create a test family tree.
2. Encrypt it locally.
3. Use 12 synthetic recovery words.
4. Verify the `0.03 SOL` Solana Devnet payment.
5. Preserve the encrypted archive on Arweave Mainnet.
6. Retrieve and verify the raw archive.
7. Open a clean browser.
8. Recover the tree using only the 12 words.

Product-demo video URL:

`[ADD PUBLIC OR UNLISTED DEMO VIDEO URL]`

## Reproduce the synthetic browser tests locally

```bash
npm ci --prefix apps/web
npm ci --prefix apps/sponsor

npm run test:v2-browser --prefix apps/web
npm run test:v2-recovery-browser --prefix apps/web
npm run test:admin-browser --prefix apps/web
```

These tests use synthetic archives and mocked wallets. They make no real payment and publish no real family archive.

## Expected proof points

- no account or wallet is required to build a tree;
- plaintext family data is not uploaded;
- payment is verified before preservation;
- the archive is retrieved and integrity-checked after upload;
- recovery works in a clean browser;
- recovery makes no wallet, payment, or upload calls.
