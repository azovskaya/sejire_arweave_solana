import assert from 'node:assert/strict';
import { U64_MAX } from '../../../../packages/checkout/amounts';
import { MemoryAtomicOrderStore } from './store';
import { validatePayment } from './paymentValidator';
import { decodeTransaction, COMPUTE_BUDGET } from './rpcDecoder';
import { SolanaRpcReader, DEVNET_GENESIS } from './rpcReader';
import { RpcEvidenceError } from './rpcErrors';
import { reconcilePayment } from './reconciliation';
import { parseVerificationRequest, verifyRequest } from './verifyRequest';
import { fixtureOrder, fixtureTransaction, fixtureStatus, fixtureChain, instructionData, encode58, addr, sig, type FixtureTransaction } from './rpcFixtures';
let checks = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) { await run(); checks++; console.log(`PASS RPC ${name}`); }
type Options = { tx?: unknown; genesis?: string; status?: unknown; http?: number; malformed?: boolean; mismatchId?: boolean; rpcError?: number };
function transport(options: Options = {}): typeof fetch {
  return (async (url: unknown, init: RequestInit) => {
    assert.equal(url, 'https://api.devnet.solana.com');
    const request = JSON.parse(init.body as string);
    assert.equal(request.jsonrpc, '2.0');
    if (options.http) return new Response('', { status: options.http });
    if (options.malformed) return new Response('{bad json');
    let result: unknown;
    if (request.method === 'getGenesisHash') result = options.genesis ?? DEVNET_GENESIS;
    else if (request.method === 'getSignatureStatuses') { assert.deepEqual(request.params, [[sig(5)], { searchTransactionHistory: true }]); result = options.status ?? fixtureStatus(); }
    else { assert.equal(request.method, 'getTransaction'); assert.deepEqual(request.params, [sig(5), { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }]); result = Object.hasOwn(options, 'tx') ? options.tx : fixtureTransaction(); }
    return Response.json({ jsonrpc: '2.0', id: options.mismatchId ? -1 : request.id, ...(options.rpcError ? { error: { code: options.rpcError } } : { result }) });
  }) as typeof fetch;
}
const order = fixtureOrder();
await test('finalized legacy USDC uses account owners, not token account addresses', async () => {
  const tx = await new SolanaRpcReader({ network: 'devnet' }, transport()).read(sig(5));
  assert(tx); const payment = validatePayment(order, tx, fixtureChain);
  assert.deepEqual(payment.credits.map(c => c.recipient), [addr(2), addr(3)]);
  assert.deepEqual(payment.credits.map(c => c.amount), ['3000000', '97000000']);
});
await test('legacy SOL direct transfers', () => {
  const sol = fixtureOrder({ asset: 'SOL' });
  assert.equal(validatePayment(sol, decodeTransaction(fixtureTransaction(sol), sig(5), fixtureChain), fixtureChain).credits.length, 2);
});
await test('v0 resolves writable/readonly loaded addresses in correct order', () => {
  const raw = fixtureTransaction(order, sig(5), 0), message = raw.transaction.message;
  raw.meta.loadedAddresses.readonly = message.accountKeys.splice(6);
  message.header.numReadonlyUnsignedAccounts = 2;
  message.addressTableLookups = [{ accountKey: addr(10), writableIndexes: [], readonlyIndexes: [0, 1] }];
  assert.equal(validatePayment(order, decodeTransaction(raw, sig(5), fixtureChain), fixtureChain).credits.length, 2);
});
await test('v0 supports writable token accounts loaded from lookup table', () => {
  const raw = fixtureTransaction(order, sig(5), 0), message = raw.transaction.message;
  raw.meta.loadedAddresses.writable = message.accountKeys.splice(1, 3);
  message.header.numReadonlyUnsignedAccounts = 4;
  message.addressTableLookups = [{ accountKey: addr(10), writableIndexes: [0, 1, 2], readonlyIndexes: [] }];
  message.instructions = message.instructions.map(ix => ({ ...ix, programIdIndex: 2, accounts: [5, 1, ix.accounts[2] === 2 ? 6 : 7, 0, 3] }));
  for (const balances of [raw.meta.preTokenBalances, raw.meta.postTokenBalances]) for (const b of balances) b.accountIndex += 4;
  assert.equal(validatePayment(order, decodeTransaction(raw, sig(5), fixtureChain), fixtureChain).credits.length, 2);
});
await test('optional compute unit limit/price before transfers', () => {
  const raw = fixtureTransaction();
  raw.transaction.message.instructions.unshift({ programIdIndex: 7, accounts: [], data: encode58(new Uint8Array([2, 64, 66, 15, 0])), stackHeight: 1 });
  raw.transaction.message.instructions.unshift({ programIdIndex: 7, accounts: [], data: encode58(new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0])), stackHeight: 1 });
  assert.equal(raw.transaction.message.accountKeys[7], COMPUTE_BUDGET);
  assert.equal(validatePayment(order, decodeTransaction(raw, sig(5), fixtureChain), fixtureChain).credits[0].instruction, '2');
});
await test('u64 instruction amount never passes through floating point', () => {
  const huge = fixtureOrder({ kind: 'contribution', archive: undefined, servicePayment: { amount: '0', recipient: addr(2) }, fundContribution: { amount: U64_MAX.toString(), recipient: addr(3) } });
  const payment = validatePayment(huge, decodeTransaction(fixtureTransaction(huge), sig(5), fixtureChain), fixtureChain);
  assert.equal(payment.credits[0].amount, '18446744073709551615');
});
const invalid: [string, (raw: FixtureTransaction) => void][] = [
  ['signature mismatch', raw => { raw.transaction.signatures[0] = sig(6); }],
  ['failed execution', raw => { raw.meta.err = { InstructionError: [0, 'Custom'] }; }],
  ['unsupported version', raw => { (raw as unknown as { version: number }).version = 1; }],
  ['missing meta', raw => { (raw as unknown as { meta: null }).meta = null; }],
  ['missing block time', raw => { (raw as unknown as { blockTime: null }).blockTime = null; }],
  ['counterfeit mint', raw => { raw.meta.preTokenBalances[0].mint = addr(9); }],
  ['wrong token program', raw => { raw.meta.preTokenBalances[0].programId = addr(9); }],
  ['changed token owner', raw => { raw.meta.postTokenBalances[2].owner = addr(9); }],
  ['recipient token account mistaken for owner', raw => { raw.meta.preTokenBalances[2].owner = addr(13); raw.meta.postTokenBalances[2].owner = addr(13); }],
  ['wrong recipient', raw => { raw.meta.preTokenBalances[2].owner = addr(9); raw.meta.postTokenBalances[2].owner = addr(9); }],
  ['wrong amount', raw => { raw.transaction.message.instructions[0].data = instructionData(12, '3000001', true); }],
  ['wrong reference', raw => { raw.transaction.message.accountKeys[6] = addr(9); }],
  ['wrong payer', raw => { raw.transaction.message.accountKeys[0] = addr(9); }],
  ['non-signer authority', raw => { raw.transaction.message.instructions[0].accounts[3] = 6; }],
  ['missing signer', raw => { raw.transaction.message.header.numRequiredSignatures = 0; }],
  ['readonly fee payer', raw => { raw.transaction.message.header.numReadonlySignedAccounts = 1; }],
  ['arbitrary CPI', raw => { raw.meta.innerInstructions.push({ index: 0, instructions: [{ programIdIndex: 5 }] }); }],
  ['ATA instruction', raw => { raw.transaction.message.accountKeys[7] = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'; raw.transaction.message.instructions[0].programIdIndex = 7; }],
  ['unknown program', raw => { raw.transaction.message.accountKeys[5] = addr(9); }],
  ['unchecked token transfer', raw => { raw.transaction.message.instructions[0].data = instructionData(3, '3000000', true); }],
  ['unsafe JSON fee', raw => { raw.meta.fee = Number.MAX_SAFE_INTEGER + 1; }],
  ['missing token owner', raw => { delete (raw.meta.preTokenBalances[0] as Partial<typeof raw.meta.preTokenBalances[0]>).owner; }],
  ['out-of-range account index', raw => { raw.transaction.message.instructions[0].accounts[0] = 255; }],
  ['writable reference', raw => { raw.transaction.message.header.numReadonlyUnsignedAccounts = 1; }],
  ['extra transfer', raw => { raw.transaction.message.instructions.push(raw.transaction.message.instructions[0]); }],
];
for (const [name, mutate] of invalid) await test(`reject ${name}`, async () => {
  const raw = fixtureTransaction(); mutate(raw);
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  const result = await reconcilePayment(store, new SolanaRpcReader({ network: 'devnet' }, transport({ tx: raw })), order.id, sig(5));
  assert.equal(result.status, 'requires-reconciliation'); assert.equal((await store.get(order.id))?.payment, undefined);
});
for (const [name, options, reason] of [
  ['wrong genesis', { genesis: addr(9) }, 'wrong-network'],
  ['HTTP 429', { http: 429 }, 'rpc-rate-limited'], ['HTTP 503', { http: 503 }, 'rpc-server-error'],
  ['malformed JSON', { malformed: true }, 'rpc-malformed'], ['RPC response id mismatch', { mismatchId: true }, 'rpc-malformed'],
  ['RPC unsupported version error', { rpcError: -32015 }, 'unsupported-transaction'],
  ['confirmed status', { status: { ...fixtureStatus(), value: [{ ...fixtureStatus().value[0], confirmationStatus: 'confirmed' }] } }, 'not-finalized'],
  ['processed status', { status: { ...fixtureStatus(), value: [{ ...fixtureStatus().value[0], confirmationStatus: 'processed' }] } }, 'not-finalized'],
  ['failed status', { status: { ...fixtureStatus(), value: [{ ...fixtureStatus().value[0], err: { InstructionError: [0, 'Custom'] } }] } }, 'transaction-failed'],
  ['missing status context', { status: { value: fixtureStatus().value } }, 'rpc-malformed'],
  ['status/transaction slot mismatch', { status: { context: { slot: 101 }, value: [{ ...fixtureStatus().value[0], slot: 101 }] } }, 'missing-metadata'],
  ['RPC 500', { http: 500 }, 'rpc-server-error'],
  ['null transaction', { tx: null }, 'not-found'], ['null signature status', { status: { value: [null] } }, 'not-found'],
] as [string, Options, string][]) await test(`${name} remains unresolved`, async () => {
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  const result = await reconcilePayment(store, new SolanaRpcReader({ network: 'devnet' }, transport(options)), order.id, sig(5));
  assert.equal(result.status, 'requires-reconciliation'); if (result.status === 'requires-reconciliation') assert.equal(result.reason, reason);
  assert.equal((await store.get(order.id))?.pendingSignature, sig(5));
});
await test('timeout remains unresolved', async () => {
  const stalled = ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  const result = await reconcilePayment(store, new SolanaRpcReader({ network: 'devnet', timeoutMs: 5 }, stalled), order.id, sig(5));
  assert(result.status === 'requires-reconciliation'); assert.equal(result.reason, 'rpc-timeout');
});
await test('late server response uses original inclusion time; retry credits only once', async () => {
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  await reconcilePayment(store, new SolanaRpcReader({ network: 'devnet' }, transport({ tx: null })), order.id, sig(5));
  const reader = new SolanaRpcReader({ network: 'devnet' }, transport());
  assert.equal((await reconcilePayment(store, reader, order.id, sig(5))).status, 'credited');
  assert.equal((await reconcilePayment(store, reader, order.id, sig(5))).status, 'already-credited');
  const raw = fixtureTransaction(); raw.blockTime = 1101;
  assert.throws(() => validatePayment(order, decodeTransaction(raw, sig(5), fixtureChain), fixtureChain), /outside_order/);
});
await test('client cannot provide paid/evidence/finalized/recipient/amount/RPC', async () => {
  const store = new MemoryAtomicOrderStore(); await store.create(order);
  const reader = new SolanaRpcReader({ network: 'devnet' }, transport());
  for (const key of ['paid', 'paid=true', 'TransactionEvidence', 'finalized', 'recipient', 'amount', 'rpcUrl', 'network'])
    await assert.rejects(async () => verifyRequest(store, reader, { orderId: order.id, signature: sig(5), [key]: true }), /invalid_verification_request/);
  assert.equal((await store.get(order.id))?.pendingSignature, undefined);
  assert.deepEqual(parseVerificationRequest({ orderId: order.id, signature: sig(5) }), { orderId: order.id, signature: sig(5) });
  assert.throws(() => new SolanaRpcReader({ network: 'mainnet-beta' } as never));
  assert.throws(() => new SolanaRpcReader({ network: 'devnet', rpcUrl: 'https://attacker' } as never));
});
await test('bounded RPC response and missing result reject without credit', async () => {
  const large = (async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))) as typeof fetch;
  await assert.rejects(new SolanaRpcReader({ network: 'devnet' }, large).read(sig(5)), (e: unknown) => e instanceof RpcEvidenceError && e.reason === 'rpc-response-too-large');
  const missing = (async (_u: unknown, init: RequestInit) => Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body as string).id })) as typeof fetch;
  await assert.rejects(new SolanaRpcReader({ network: 'devnet' }, missing).read(sig(5)), /rpc-malformed/);
});
console.log(`rpc.selftest: ${checks} scenarios PASS; synthetic encoding=json RPC fixtures, zero external requests/signatures/transfers`);
