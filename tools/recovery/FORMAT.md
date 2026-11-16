# SEJIRE independent recovery format, version 1

This document specifies how an unrelated implementation can recover existing
SEJIRE archives. It does not require the SEJIRE website, a wallet, Cloudflare,
Solana, ArNS, a gateway, or an operator account when the encrypted file is present.
It freezes the existing `sejire/envelope/v1` and `sejire/v0.3` derivation; it does
not introduce a new key, password, ciphertext format, or migration.

## 1. Exact key derivation

The secret is a **SEJIRE archive phrase**, not a payment wallet phrase. The
existing application generates 128 random entropy bits and represents them as
12 BIP39 English words. An optional BIP39 passphrase is **not used**.

1. Trim input, convert to lowercase, split on whitespace, and join with one ASCII
   space. Apply Unicode NFKD. There must be exactly 12 words from `english.txt`.
2. Convert each word to its zero-based index in that 2,048-word list. Concatenate
   the 12 unsigned 11-bit indexes, most significant bit first: 132 bits total.
   The first 128 bits are entropy; the last four must equal the first four bits
   of SHA-256(entropy). Reject a failed checksum.
3. `seed = PBKDF2-HMAC-SHA512(UTF8(normalized_words), UTF8("mnemonic"), 2048, 64)`.
   Both the phrase and BIP39 salt use NFKD. The output is 64 bytes. There is no
   added passphrase, email, site identifier, server secret, or wallet address.
4. `master = HKDF-SHA256(seed, salt = 32 zero bytes, info = UTF8("sejire/v1"), length = 32)`.
5. `encKey = HKDF-SHA256(master, salt = 32 zero bytes, info = UTF8("enc"), length = 32)`.
6. `vault_id = lower_hex(SHA256(master || UTF8("vault")))[0:32]`.
   This is **32 hexadecimal characters representing 16 bytes**, not 16 characters.

HKDF means RFC 5869 extract followed by expand. With SHA-256, each output above
fits in one expand block: `HMAC-SHA256(PRK, info || 0x01)`. `||` concatenates
bytes. Do not derive or regenerate an Arweave RSA wallet to decrypt an archive.

`english.txt` is the canonical English BIP39 list, one word per line in its
original order, with a final LF. Its SHA-256 is
`2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`.
The decoder includes the same list internally. Attribution is in `LICENSES.txt`
and the decoder itself.

## 2. Envelope and authenticated decryption

An archive is a UTF-8 JSON object containing exactly these fields:

| Field | Value |
| --- | --- |
| `schema` | `sejire/envelope/v1` |
| `protocol` | `sejire/v0.3` |
| `vault_id` | The 32-character lowercase hexadecimal locator above |
| `cipher` | `aes-gcm-256` |
| `kdf` | `hkdf-sha256` |
| `iv` | Standard base64 of the 12-byte AES-GCM nonce; exactly 16 base64 characters |
| `ciphertext` | Standard base64 of encrypted UTF-8 JSON followed by its 16-byte authentication tag |

Check the derived `vault_id` against the envelope. Decode base64 using the
standard `+/` alphabet, not base64url. AES-256-GCM uses `encKey`, the 12-byte IV,
a 128-bit tag, and **no additional authenticated data**. The last 16 decoded
ciphertext bytes are the authentication tag; preceding bytes are the encrypted
payload. WebCrypto accepts the concatenation directly. Reject authentication
failure; do not attempt to repair or partially disclose unauthenticated bytes.

Parse the authenticated plaintext as UTF-8 JSON. The independent decoder writes
the exact authenticated plaintext bytes and does not coerce, drop, merge, or
rewrite fields. Its JSON parsing behavior matches the existing WebCrypto reader.
The outer metadata is checked against fixed v1 values; `vault_id` alone is not
proof of ownership, and a public tag alone does not authenticate a history.

The current envelope parser accepts at most 10,485,760 base64 characters in
`ciphertext`, a base64 length divisible by four, and at least 24 characters.
Canonical product exports additionally limit the serialized file to 10 MiB.
This tool retains the existing ciphertext bound and allows up to 64 MiB for the
outer input file, including whitespace or a recovery-kit wrapper. This larger
file bound protects memory use without rejecting canonical existing exports.

## 3. Portable recovery kit

A raw envelope remains supported. A new kit wraps its **exact original text**:

```json
{
  "schema": "sejire/recovery-kit/v1",
  "format": "sejire/envelope/v1",
  "archiveText": "<exact serialized envelope JSON string>",
  "archiveDigest": "<64 lowercase hex characters: SHA-256 of UTF8(archiveText)>",
  "archiveBytes": 25269,
  "receipt": null
}
```

Only these six fields are permitted. The byte count is a positive safe integer.
Check both byte count and digest **before decryption**. Never parse and reserialize
`archiveText` before checking or recovering the stored bytes. Whitespace and
property order affect its digest. No words, private keys, bearer tokens, or
plaintext belong in the kit. A kit is useful before a network upload succeeds:
its receipt is then `null`, and it makes no publication claim.

An optional `receipt` has exactly these fields:

| Field | Constraint |
| --- | --- |
| `schema` | `sejire/direct-arweave-receipt/v1` |
| `protocol` | `sejire/v0.3` |
| `encryption` | `sejire/envelope/v1` |
| `network` | `arweave.N.1` |
| `transactionId`, `ownerAddress` | Each 43 base64url characters |
| `vaultId` | Must match the envelope |
| `parentTxId` | A 43-character base64url ID or `null` |
| `archiveDigest`, `archiveBytes` | Must match the exact archived text |
| `rewardWinston` | A nonnegative decimal integer string without redundant leading zeros |
| `createdAt` | A parseable date/time string; new writers use ISO 8601 |

Offline receipt validation checks structure and binding only. A receipt is
portable metadata; it is **not** independent proof of payment, transaction
signature, inclusion, permanence, or current availability. This decoder neither
contacts a chain nor selects the latest version. A receipt without ciphertext
cannot be decrypted offline. Historic paid/native receipts remain usable through
their existing readers; importing their ciphertext as a raw envelope remains
compatible with this tool.

## 4. Reading the recovered JSON without SEJIRE

Normal vault payloads identify `schema: "sejire/vault/v1"` and `vault_id`.
`trees` maps tree IDs to complete stored trees; `active_tree_id` is a UI selection.
Each tree contains `meta`, `draft`, `commits`, `versions`, and `dirty`.

* `draft.persons` maps person IDs to name, dates, notes, parent IDs, and media refs.
* `commits` maps commit IDs to immutable saved snapshots. A commit records
  `parent_commit_id`, its version number, author, date, message, and
  `snapshot.persons`.
* `versions` maps version numbers to commit IDs; `meta.head` identifies a saved
  head. Keep all snapshots, relationships, and unknown fields when converting
  formats. The decoder intentionally does not discard older history.
* `parents` contains person IDs, not array positions. `media[].tx` points to a
  separately stored media object. `meta.tamgaUrl` can also be an external link.
  The presence of a reference does not include the referenced media bytes in
  the encrypted tree. Preserve those objects separately if they matter.

The current tree editor does not upload media. This describes the archive's
coverage; it does not block recovery of the stored tree JSON or its references.

Any text editor or unrelated JSON program can read the recovered file. It is
private plaintext: store or share it only deliberately. This format supports
interpretation without the original rendering engine or account system.

## 5. Longevity and trust boundary

The durable object is the encrypted file plus a documented decoding method.
Keep independent copies of ciphertext, digest, known transaction IDs, this tool,
the specification, and the phrase in separate private custody. A phrase alone
does not contain the family data. Losing every data copy or losing the phrase
can make recovery impossible. Anyone with the phrase and ciphertext can decrypt.

Arweave's endowment prices long-term replicated storage using an economic model
based on 200 years at current costs. That is not a guarantee that a particular
domain, gateway, application runtime, organization, or cryptographic assumption
will remain usable for 200 years. ArNS resolves a mutable name to an ID;
gateways provide delivery and indexing. They do not replace local backups or
the encryption key. Reading a preserved file offline needs none of them.

This tool verifies AES authentication and the kit's byte binding. It does not
prove Arweave inclusion, completeness/freshness of all versions, enduring network
availability, or the safety of a copy of the tool downloaded from an untrusted
site. Preserve a reviewed decoder and its digest independently. Compatible
future implementations can use this specification if Node or browsers change.

Primary specifications and background, checked 2026-11-16:

* BIP39: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
* HKDF: https://www.rfc-editor.org/rfc/rfc5869
* AES-GCM: https://csrc.nist.gov/pubs/sp/800/38/d/final
* Arweave endowment: https://github.com/ArweaveTeam/docs.arweave.org-info/blob/master/development/protocol/overview.md
* Gateway roles: https://docs.ar.io/learn/gateways
* Content verification: https://docs.ar.io/learn/verification/client-side-verification
* Name resolution: https://docs.ar.io/learn/arns
