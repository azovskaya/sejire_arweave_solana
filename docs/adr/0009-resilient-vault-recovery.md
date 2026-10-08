# ADR 0009 — Resilient vault recovery

Status: accepted on the `feat/preservation-v2-simple` branch. This ADR concerns read-only recovery, not payment or storage authorization.

## Threat model and trust boundaries

The twelve SEJIRE words and derived encryption key stay in browser memory. The browser derives a stable vault ID locally. Indexers, gateway peers, local hints, receipts, and migration manifests are untrusted discovery sources: any of them may lie, omit data, be unavailable, or return stale versions. A `Vault-Id` tag alone is not ownership proof because anyone may publish that tag. The authenticated AES-GCM decryption with the derived key, plus envelope vault ID and vault structure checks, is the final identity filter. No recovery module imports Phantom, Wander, sponsor checkout, or an upload path.

The current gateway REST transaction metadata supplies signed tags, but the client does not independently verify the Arweave RSA transaction signature. A malicious gateway cannot forge a decryptable vault without the SEJIRE key, but it could omit a version or falsify network ordering. Multiple independent index and gateway readers limit that risk; independent Arweave inclusion proof and signed metadata verification are future hardening work. Do not describe a gateway response as cryptographic proof of Arweave inclusion.

## Discovery and routing

`HeadDiscoveryProvider` returns candidate TX IDs only. Three primary GraphQL endpoints and capability-tested GraphQL on dynamically discovered AR.IO peers run in parallel. Optional local TX hints and `legacy-locators.v1.json` add candidates without granting trust. A provider outage differs from a valid empty result. A clean browser can succeed via a locator plus REST metadata and raw data when all GraphQL queries fail. Candidate IDs are deduplicated before verification.

The gateway pool combines recent in-memory successful hosts, peers from the documented `/ar-io/peers` API, configured hosts, and emergency hosts. It limits work to ten gateways and three concurrent requests, with short per-request and overall timeouts. The pool is a thin adapter over Wayfinder's TrustedPeers/Composite model; it avoids adding `@ar.io/wayfinder-core`, `@ar.io/sdk`, and `@solana/kit` to the Catalina-constrained browser bundle. A peer list is routing advice, not a trust anchor. We will reconsider the SDK when Node/toolchain and bundle measurements permit it. GraphQL is used on a peer only after that endpoint returns a valid GraphQL connection.

Official references: [Wayfinder gateway providers](https://docs.ar.io/sdks/wayfinder/wayfinder-core/gateway-providers/), [AR.IO peers API](https://docs.ar.io/apis/ar-io-node/gateway), [GraphQL coverage](https://docs.ar.io/build/access/find-data), [Wayfinder verification strategies](https://docs.ar.io/sdks/wayfinder/wayfinder-core/verification-strategies/).

## Verification and history

For each TX, fetch REST metadata and `/raw/<txId>` through the pool. Modern tags bind app/type, vault ID, schema, archive size/hash, and optional parent. Missing modern fields are tolerated for historical records; a missing vault tag is accepted only for an explicitly listed legacy locator. The raw payload is bounded, size and SHA-256 are checked when published or manifested, UTF-8 and JSON are strict, and the envelope schema/vault ID are checked. Then AES-GCM decrypts locally and every tree is coerced by the existing model. Invalid candidates never become heads.

Verified versions form a graph using `Parent-Tx`. A single verified tip opens automatically. Multiple decryptable tips are retained and shown for explicit selection; the highest verified block height is the default suggestion, with block time as secondary ordering. `Updated-At` is display-only. The selected verified TX becomes the local head only after opening succeeds. A manifest entry for the historical pilot is data, not a special resolver branch. Other old immutable publications can be added as data entries.

Errors distinguish discovery outage, valid empty discovery, unavailable data, metadata or raw mismatch, vault mismatch, decrypt failure, and invalid vault. Diagnostics contain provider IDs, counts, gateway hosts/status classes, and stages; never words, keys, plaintext, or whole ciphertext. The normal UI keeps those details hidden. This recovery path performs only network reads; local vault persistence happens after successful opening under the established session rules.

Potential future providers may read a Solana, AO, or ArNS locator, receipt, or QR hint through the same interface. None is a production dependency today. Any mutable registry requires a separate trust, cost, privacy, and failure analysis.
