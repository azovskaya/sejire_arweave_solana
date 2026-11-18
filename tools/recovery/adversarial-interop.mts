/** Bounded, seeded production/offline interoperability. All data are synthetic. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, copyFile, rm, stat, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRecoveryKit, parseIndependentBackup } from '../../apps/web/src/lib/independentBackup';
import { parseEnvelope as productionParseEnvelope } from '../../apps/web/src/lib/crypto/envelope';
import { deriveKeysFromMnemonic } from '../../apps/web/src/lib/crypto/keys';
import { decryptJson } from '../../apps/web/src/lib/crypto/encrypt';
import { openEnvelope, putTree } from '../../apps/web/src/lib/crypto/vault';
import { setDraftPerson } from '../../apps/web/src/lib/treeEngine';
import { parseArchiveText, parseEnvelope, recoverText } from './recover.mjs';
import { productionFixture, PROPERTY_CASES, PROPERTY_SEED, seededRandom } from './fixtures.test-helper.mts';

const fixtures = await Promise.all(Array.from({ length: PROPERTY_CASES }, (_, index) => productionFixture(index)));
const encoder = new TextEncoder();
let groups = 0, rejectedEnvelopes = 0, authenticatedMutations = 0, rejectedKits = 0, truncatedFiles = 0;
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async () => { requests++; throw Error('NETWORK_FORBIDDEN_IN_SYNTHETIC_RECOVERY'); };
async function check(name: string, action: () => Promise<void>) { await action(); groups++; console.log(`PASS ${name}`); }
const noOutput = async (action: () => Promise<unknown>) => { await assert.rejects(action); };
try {
  await check('seeded full vaults preserve every tree, generation, commit, dirty draft, Unicode and unknown field', async () => {
    for (const f of fixtures) {
      const keys = deriveKeysFromMnemonic(f.words);
      try {
        const parsed = await parseIndependentBackup(JSON.stringify(f.kit));
        assert.equal(parsed.kind, 'vault');
        if (parsed.kind !== 'vault') throw Error('expected_synthetic_vault');
        assert.equal(parsed.archiveText, f.archiveText);
        assert.deepEqual(await openEnvelope(keys, parsed.envelope), f.vault);
        for (const input of [f.archiveText, JSON.stringify(f.kit)]) {
          const result = await recoverText(input, f.words);
          assert.deepEqual(result.plaintext, encoder.encode(f.expectedPlaintext), `case ${f.index}`);
          assert.equal(result.archiveText, f.archiveText); result.plaintext.fill(0);
        }
        const restored = await decryptJson<typeof f.vault>(keys.encKey, f.envelope);
        assert.equal(Object.keys(restored.trees).length, f.counts.trees);
        assert.equal(Object.values(restored.trees).reduce((sum, tree) => sum + Object.keys(tree.commits).length, 0), f.counts.commits);
        const active = restored.trees[restored.active_tree_id!], person = Object.values(active.draft.persons)[0];
        const edited = putTree(restored, setDraftPerson(active, { ...person, notes: 'Another explicit edit' }));
        for (const [id, tree] of Object.entries(restored.trees)) {
          if (id !== active.meta.id) assert.deepEqual(edited.trees[id], tree);
          assert.deepEqual(edited.trees[id].commits, tree.commits);
        }
        assert.deepEqual((edited as typeof f.vault).synthetic_future, f.vault.synthetic_future);
        assert.equal(({} as Record<string, unknown>).synthetic_only, undefined);
      } finally { keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0); }
    }
    const repeated = await productionFixture(15);
    assert.equal(repeated.expectedPlaintext, fixtures[15].expectedPlaintext, 'seed fixes all data/history independent of wall clock and AES nonce');
    assert.equal(fixtures[15].counts.generations, 13);
    assert(fixtures.every(f => f.kit.archiveBytes < 1024 * 1024), 'generated suite remains bounded');
  });

  await check('production and standalone envelope readers reject the same bounded malformed field matrix', async () => {
    const original = fixtures[0].envelope;
    const malformed: unknown[] = [null, [], true, 3, 'envelope'];
    for (const field of Object.keys(original)) {
      for (const value of [null, [], {}, 0, true]) malformed.push({ ...original, [field]: value });
      const missing = { ...original } as Record<string, unknown>; delete missing[field]; malformed.push(missing);
    }
    for (const ciphertext of ['AAAA=AAA', 'AAAA====', 'AA_A'.repeat(6), 'AA-A'.repeat(6), 'AAAA\n'.repeat(6), '=AAA'.repeat(6)]) {
      malformed.push({ ...original, ciphertext });
    }
    malformed.push(JSON.parse(JSON.stringify(original).slice(0, -1) + ',"__proto__":{"polluted":true}}'));
    for (const value of malformed) {
      assert.throws(() => productionParseEnvelope(value)); assert.throws(() => parseEnvelope(value)); rejectedEnvelopes++;
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  await check('seeded ciphertext flips, every nonce byte, truncation and appended bytes never authenticate', async () => {
    const f = fixtures[3], keys = deriveKeysFromMnemonic(f.words), random = seededRandom(PROPERTY_SEED);
    try {
      const cipher = Buffer.from(f.envelope.ciphertext, 'base64'), positions = new Set([0, 1, 15, cipher.length - 17, cipher.length - 16, cipher.length - 1]);
      while (positions.size < 32) positions.add(Math.floor(random() * cipher.length));
      const variants = [...positions].map(position => {
        const bytes = Buffer.from(cipher); bytes[position] ^= 1 << (position % 8);
        return { ...f.envelope, ciphertext: bytes.toString('base64') };
      });
      for (let position = 0; position < 12; position++) {
        const iv = Buffer.from(f.envelope.iv, 'base64'); iv[position] ^= 1;
        variants.push({ ...f.envelope, iv: iv.toString('base64') });
      }
      for (const removed of [1, 2, 15, 16, 17, Math.floor(cipher.length / 2)]) {
        variants.push({ ...f.envelope, ciphertext: cipher.subarray(0, cipher.length - removed).toString('base64') });
      }
      variants.push({ ...f.envelope, ciphertext: Buffer.concat([cipher, Buffer.from([0])]).toString('base64') });
      for (const envelope of variants) {
        await noOutput(() => decryptJson(keys.encKey, productionParseEnvelope(envelope)));
        await noOutput(() => recoverText(JSON.stringify(envelope), f.words)); authenticatedMutations++;
      }
    } finally { keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0); }
  });

  await check('each generated archive rejects a different valid public phrase without returning data', async () => {
    for (const f of fixtures) {
      const wrong = fixtures[(f.index + 1) % fixtures.length].words, keys = deriveKeysFromMnemonic(wrong);
      try {
        await assert.rejects(() => openEnvelope(keys, f.envelope), /Vault-Id mismatch/);
        await assert.rejects(() => recoverText(JSON.stringify(f.kit), wrong), (error: unknown) =>
          error instanceof Error && error.message === 'vault_id_mismatch');
      } finally { keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0); }
    }
  });

  await check('kit and optional receipt mutations are rejected by both readers with exact original bytes retained', async () => {
    const f = fixtures[1], receipt = { schema: 'sejire/direct-arweave-receipt/v1', protocol: 'sejire/v0.3',
      encryption: 'sejire/envelope/v1', network: 'arweave.N.1', transactionId: 'T'.repeat(43), vaultId: f.envelope.vault_id,
      parentTxId: 'P'.repeat(43), archiveDigest: f.kit.archiveDigest, archiveBytes: f.kit.archiveBytes,
      ownerAddress: 'O'.repeat(43), rewardWinston: '123', createdAt: '2026-01-02T00:00:00.000Z' };
    const valid = { ...f.kit, receipt };
    assert.equal((await parseIndependentBackup(JSON.stringify(valid))).kind, 'vault');
    assert.deepEqual((await parseArchiveText(JSON.stringify(valid))).receipt, receipt);
    const bad: unknown[] = [];
    for (const field of Object.keys(f.kit)) {
      const missing = { ...f.kit } as Record<string, unknown>; delete missing[field]; bad.push(missing);
    }
    for (const patch of [{ archiveBytes: -1 }, { archiveBytes: 0 }, { archiveBytes: 0.5 }, { archiveBytes: '1' },
      { archiveBytes: Number.MAX_SAFE_INTEGER + 1 }, { archiveDigest: f.kit.archiveDigest.toUpperCase() },
      { archiveDigest: '0'.repeat(64) }, { archiveText: JSON.stringify(f.envelope) }, { archiveText: f.archiveText + ' ' },
      { format: 'sejire/envelope/v2' }, { receipt: [] }, { mnemonic: f.words }]) bad.push({ ...f.kit, ...patch });
    for (const field of Object.keys(receipt)) {
      const missing = { ...receipt } as Record<string, unknown>; delete missing[field]; bad.push({ ...valid, receipt: missing });
    }
    for (const patch of [{ parentTxId: [] }, { transactionId: 'T'.repeat(42) }, { ownerAddress: {} },
      { archiveBytes: f.kit.archiveBytes + 1 }, { vaultId: fixtures[0].envelope.vault_id },
      { rewardWinston: '01' }, { rewardWinston: '1e3' }, { rewardWinston: '-1' }, { protocol: null },
      { createdAt: 'not-a-date' }, { privateKey: 'PUBLIC SYNTHETIC forbidden field' }]) bad.push({ ...valid, receipt: { ...receipt, ...patch } });
    for (const value of bad) {
      const text = JSON.stringify(value);
      await noOutput(() => parseIndependentBackup(text)); await noOutput(() => parseArchiveText(text)); rejectedKits++;
    }
    assert.equal((await buildRecoveryKit(f.archiveText)).archiveText, f.archiveText);
  });

  await check('truncated envelope and kit files fail closed at JSON and nested archive boundaries', async () => {
    for (const text of [fixtures[0].archiveText, JSON.stringify(fixtures[1].kit)]) {
      for (const end of new Set([0, 1, 2, 7, 16, Math.floor(text.length / 3), Math.floor(text.length / 2), text.length - 2, text.length - 1])) {
        const fragment = text.slice(0, end);
        await noOutput(() => parseIndependentBackup(fragment)); await noOutput(() => parseArchiveText(fragment)); truncatedFiles++;
      }
    }
    for (const archiveText of ['', '{', '[]', 'null']) {
      const value = JSON.stringify({ ...fixtures[0].kit, archiveText });
      await noOutput(() => parseIndependentBackup(value)); await noOutput(() => parseArchiveText(value)); truncatedFiles++;
    }
  });

  await check('current production kits recover through a copied standalone CLI with no npm or network', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sejire-production-cli-'));
    try {
      const tool = join(directory, 'recover.mjs'), block = join(directory, 'network-forbidden.cjs');
      await copyFile(new URL('./recover.mjs', import.meta.url), tool);
      await writeFile(block, `const deny=()=>{throw Error('NETWORK_FORBIDDEN');};globalThis.fetch=deny;
for(const name of ['node:http','node:https','node:net','node:tls','node:dns']){const api=require(name);for(const key of ['request','get','connect','createConnection','lookup','resolve'])if(api[key])api[key]=deny;}`);
      for (const index of [0, 3, 10, 15]) {
        const f = fixtures[index], input = join(directory, `kit-${index}.json`), output = join(directory, `private-${index}.json`);
        const inputText = JSON.stringify(f.kit); await writeFile(input, inputText);
        const result = spawnSync(process.execPath, ['--require', block, tool, input, output], {
          cwd: directory, input: f.words, encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH ?? '' },
        });
        assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await readFile(output), Buffer.from(f.expectedPlaintext));
        assert.equal(await readFile(input, 'utf8'), inputText);
        if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
        assert(!result.stdout.includes(f.words) && !result.stderr.includes(f.words));
        assert(!result.stdout.includes('PUBLIC SYNTHETIC') && !result.stderr.includes('PUBLIC SYNTHETIC'));
      }
      const f = fixtures[0], input = join(directory, 'kit-0.json'), sentinel = join(directory, 'sentinel.json'), link = join(directory, 'symlink.json');
      await writeFile(sentinel, 'UNCHANGED'); await symlink(sentinel, link);
      for (const output of [input, link]) {
        const result = spawnSync(process.execPath, ['--require', block, tool, input, output], { input: f.words, encoding: 'utf8', timeout: 15_000 });
        assert.equal(result.status, 1); assert.match(result.stderr, /output_exists/);
      }
      assert.equal(await readFile(sentinel, 'utf8'), 'UNCHANGED');
      assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), f.kit);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  assert.equal(requests, 0);
  console.log(`deep recovery: ${groups} groups; seed=0x${PROPERTY_SEED.toString(16)}; ${fixtures.length} full-vault cases; ` +
    `${rejectedEnvelopes} malformed envelopes; ${authenticatedMutations} authenticated mutations; ${fixtures.length} wrong phrases; ` +
    `${rejectedKits} invalid kits/receipts; ${truncatedFiles} truncated/malformed files; 4 copied-CLI round trips + 2 overwrite protections; network=0`);
} finally { globalThis.fetch = originalFetch; }
