/** Development only. Uses PUBLIC BIP39 vectors, never personal phrases or keys. */
import { writeFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { deriveKeysFromMnemonic } from '../../apps/web/src/lib/crypto/keys';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const publicWords = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
];
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const vectors = [];
for (const [index, words] of publicWords.entries()) {
  const keys = deriveKeysFromMnemonic(words);
  const snapshot = { persons: {
    parent: { id: 'parent', name: 'PUBLIC SYNTHETIC Parent', parents: [], media: [], notes: 'Тек қана тест / Только тест' },
    child: { id: 'child', name: 'PUBLIC SYNTHETIC Child', parents: ['parent'], media: [], notes: 'No real family data' },
  } };
  const tree = (id: string) => ({
    meta: { id, title: 'PUBLIC SYNTHETIC ' + id, head: 'commit-2', next_version: 3, created_at: '2026-01-01T00:00:00.000Z', author: 'synthetic' },
    commits: {
      'commit-1': { schema: 'sejire/commit/v1', tree_id: id, commit_id: 'commit-1', parent_commit_id: null, version: 1,
        author: 'synthetic', created_at: '2026-01-01T00:00:00.000Z', message: 'Synthetic creation', snapshot },
      'commit-2': { schema: 'sejire/commit/v1', tree_id: id, commit_id: 'commit-2', parent_commit_id: 'commit-1', version: 2,
        author: 'synthetic', created_at: '2026-01-02T00:00:00.000Z', message: 'Synthetic history', snapshot },
    }, versions: { 1: 'commit-1', 2: 'commit-2' }, draft: snapshot, dirty: false,
  });
  const vault = { schema: 'sejire/vault/v1', vault_id: keys.vaultId, updated_at: '2026-01-02T00:00:00.000Z',
    trees: { first: tree('first'), second: tree('second') }, active_tree_id: 'second',
    synthetic_unknown_field: { preserved: true, values: ['keep', 'all', 'fields'] } };
  const plaintext = JSON.stringify(vault);
  const iv = Uint8Array.from({ length: 12 }, (_, position) => index * 12 + position);
  const key = await crypto.subtle.importKey('raw', new Uint8Array(keys.encKey), 'AES-GCM', false, ['encrypt']);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const envelope = { schema: 'sejire/envelope/v1', vault_id: keys.vaultId, cipher: 'aes-gcm-256', kdf: 'hkdf-sha256',
    iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(cipher).toString('base64'), protocol: 'sejire/v0.3' };
  // One canonical and one pretty envelope prove the digest binds exact serialization.
  const archiveText = index ? JSON.stringify(envelope, null, 2) + '\n' : JSON.stringify(envelope);
  vectors.push({ label: 'PUBLIC SYNTHETIC ONLY — never use for money or private data', words,
    expectedSeedHex: hex(keys.seed), expectedMasterHex: hex(keys.master), expectedEncKeyHex: hex(keys.encKey),
    expectedVaultId: keys.vaultId, archiveText, archiveDigest: digest(archiveText), archiveBytes: Buffer.byteLength(archiveText),
    expectedPlaintext: plaintext, expectedPlaintextDigest: digest(plaintext) });
}
await writeFile(new URL('./public-vectors.json', import.meta.url), JSON.stringify({ schema: 'sejire/public-recovery-vectors/v1',
  warning: 'ALL WORDS, KEYS AND DATA IN THIS FILE ARE PUBLIC SYNTHETIC TEST VECTORS. NEVER FUND OR USE FOR PERSONAL DATA.', vectors }, null, 2) + '\n');
console.log('Generated two PUBLIC synthetic recovery vectors from production derivation + WebCrypto.');
