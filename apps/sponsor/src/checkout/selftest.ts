import assert from 'node:assert/strict';
import { parseAmount, formatAmount, totalUnits, U64_MAX, requiresLargeAmountConfirmation } from '../../../../packages/checkout/amounts';
import { createOrder, assetFor, assertBase58, type OrderInput, type Order } from '../../../../packages/checkout/order';
import { validatePayment, type TransactionEvidence, type ChainPolicy } from './paymentValidator';
import { MemoryAtomicOrderStore, type AtomicOrderStore } from './store';
import { reconcilePayment, type TrustedTransactionReader } from './reconciliation';
let passed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  await fn(); passed++; console.log(`PASS ${name}`);
}
// Base58 encodings of synthetic bytes only; no private keys, signatures or wallets generated.
function base58(size: number, fill: number): string {
  const bytes = new Uint8Array(size).fill(fill);
  let n = 0n; for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = ''; const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  for (; n > 0n; n /= 58n) out = alphabet[Number(n % 58n)] + out;
  return out;
}
const payer = base58(32, 1), service = base58(32, 2), treasury = base58(32, 3), reference = base58(32, 4);
const signature = base58(64, 5), otherSignature = base58(64, 6);
const chain: ChainPolicy = { network: 'devnet', genesisHash: 'synthetic-devnet-genesis' };
function input(patch: Partial<OrderInput> = {}): OrderInput {
  return { id: 'a'.repeat(32), kind: 'preservation', network: 'devnet', asset: 'USDC', payer, reference,
    createdAt: 1000, expiresAt: 121000, policyVersion: 'test-service-v1',
    servicePayment: { amount: '3000000', recipient: service }, fundContribution: { amount: '97000000', recipient: treasury },
    archive: { digest: 'b'.repeat(64), bytes: 800000 }, ...patch };
}
function evidence(order: Order, patch: Partial<TransactionEvidence> = {}): TransactionEvidence {
  return { signature, network: order.network, genesisHash: chain.genesisHash, commitment: 'finalized', error: null,
    slot: 10, blockTimeMs: 2000, feeLamports: '5000', feePayer: payer, signers: [payer],
    transfers: (['servicePayment', 'fundContribution'] as const).filter(p => order[p].amount !== '0').map((p, index) => ({
      instruction: String(index), sender: payer, recipient: order[p].recipient, amount: order[p].amount, asset: order.asset, references: [order.reference],
    })), ...patch };
}
const order = createOrder(input());
const reader = (tx: TransactionEvidence | null): TrustedTransactionReader => ({ chain, read: async () => tx });
await test('arbitrary contributions include one million and above; no commercial cap', () => {
  for (const value of ['10', '100', '1000', '100000', '1000000', '1000000000']) {
    const amount = parseAmount(value, 6);
    const donation = createOrder(input({ kind: 'contribution', archive: undefined, servicePayment: { amount: '0', recipient: service }, fundContribution: { amount, recipient: treasury } }));
    assert.equal(donation.total, amount); assert.equal(donation.archive, undefined);
  }
});
await test('zero contribution does not request a fund transfer', () => {
  const plain = createOrder(input({ fundContribution: { amount: '0', recipient: treasury } }));
  const payment = validatePayment(plain, evidence(plain), chain);
  assert.equal(payment.credits.length, 1); assert.equal(payment.credits[0].purpose, 'servicePayment');
});
await test('service and contribution have exact distinct instruction allocations', () => {
  const payment = validatePayment(order, evidence(order), chain);
  assert.deepEqual(payment.credits.map(c => c.amount), ['3000000', '97000000']);
  assert.equal(payment.feeLamports, '5000'); assert.equal(order.total, '100000000');
});
await test('SOL represented in lamports with its own program, not USDC units', () => {
  const sol = createOrder(input({ asset: 'SOL', servicePayment: { amount: '100000', recipient: service }, fundContribution: { amount: '200000', recipient: treasury } }));
  assert.equal(validatePayment(sol, evidence(sol), chain).credits.length, 2);
  assert.equal(parseAmount('0.01', 9), '10000000');
});
await test('decimal arithmetic and format roundtrip for 1000 varied amounts', () => {
  for (let i = 0n; i < 1000n; i++) {
    const units = (i * 987654321n).toString(); assert.equal(parseAmount(formatAmount(units, 6), 6), units);
  }
  assert.equal(parseAmount('0.000001', 6), '1'); assert.equal(parseAmount('0', 0), '0');
});
await test('technical u64 boundary, total overflow and precision fail closed', () => {
  assert.equal(parseAmount(formatAmount(U64_MAX.toString(), 6), 6), U64_MAX.toString());
  assert.throws(() => totalUnits(U64_MAX.toString(), '1'), /overflow/);
  assert.throws(() => parseAmount('0.0000001', 6), /precision/);
  for (const value of ['-1', '+1', '1e6', '1,000', ' 1', '1.', '.1', '01', 'NaN', '9'.repeat(1000)]) assert.throws(() => parseAmount(value, 6));
});
await test('large contribution requests confirmation without rejecting it', () => {
  assert(requiresLargeAmountConfirmation(parseAmount('1000000', 6), parseAmount('10000', 6)));
  assert(!requiresLargeAmountConfirmation(parseAmount('100', 6), parseAmount('10000', 6)));
});
await test('preservation requires digest/size/service; no fixed 512 KiB policy', () => {
  assert.equal(order.archive?.bytes, 800000);
  for (const archive of [undefined, { digest: 'bad', bytes: 1 }, { digest: 'a'.repeat(64), bytes: 0 }, { digest: 'a'.repeat(64), bytes: 1.5 }]) assert.throws(() => createOrder(input({ archive })));
  assert.throws(() => createOrder(input({ servicePayment: { amount: '0', recipient: service } })));
});
await test('donation-only cannot charge service or require an archive; must be positive', () => {
  assert.throws(() => createOrder(input({ kind: 'contribution' })));
  assert.throws(() => createOrder(input({ kind: 'contribution', archive: undefined, servicePayment: { amount: '0', recipient: service }, fundContribution: { amount: '0', recipient: treasury } })));
});
await test('quote/order immutability and distinct recipient roles', () => {
  const raw = input(); const result = createOrder(raw);
  (raw.archive as { bytes: number }).bytes = 42; // caller mutation cannot alter order
  assert.equal(result.archive?.bytes, 800000);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.fundContribution));
  assert.throws(() => createOrder(input({ fundContribution: { amount: '1', recipient: service } })));
  assert.throws(() => createOrder(input({ expiresAt: 1000 })));
  assert.throws(() => assertBase58('fake-address', 32));
});
const invalid: [string, (tx: TransactionEvidence) => TransactionEvidence][] = [
  ['wrong network', tx => ({ ...tx, network: 'mainnet-beta' })],
  ['wrong genesis', tx => ({ ...tx, genesisHash: 'other' })],
  ['failed transaction', tx => ({ ...tx, error: { instructionError: 0 } })],
  ['processed transaction', tx => ({ ...tx, commitment: 'processed' })],
  ['confirmed is not finalized', tx => ({ ...tx, commitment: 'confirmed' })],
  ['missing block time', tx => ({ ...tx, blockTimeMs: null })],
  ['late payment', tx => ({ ...tx, blockTimeMs: 121001 })],
  ['predates order', tx => ({ ...tx, blockTimeMs: 999 })],
  ['wrong fee payer', tx => ({ ...tx, feePayer: service })],
  ['missing payer signature', tx => ({ ...tx, signers: [] })],
  ['malformed signature', tx => ({ ...tx, signature: 'screenshot' })],
  ['wrong recipient', tx => ({ ...tx, transfers: tx.transfers.map((t, i) => i ? t : { ...t, recipient: payer }) })],
  ['wrong sender', tx => ({ ...tx, transfers: tx.transfers.map((t, i) => i ? t : { ...t, sender: service }) })],
  ['counterfeit USDC mint', tx => ({ ...tx, transfers: tx.transfers.map(t => ({ ...t, asset: { ...t.asset, mint: treasury } })) })],
  ['wrong token program', tx => ({ ...tx, transfers: tx.transfers.map(t => ({ ...t, asset: { ...t.asset, program: payer } })) })],
  ['wrong decimals', tx => ({ ...tx, transfers: tx.transfers.map(t => ({ ...t, asset: { ...t.asset, decimals: 9 } })) })],
  ['wrong amount', tx => ({ ...tx, transfers: tx.transfers.map(t => ({ ...t, amount: '100000000' })) })],
  ['wrong reference', tx => ({ ...tx, transfers: tx.transfers.map(t => ({ ...t, references: [] })) })],
  ['duplicate instruction', tx => ({ ...tx, transfers: tx.transfers.map(t => ({ ...t, instruction: '0' })) })],
  ['extra transfer', tx => ({ ...tx, transfers: [...tx.transfers, tx.transfers[0]] })],
];
for (const [name, alter] of invalid) await test(`reject ${name}`, () => assert.throws(() => validatePayment(order, alter(evidence(order)), chain)));
await test('forged order asset or total is rejected', () => {
  assert.throws(() => validatePayment({ ...order, asset: { ...order.asset, mint: treasury } }, evidence(order), chain));
  assert.throws(() => validatePayment({ ...order, total: '1' }, evidence(order), chain));
});
await test('atomic test store: 32 concurrent confirmations credit once', async () => {
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  const results = await Promise.all(Array.from({ length: 32 }, () => reconcilePayment(store, reader(evidence(order)), order.id, signature)));
  assert.equal(results.filter(r => r.status === 'credited').length, 1);
  assert.equal(results.filter(r => r.status === 'already-credited').length, 31);
  const saved = await store.get(order.id); assert.equal(saved?.states.preservation, 'ready'); assert.equal(saved?.states.contribution, 'received');
});
await test('not found and RPC loss retain pending signature; replacement blocked', async () => {
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  assert.equal((await reconcilePayment(store, reader(null), order.id, signature)).status, 'requires-reconciliation');
  const failingReader: TrustedTransactionReader = { chain, read: async () => { throw new Error('timeout'); } };
  assert.equal((await reconcilePayment(store, failingReader, order.id, signature)).status, 'requires-reconciliation');
  assert.equal((await store.get(order.id))?.pendingSignature, signature);
  await assert.rejects(reconcilePayment(store, reader(null), order.id, otherSignature), /unresolved/);
  assert.equal((await reconcilePayment(store, reader(evidence(order)), order.id, signature)).status, 'credited');
});
await test('pending finality and wrong response signature never grant fulfillment', async () => {
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  for (const tx of [evidence(order, { commitment: 'confirmed' }), evidence(order, { blockTimeMs: null }), evidence(order, { signature: otherSignature })]) {
    assert.equal((await reconcilePayment(store, reader(tx), order.id, signature)).status, 'requires-reconciliation');
  }
  assert.equal((await store.get(order.id))?.states.preservation, 'awaiting-payment');
});
await test('response lost AFTER atomic credit: retry does not credit again', async () => {
  const inner = new MemoryAtomicOrderStore(); await inner.create(order);
  const dropping: AtomicOrderStore = { create: o => inner.create(o), get: id => inner.get(id), beginReconciliation: (id,sig) => inner.beginReconciliation(id,sig),
    commitPayment: async p => { await inner.commitPayment(p); throw new Error('lost_commit_response'); } };
  await assert.rejects(reconcilePayment(dropping, reader(evidence(order)), order.id, signature), /lost_commit/);
  let calls = 0;
  const noRPC: TrustedTransactionReader = { chain, read: async () => { calls++; throw new Error('should_not_query'); } };
  assert.equal((await reconcilePayment(inner, noRPC, order.id, signature)).status, 'already-credited'); assert.equal(calls, 0);
});
await test('duplicate order/reference and cross-order instruction replay are refused', async () => {
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  await assert.rejects(store.create(order), /exists/);
  await assert.rejects(store.create(createOrder(input({ id: 'c'.repeat(32) }))), /exists/);
  await reconcilePayment(store, reader(evidence(order)), order.id, signature);
  const second = createOrder(input({ id: 'c'.repeat(32), reference: base58(32, 7) })); await store.create(second);
  const result = await reconcilePayment(store, reader(evidence(second)), second.id, signature);
  assert.equal(result.status, 'requires-reconciliation');
  assert.equal((await store.get(second.id))?.states.payment, 'requires-reconciliation');
});
await test('detached reads cannot tamper with test store state', async () => {
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  const copy = await store.get(order.id); (copy!.order.fundContribution as { amount: string }).amount = '1';
  assert.equal((await store.get(order.id))?.order.fundContribution.amount, '97000000');
});
await test('contribution-only is verified without storage fulfillment or archive', async () => {
  const donation = createOrder(input({ kind: 'contribution', archive: undefined, servicePayment: { amount: '0', recipient: service } }));
  const store = new MemoryAtomicOrderStore(); await store.create(donation);
  await reconcilePayment(store, reader(evidence(donation)), donation.id, signature);
  assert.equal((await store.get(donation.id))?.states.preservation, 'not-applicable');
});
await test('validated payment and credit allocations are frozen', () => {
  const payment = validatePayment(order, evidence(order), chain);
  assert(Object.isFrozen(payment)); assert(Object.isFrozen(payment.credits)); assert(Object.isFrozen(payment.credits[0]));
});
// Native SOL-first MVP regression matrix; old generic USDC tests remain above.
for (const [kind, serviceAmount, fundAmount] of [['preservation','30000000','0'],['preservation','30000000','5000000'],['contribution','0','5000000']] as const) {
  await test(`SOL MVP ${kind}: ${serviceAmount} service + ${fundAmount} fund`, () => {
    const sol = createOrder(input({asset:'SOL',kind,servicePayment:{amount:serviceAmount,recipient:service},fundContribution:{amount:fundAmount,recipient:treasury},...(kind==='contribution'?{archive:undefined}:{})}));
    const payment=validatePayment(sol,evidence(sol),chain);
    assert.deepEqual(payment.credits.map(c=>c.amount), [serviceAmount,fundAmount].filter(v=>v!=='0'));
    assert.equal(sol.asset.decimals,9);
  });
}
const native=createOrder(input({asset:'SOL',servicePayment:{amount:'30000000',recipient:service},fundContribution:{amount:'5000000',recipient:treasury}}));
for(const purpose of ['servicePayment','fundContribution'] as const) {
  for(const field of ['recipient','amount'] as const) await test(`SOL rejects wrong ${purpose} ${field}`,()=>{
    const base=evidence(native), i=purpose==='servicePayment'?0:1;
    const tx={...base,transfers:base.transfers.map((transfer,index)=>index===i?{...transfer,[field]:field==='recipient'?base58(32,90):'1'}:transfer)};
    assert.throws(()=>validatePayment(native,tx,chain));
  });
}
for (const [name, patch] of [
  ['wrong payer', {feePayer:base58(32,91)}], ['wrong signer', {signers:[base58(32,91)]}],
  ['wrong network', {network:'mainnet-beta' as const}], ['failed transaction', {error:{InstructionError:0}}],
  ['not finalized', {commitment:'confirmed' as const}],
  ['extra unexpected transfer', {transfers:[...evidence(native).transfers,{...evidence(native).transfers[0],instruction:'2'}]}],
] as const) await test(`SOL rejects ${name}`,()=>assert.throws(()=>validatePayment(native,evidence(native,patch),chain)));
await test('SOL large contributions remain exact without product cap',()=>{
  for(const value of ['0.001','0.005','0.01','0.1','1','10','100','1000000'])assert.equal(formatAmount(parseAmount(value,9),9),value);
  assert.equal(totalUnits('30000000',parseAmount('1000000',9)),'1000000030000000');
});
console.log(`checkout.selftest: ${passed} scenarios PASS; synthetic normalized RPC evidence, single-isolate memory store only; zero external requests/signatures/transfers`);
