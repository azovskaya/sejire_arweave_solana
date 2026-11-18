/** Interoperability with the existing production crypto. No network, real keys, or uploads. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { deriveKeysFromMnemonic } from '../../apps/web/src/lib/crypto/keys';
import { encryptJson, decryptJson } from '../../apps/web/src/lib/crypto/encrypt';
import { parseEnvelope as productionParseEnvelope } from '../../apps/web/src/lib/crypto/envelope';
import { isValidMnemonic } from '../../apps/web/src/lib/crypto/bip39';
import { ENGLISH_WORDS, MAX_CIPHERTEXT_CHARS, deriveKeysFromWords, parseEnvelope, recoverText, validateWords } from './recover.mjs';
import { wordlist } from '../../apps/web/node_modules/@scure/bip39/wordlists/english.js';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const { vectors } = JSON.parse(await readFile(new URL('./public-vectors.json', import.meta.url), 'utf8'));
assert.deepEqual(ENGLISH_WORDS, wordlist);
for (const vector of vectors) {
  const production = deriveKeysFromMnemonic(vector.words), independent = await deriveKeysFromWords(vector.words);
  for (const key of ['seed', 'master', 'encKey'] as const) assert.deepEqual(independent[key], production[key]);
  assert.equal(independent.vaultId, production.vaultId);
  const payload = JSON.parse(vector.expectedPlaintext);
  // Fresh production AES-GCM nonce proves recovery does not merely know a fixed vector.
  const liveEnvelope = await encryptJson(production.encKey, production.vaultId, payload);
  assert.deepEqual(parseEnvelope(liveEnvelope), productionParseEnvelope(liveEnvelope));
  const recovered = await recoverText(JSON.stringify(liveEnvelope), vector.words);
  assert.equal(new TextDecoder().decode(recovered.plaintext), JSON.stringify(payload));
  const publicEnvelope = productionParseEnvelope(JSON.parse(vector.archiveText));
  assert.deepEqual(await decryptJson(production.encKey, publicEnvelope), payload);
}
const first = vectors[0], envelope = JSON.parse(first.archiveText);
const normalizeCases = [first.words, first.words.toUpperCase().replaceAll(' ', '\t\n'),
  first.words.replace(/[a-z]/g, (char: string) => String.fromCharCode(char.charCodeAt(0) + 0xfee0)),
  'abandon '.repeat(12), first.words + ' abandon', '', 'zoo '.repeat(24)];
for (const words of normalizeCases) {
  let accepted = true; try { await validateWords(words); } catch { accepted = false; }
  assert.equal(accepted, isValidMnemonic(words), 'mnemonic acceptance must match production');
}
const parserCases = [envelope, { ...envelope, ciphertext: 'A'.repeat(MAX_CIPHERTEXT_CHARS) },
  { ...envelope, ciphertext: 'A'.repeat(MAX_CIPHERTEXT_CHARS + 4) },
  ...[{ protocol: undefined }, { schema: 'unsupported' }, { ciphertext: 'A'.repeat(25) }, { iv: 'invalid' }, { extra: true },
    { vault_id: 'A'.repeat(32) }, { cipher: 'aes-cbc' }, { kdf: 'scrypt' }].map(changes => ({ ...envelope, ...changes }))];
for (const value of parserCases) {
  let expected = true, actual = true;
  try { productionParseEnvelope(value); } catch { expected = false; }
  try { parseEnvelope(value); } catch { actual = false; }
  assert.equal(actual, expected, 'envelope acceptance and size limits must match production');
}
// Earlier offline continuation fixtures were generic JSON, not renderer-validated
// vaults. Recovery must preserve those too, without silently normalizing fields.
const keys = deriveKeysFromMnemonic(first.words);
const historicalPayloads = [
  { trees: { a: { history: ['created', 'corrected'] }, b: { custom: 7 } }, active_tree_id: 'a' },
  { trees: [{ id: 'historical-array-shape', unknown: { nested: [[1, 2], [null, true, 'keep']] } }], future_field: [1, { keep: 'all' }] },
];
for (const oldPayload of historicalPayloads) {
  const oldEnvelope = await encryptJson(keys.encKey, keys.vaultId, oldPayload);
  assert.equal(new TextDecoder().decode((await recoverText(JSON.stringify(oldEnvelope), first.words)).plaintext), JSON.stringify(oldPayload));
}
console.log('PASS independent recovery: production BIP39/HKDF/AES-GCM, fresh nonce, parser boundaries, two trees/history and legacy JSON preserved.');

await import('./adversarial-interop.mts');
