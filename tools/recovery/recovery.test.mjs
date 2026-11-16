import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm, copyFile, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGLISH_WORDS, MAX_CIPHERTEXT_CHARS, MAX_INPUT_FILE_BYTES, deriveKeysFromWords, hex,
  parseArchiveText, parseEnvelope, recoverText, runCli, validateWords } from './recover.mjs';

const root = new URL('./', import.meta.url);
const { vectors } = JSON.parse(await readFile(new URL('./public-vectors.json', root), 'utf8'));
const first = vectors[0], second = vectors[1];
const hash = value => createHash('sha256').update(value).digest('hex');
const kit = vector => ({ schema: 'sejire/recovery-kit/v1', format: 'sejire/envelope/v1', archiveText: vector.archiveText,
  archiveDigest: vector.archiveDigest, archiveBytes: vector.archiveBytes, receipt: null });
const receipt = vector => ({ schema: 'sejire/direct-arweave-receipt/v1', protocol: 'sejire/v0.3', encryption: 'sejire/envelope/v1',
  network: 'arweave.N.1', transactionId: 'A'.repeat(43), vaultId: vector.expectedVaultId, parentTxId: null,
  archiveDigest: vector.archiveDigest, archiveBytes: vector.archiveBytes, ownerAddress: 'B'.repeat(43), rewardWinston: '123', createdAt: '2026-01-02T00:00:00.000Z' });
const fail = code => error => error?.code === code;

test('the embedded BIP39 list matches the independent published list and its fixed digest', async () => {
  const text = await readFile(new URL('./english.txt', root), 'utf8');
  assert.equal(ENGLISH_WORDS.length, 2048); assert.equal(new Set(ENGLISH_WORDS).size, 2048);
  assert.equal(ENGLISH_WORDS.join('\n') + '\n', text);
  assert.equal(hash(text), '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
});

test('BIP39 checksum, twelve-word restriction, whitespace, case and NFKD are enforced compatibly', async () => {
  const spaced = '\t ' + first.words.toUpperCase().split(' ').join('\u00a0\n') + ' \r\n';
  const fullwidth = first.words.replace(/[a-z]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0));
  assert.equal(await validateWords(spaced), first.words);
  assert.equal(await validateWords(fullwidth), first.words);
  for (const words of ['abandon '.repeat(12), first.words + ' abandon', first.words.replace('about', 'notaword'), '', 'zoo '.repeat(24)]) {
    await assert.rejects(() => validateWords(words), fail('invalid_words'));
  }
});

test('public production-derived vectors match every derivation stage and preserve all plaintext bytes/history', async () => {
  for (const vector of vectors) {
    const keys = await deriveKeysFromWords(vector.words);
    assert.equal(hex(keys.seed), vector.expectedSeedHex); assert.equal(hex(keys.master), vector.expectedMasterHex);
    assert.equal(hex(keys.encKey), vector.expectedEncKeyHex); assert.equal(keys.vaultId, vector.expectedVaultId);
    const result = await recoverText(vector.archiveText, vector.words);
    assert.equal(result.archiveText, vector.archiveText); assert.equal(result.archiveDigest, vector.archiveDigest);
    assert.equal(result.archiveBytes, vector.archiveBytes);
    assert.equal(new TextDecoder().decode(result.plaintext), vector.expectedPlaintext);
    assert.equal(hash(result.plaintext), vector.expectedPlaintextDigest);
    const vault = JSON.parse(vector.expectedPlaintext);
    assert.equal(Object.keys(vault.trees).length, 2); assert.equal(Object.keys(vault.trees.first.commits).length, 2);
    assert.deepEqual(vault.trees.first.draft.persons.child.parents, ['parent']);
    assert.equal(vault.synthetic_unknown_field.preserved, true);
  }
});

test('a kit retains exact serialized ciphertext and validates its optional receipt without chain requests', async () => {
  const value = kit(second); value.receipt = receipt(second);
  const result = await recoverText(JSON.stringify(value), second.words);
  assert.equal(result.archiveText, second.archiveText);
  assert.deepEqual(result.receipt, value.receipt);
  assert.equal(new TextDecoder().decode(result.plaintext), second.expectedPlaintext);
  assert.equal((await parseArchiveText(JSON.stringify(kit(first)))).receipt, null);
});

test('kit corruption and mismatched receipt bindings fail before recovery', async () => {
  const compacted = { ...kit(second), archiveText: JSON.stringify(JSON.parse(second.archiveText)) };
  for (const value of [compacted, { ...kit(first), archiveBytes: first.archiveBytes + 1 }, { ...kit(first), archiveDigest: '0'.repeat(64) }]) {
    await assert.rejects(() => parseArchiveText(JSON.stringify(value)), fail('archive_integrity_failed'));
  }
  for (const changes of [{ archiveDigest: '0'.repeat(64) }, { archiveBytes: first.archiveBytes + 1 }, { vaultId: second.expectedVaultId },
    { network: 'testnet' }, { transactionId: '../unsafe' }, { parentTxId: 'short' }, { rewardWinston: '-1' }, { createdAt: 'bad date' }]) {
    await assert.rejects(() => parseArchiveText(JSON.stringify({ ...kit(first), receipt: { ...receipt(first), ...changes } })), fail('receipt_mismatch'));
  }
  await assert.rejects(() => parseArchiveText(JSON.stringify({ ...kit(first), mnemonic: first.words })), fail('invalid_recovery_kit'));
});

test('wrong words and changes to authenticated ciphertext or IV never return plaintext', async () => {
  await assert.rejects(() => recoverText(first.archiveText, second.words), fail('vault_id_mismatch'));
  const original = JSON.parse(first.archiveText);
  const bytes = Buffer.from(original.ciphertext, 'base64'); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(() => recoverText(JSON.stringify({ ...original, ciphertext: bytes.toString('base64') }), first.words), fail('decrypt_failed'));
  const iv = Buffer.from(original.iv, 'base64'); iv[0] ^= 1;
  await assert.rejects(() => recoverText(JSON.stringify({ ...original, iv: iv.toString('base64') }), first.words), fail('decrypt_failed'));
});

test('envelope shape and existing ciphertext size boundary remain strict without narrowing valid inputs', () => {
  const original = JSON.parse(first.archiveText);
  assert.equal(parseEnvelope({ ...original, ciphertext: 'A'.repeat(MAX_CIPHERTEXT_CHARS) }).ciphertext.length, MAX_CIPHERTEXT_CHARS);
  assert.throws(() => parseEnvelope({ ...original, ciphertext: 'A'.repeat(MAX_CIPHERTEXT_CHARS + 4) }), fail('envelope_too_large'));
  for (const changes of [{ schema: 'sejire/envelope/v2' }, { protocol: undefined }, { iv: 'short' }, { cipher: 'aes-cbc' },
    { ciphertext: 'A'.repeat(25) }, { kdf: 'pbkdf2' }, { vault_id: 'A'.repeat(32) }, { unexpected: true }]) {
    assert.throws(() => parseEnvelope({ ...original, ...changes }), fail('invalid_envelope'));
  }
});

async function cliFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sejire-independent-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tool = join(directory, 'recover.mjs'), archive = join(directory, 'archive.json');
  const blocker = join(directory, 'block-network.cjs');
  await copyFile(new URL('./recover.mjs', root), tool);
  await writeFile(archive, first.archiveText);
  await writeFile(blocker, `const deny=()=>{throw Error('NETWORK_FORBIDDEN_IN_RECOVERY_TEST');}; globalThis.fetch=deny;
for(const name of ['node:http','node:https','node:net','node:tls','node:dns']){const api=require(name);for(const key of ['request','get','connect','createConnection','resolve','lookup'])if(api[key])api[key]=deny;}`);
  const run = (args, words = first.words) => spawnSync(process.execPath, ['--require', blocker, tool, ...args],
    { cwd: directory, input: words, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 15000 });
  return { directory, tool, archive, run };
}

test('copied single-file CLI recovers without npm/network and creates owner-only output without logging secrets', async t => {
  const f = await cliFixture(t), output = join(f.directory, 'private.json');
  const result = f.run([f.archive, output]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined);
  assert.equal(await readFile(output, 'utf8'), first.expectedPlaintext);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  for (const value of [first.words, first.expectedPlaintext, JSON.parse(first.archiveText).ciphertext, 'PUBLIC SYNTHETIC Parent']) {
    assert(!result.stdout.includes(value)); assert(!result.stderr.includes(value));
  }
  assert.equal(await readFile(f.archive, 'utf8'), first.archiveText);
});

test('CLI never overwrites an existing output and never writes output for failed authentication', async t => {
  const f = await cliFixture(t), output = join(f.directory, 'existing.json');
  await writeFile(output, 'do not replace', { mode: 0o600 });
  const exists = f.run([f.archive, output]); assert.equal(exists.status, 1); assert.match(exists.stderr, /output_exists/);
  assert.equal(await readFile(output, 'utf8'), 'do not replace');
  const badOutput = join(f.directory, 'must-not-exist.json');
  const wrong = f.run([f.archive, badOutput], second.words); assert.equal(wrong.status, 1);
  await assert.rejects(() => stat(badOutput), error => error.code === 'ENOENT');
  assert(!wrong.stderr.includes(second.words)); assert(!wrong.stderr.includes(first.expectedPlaintext));
  const args = f.run([f.archive, badOutput, first.words]); assert.equal(args.status, 1); assert(!args.stderr.includes(first.words));
});

test('CLI bounds input files and phrase input before allocating or producing plaintext', async t => {
  const f = await cliFixture(t), oversized = join(f.directory, 'oversized.json'), output = join(f.directory, 'no-output.json');
  const file = await open(oversized, 'w'); try { await file.truncate(MAX_INPUT_FILE_BYTES + 1); } finally { await file.close(); }
  const large = f.run([oversized, output]); assert.equal(large.status, 1); assert.match(large.stderr, /input_too_large/);
  const phrase = f.run([f.archive, output], 'x'.repeat(2049)); assert.equal(phrase.status, 1); assert.match(phrase.stderr, /invalid_words/);
  await assert.rejects(() => stat(output), error => error.code === 'ENOENT');
});

test('UTF-8 normalization is unchanged when stdin splits a word inside a multibyte code point', async t => {
  const f = await cliFixture(t), output = join(f.directory, 'unicode.json');
  const fullwidth = first.words.replace(/[a-z]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0));
  const bytes = Buffer.from(fullwidth), pieces = Array.from(bytes, byte => Buffer.from([byte]));
  let stdout = '', stderr = '';
  const sink = append => new Writable({ write(chunk, _encoding, callback) { append(String(chunk)); callback(); } });
  assert.equal(await runCli([f.archive, output], Readable.from(pieces), sink(value => { stdout += value; }), sink(value => { stderr += value; })), 0);
  assert.equal(await readFile(output, 'utf8'), first.expectedPlaintext); assert.equal(stderr, ''); assert(!stdout.includes(fullwidth));
});

test('HTML is a reproducible self-contained decoder with CSP blocking network and exact inline hashes', async () => {
  const html = await readFile(new URL('./recovery.html', root), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert(script && style); assert(!/<script[^>]+src=|<link[^>]+href=|<iframe|<img\b/i.test(html));
  assert.match(html, /connect-src 'none'/); assert.match(html, /form-action 'none'/);
  for (const body of [script, style]) assert(html.includes('sha256-' + createHash('sha256').update(body).digest('base64')));
  assert(!script.includes('node:fs')); assert(!script.includes('fetch(')); assert(!script.includes('localStorage'));
  const check = spawnSync(process.execPath, [fileURLToPath(new URL('./build-html.mjs', root)), '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});
