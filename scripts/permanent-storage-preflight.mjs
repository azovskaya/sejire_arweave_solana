/** Local preparation ONLY. No transaction signing/broadcast or upload endpoint.
 * node --experimental-loader ./scripts/offline-ts-loader.mjs scripts/permanent-storage-preflight.mjs
 * Private material stays outside the checkout; stdout contains public evidence only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { createMnemonic } from '../apps/web/src/lib/crypto/bip39.ts';
import { deriveKeysFromMnemonic } from '../apps/web/src/lib/crypto/keys.ts';
import { emptyVault, putTree, openEnvelope } from '../apps/web/src/lib/crypto/vault.ts';
import { encryptJson } from '../apps/web/src/lib/crypto/encrypt.ts';
import { parsePortableBackup } from '../apps/web/src/lib/crypto/backup.ts';
import { createTree, upsertPersonFields, commitDraft } from '../apps/web/src/lib/treeEngine.ts';
globalThis.crypto = webcrypto;
vm.runInThisContext(fs.readFileSync(new URL('../apps/web/node_modules/@solana/web3.js/lib/index.iife.js', import.meta.url), 'utf8'));
const w = globalThis.solanaWeb3;
const dir = path.join(os.homedir(), '.sejire-mainnet-preflight');
fs.mkdirSync(dir, { mode: 0o700 });
assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
assert(!fs.realpathSync(dir).startsWith(fs.realpathSync('.') + path.sep));
const save = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600, flag: 'wx' });
const read = name => { const f = path.join(dir, name); assert.equal(fs.lstatSync(f).isSymbolicLink(), false); assert.equal(fs.statSync(f).mode & 0o777, 0o600); return JSON.parse(fs.readFileSync(f, 'utf8')); };
if (!fs.existsSync(path.join(dir, 'test-treasury.json'))) save('test-treasury.json', Array.from(w.Keypair.generate().secretKey));
const treasury = w.Keypair.fromSecretKey(Uint8Array.from(read('test-treasury.json')));
if (!fs.existsSync(path.join(dir, 'archive-operation.json'))) {
 const words = createMnemonic(), keys = deriveKeysFromMnemonic(words);
 let vault = emptyVault(keys.vaultId);
 // Two synthetic trees, twelve persons each, thirty meaningful correction snapshots.
 for (let t = 0; t < 2; t++) {
  let tree = createTree(`Synthetic permanence family ${t + 1}`);
  for (let p = 0; p < 12; p++) tree = upsertPersonFields(tree, { id: `p${p}`, name: `Synthetic person ${t}-${p}`, parents: p > 1 ? [`p${Math.floor((p-2)/2)}`] : [], born: `${1900+p*5}-01-01`, notes: 'Entirely invented record for encrypted permanence testing.' });
  for (let r = 0; r < 30; r++) { tree = upsertPersonFields(tree, { id: `p${r%12}`, name: `Synthetic person ${t}-${r%12}`, notes: `Synthetic correction ${r+1}: invented family history, no real personal data.` }); tree = commitDraft(tree, `Synthetic revision ${r+1}`); }
  vault = putTree(vault, tree);
 }
 const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
 save('archive-operation.json', { words, envelope, vault });
 save('encrypted-backup.json', JSON.stringify(envelope));
}
const op = read('archive-operation.json'), keys = deriveKeysFromMnemonic(op.words);
const serialized = fs.readFileSync(path.join(dir, 'encrypted-backup.json'));
const parsed = parsePortableBackup(serialized.toString()); assert.equal(parsed.kind, 'vault');
const restored = await openEnvelope(keys, parsed.envelope); assert.deepEqual(restored, op.vault);
const tags = [{ name: 'Content-Type', value: 'application/json' }, { name: 'App-Name', value: 'SEJIRE' }, { name: 'Protocol', value: 'sejire/v0.3' }, { name: 'Type', value: 'vault-envelope' }];
const { createData, HexSolanaSigner } = await import('../apps/sponsor/node_modules/@dha-team/arbundles/build/web/esm/webIndex.js');
const bs58 = (await import('../apps/sponsor/node_modules/bs58/index.js')).default;
// Construct unsigned ANS-104 item solely to measure exact encoded size. Do not sign or upload.
const item = createData(serialized, new HexSolanaSigner(bs58.encode(treasury.secretKey)), { tags });
const itemBytes = item.getRaw().length; assert(itemBytes > 105 * 1024, 'Paid fixture must exceed free tier');
async function json(url) { const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' }); assert(response.ok, `Read-only quote HTTP ${response.status}`); return response.json(); }
const base = 'https://payment.ardrive.io/v1';
const info = await json(base + '/info');
const price = await json(base + '/price/bytes/' + itemBytes);
const sample = await json(base + '/price/solana/1000000');
const target = (BigInt(price.winc) * 110n + 99n) / 100n;
let lamports = (target * 1000000n + BigInt(sample.winc)-1n) / BigInt(sample.winc);
let funding;
for (let i=0;i<5;i++) { funding = await json(base + '/price/solana/' + lamports); if (BigInt(funding.winc)>=target) break; lamports = (lamports*target+BigInt(funding.winc)-1n)/BigInt(funding.winc); }
assert(BigInt(funding.winc)>=target);
const c = new w.Connection('https://api.mainnet-beta.solana.com', 'finalized');
assert.equal(await c.getGenesisHash(), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
const address = treasury.publicKey.toBase58(), balance = await c.getBalance(treasury.publicKey, 'finalized');
const { blockhash } = await c.getLatestBlockhash('finalized');
const tx = new w.Transaction({ feePayer: treasury.publicKey, recentBlockhash: blockhash }).add(w.SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: new w.PublicKey(info.addresses.solana), lamports }));
const fee = (await c.getFeeForMessage(tx.compileMessage(), 'finalized')).value; assert(Number.isSafeInteger(fee));
const rentReserve = await c.getMinimumBalanceForRentExemption(0);
const feeBuffer = BigInt(fee); // one extra fee reserve; not permission for another transaction
const required = lamports + BigInt(fee) + feeBuffer + BigInt(rentReserve);
const output = { checkedAt: new Date().toISOString(), preparationOnly: true, treasuryAddress: address, balanceLamports: String(balance), network: 'solana-mainnet-beta', archiveBytes: serialized.length, archiveSha256: createHash('sha256').update(serialized).digest('hex'), dataItemBytes: itemBytes, synthetic: { trees:2, personsPerTree:12, revisionsPerTree:30 }, localRestore:'PASS', tags, signerType:'ANS-104 type 4 Solana Ed25519 (unsigned item prepared)', expectedIdType:'base64url SHA-256 of data-item signature; ID not assigned before signing', uploadCost:price, sampleSolQuote:sample, bufferedCreditTargetWinc:target.toString(), fundingQuote:funding, paymentLamports:lamports.toString(), estimatedNetworkFeeLamports:String(fee), feeBufferLamports:feeBuffer.toString(), refundableUnspentRentReserveLamports:String(rentReserve), requiredFundingLamports:required.toString(), turboPaymentRecipient:info.addresses.solana, paymentEndpoint:base, archiveFormat:'sejire/envelope/v1 AES-GCM-256; encrypted sejire/vault/v1', settlement:'NOT RUN', mainnetUpload:'NOT RUN', ao:'BLOCKED independently; not required for archive preparation' };
fs.writeFileSync(path.join(dir, 'public-preflight.json'), JSON.stringify(output,null,2), { mode:0o600 });
console.log(JSON.stringify(output,null,2));
