import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { assertOrder, createOrder, createPaidOrder, SYSTEM_PROGRAM, type PaidOrder, type Network } from '../../../../packages/checkout/order';
import {
  SOLANA_GENESIS, SOLANA_RPCS, validatePaidPolicy, paidPolicyHash, createPaidOrderFromPolicy, validatePaidOrderPolicy,
  buildPaidPaymentMessage, createPaymentPreparation, validatePaymentPreparation, validatePaidReceipt,
  paymentMessageBytes, verifyPreparedPaymentSignature, type PaidPolicy, type DurablePaymentPreparation,
} from '../../../../packages/checkout/paid';
import { validatePayment, validatePreparedPayment } from './paymentValidator';
import { RpcPaymentPreparer } from './paymentPreparation';
import { SolanaRpcReader } from './rpcReader';
import { decodeTransaction } from './rpcDecoder';
import { MemoryAtomicOrderStore } from './store';
import { addr, sig, encode58 } from './rpcFixtures';

// Independent installed Solana SDK parses our wire template; it never connects or signs.
type SdkMessage = { header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
  accountKeys: { toBase58(): string }[]; recentBlockhash: string;
  instructions: { programIdIndex: number; accounts: number[]; data: string }[] };
const sdk = createRequire(new URL('../../../web/package.json', import.meta.url))('@solana/web3.js') as {
  Message: { from(bytes: Uint8Array): SdkMessage };
  Transaction: { populate(message: SdkMessage): { serializeMessage(): Uint8Array } };
};
let checks = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) { await run(); checks++; console.log(`PASS paid primitives: ${name}`); }
function policy(network: Network = 'mainnet-beta'): PaidPolicy {
  return validatePaidPolicy({ schema: 'sejire/checkout-policy/v1', version: 'synthetic-paid-v1', network, genesisHash: SOLANA_GENESIS[network],
    serviceLamports: '30000000', serviceRecipient: addr(2), fundRecipient: addr(3),
    storage: { kind: 'arweave-direct', network: 'arweave.N.1', treasuryAddress: 'A'.repeat(43), budgetId: 'synthetic-paid-budget', maxBytes: 10 * 1024 * 1024, maxRewardWinston: '4000000000' } });
}
async function orderFor(network: Network = 'mainnet-beta', contribution = '0', current = false): Promise<PaidOrder> {
  const time = current ? Date.now() - 1000 : 1000000;
  return createPaidOrderFromPolicy(policy(network), { id: 'a'.repeat(32), payer: addr(1), reference: addr(4), createdAt: time, expiresAt: time + 100000,
    archive: { digest: 'b'.repeat(64), bytes: 39305, vaultId: 'c'.repeat(32), parentTxId: 'P'.repeat(43) }, contribution });
}
async function preparation(order: PaidOrder): Promise<DurablePaymentPreparation> {
  return createPaymentPreparation(order, { blockhash: addr(8), lastValidBlockHeight: 1000, feeLamports: '5000', createdAt: order.createdAt + 100 });
}
function rawTransaction(prep: DurablePaymentPreparation, signature = sig(5), blockTime = 1050) {
  const message = sdk.Message.from(paymentMessageBytes(prep.messageBase64));
  const accountKeys = message.accountKeys.map(key => key.toBase58());
  return { slot: 100, blockTime, version: 'legacy',
    transaction: { signatures: [signature], message: { header: message.header, accountKeys,
      recentBlockhash: message.recentBlockhash, instructions: message.instructions } },
    meta: { err: null, fee: 5000, innerInstructions: [], preBalances: accountKeys.map(() => 100000000), postBalances: accountKeys.map(() => 100000000) } };
}
type Raw = ReturnType<typeof rawTransaction>;
type ReadOptions = { rows?: unknown; transactions?: Record<string, Raw | null>; genesis?: string; unavailable?: boolean; fee?: number | null; balance?: number };
function readerFor(order: PaidOrder, prep: DurablePaymentPreparation, options: ReadOptions = {}, calls: string[] = []): SolanaRpcReader {
  return new SolanaRpcReader({ network: order.network }, async (url, init) => {
    assert.equal(String(url), SOLANA_RPCS[order.network]); assert.equal(init?.redirect, 'manual');
    const request = JSON.parse(init!.body as string); calls.push(request.method);
    if (options.unavailable) return new Response('', { status: 503 });
    let result: unknown;
    if (request.method === 'getGenesisHash') result = options.genesis ?? SOLANA_GENESIS[order.network];
    else if (request.method === 'getSignaturesForAddress') {
      assert.deepEqual(request.params, [order.reference, { commitment: 'finalized', limit: 16 }]);
      result = options.rows ?? [{ signature: sig(5), slot: 100, err: null, blockTime: 1050, confirmationStatus: 'finalized' }];
    } else if (request.method === 'getSignatureStatuses') result = { context: { slot: 100 }, value: [{ slot: 100, confirmations: null, err: null, confirmationStatus: 'finalized' }] };
    else if (request.method === 'getTransaction') result = options.transactions ? options.transactions[request.params[0]] ?? null : rawTransaction(prep, request.params[0]);
    else if (request.method === 'getAccountInfo') result = { value: { owner: SYSTEM_PROGRAM, executable: false } };
    else if (request.method === 'getLatestBlockhash') result = { value: { blockhash: addr(8), lastValidBlockHeight: 1000 } };
    else if (request.method === 'getFeeForMessage') {
      assert.equal(request.params[0], buildPaidPaymentMessage(order, addr(8)));
      result = { value: Object.hasOwn(options, 'fee') ? options.fee : 5000 };
    } else if (request.method === 'getBalance') result = { value: options.balance ?? 1000000000 };
    else throw new Error(`unexpected RPC: ${request.method}`);
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
}
const order = await orderFor(), prep = await preparation(order), chain = { network: order.network, genesisHash: SOLANA_GENESIS[order.network] };

await test('v1 output and rollback boundary stay distinct from immutable v2', () => {
  const old = createOrder({ ...order, asset: 'SOL' });
  assert.equal(old.schema, 'sejire/order/v1'); assert.deepEqual(Object.keys(old.archive!).sort(), ['bytes', 'digest']);
  assert.notEqual(old.schema as string, order.schema); assertOrder(old); assertOrder(order);
  assert.equal(order.servicePayment.amount, '30000000'); assert.equal(order.fundContribution.amount, '0'); assert.equal(order.total, '30000000');
  assert(Object.isFrozen(order)); assert(Object.isFrozen(order.archive)); assert(Object.isFrozen(order.storage));
});
await test('policy hash is canonical; roles, genesis and limits are not caller defaults', async () => {
  const original = policy(), reordered = Object.fromEntries(Object.entries(original).reverse()) as PaidPolicy;
  assert.equal(await paidPolicyHash(original), await paidPolicyHash(reordered));
  await validatePaidOrderPolicy(order, original);
  assert.throws(() => validatePaidPolicy({ ...original, enabled: true }));
  for (const patch of [{ serviceLamports: '30000001' }, { genesisHash: SOLANA_GENESIS.devnet }, { fundRecipient: original.serviceRecipient },
    { serviceRecipient: 'ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd' }]) assert.throws(() => validatePaidPolicy({ ...original, ...patch }));
  await assert.rejects(validatePaidOrderPolicy(order, { ...original, version: 'rotated-policy' }));
  assert.throws(() => validatePaidPolicy({ ...original, storage: { ...original.storage, maxRewardWinston: '0' } }));
});
await test('v2 rejects omitted parent, invalid archive/storage, test recipients and extra order fields', () => {
  for (const patch of [{ archive: { ...order.archive, parentTxId: undefined } }, { archive: { ...order.archive, parentTxId: 'wrong' } },
    { archive: { ...order.archive, vaultId: 'wrong' } }, { archive: { ...order.archive, bytes: 0 } },
    { storage: { ...order.storage, kind: 'turbo' } }, { storage: { ...order.storage, network: 'ar-io.dev' } },
    { servicePayment: { ...order.servicePayment, recipient: 'ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd' } },
    { reference: order.payer }]) assert.throws(() => createPaidOrder({ ...order, ...patch, asset: 'SOL' } as never));
  assert.throws(() => assertOrder({ ...order, unexpected: true } as never));
  assert.equal(createPaidOrder({ ...order, asset: 'SOL', archive: { ...order.archive, parentTxId: null } }).archive.parentTxId, null);
});
await test('independent SDK roundtrip: one signer, exact transfers/reference, no extra program', async () => {
  for (const contribution of ['0', '5000000']) {
    const checked = await orderFor('mainnet-beta', contribution), prepared = await preparation(checked);
    const message = sdk.Message.from(paymentMessageBytes(prepared.messageBase64));
    assert.deepEqual(message.header, { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 });
    assert.equal(message.instructions.length, contribution === '0' ? 1 : 2);
    assert.deepEqual(Buffer.from(sdk.Transaction.populate(message).serializeMessage()), Buffer.from(paymentMessageBytes(prepared.messageBase64)));
    const evidence = decodeTransaction(rawTransaction(prepared), sig(5), { network: checked.network, genesisHash: SOLANA_GENESIS[checked.network] });
    assert.equal(evidence.messageBase64, prepared.messageBase64);
    const payment = await validatePreparedPayment(checked, evidence, { network: checked.network, genesisHash: SOLANA_GENESIS[checked.network] }, prepared);
    assert.deepEqual(payment.credits.map(credit => credit.amount), contribution === '0' ? ['30000000'] : ['30000000', '5000000']);
  }
});
await test('preparation binds policy/order/payer/reference/blockhash/bytes/id and window', async () => {
  for (const patch of [{ preparationId: 'd'.repeat(64) }, { orderId: 'd'.repeat(32) }, { policyHash: 'd'.repeat(64) }, { payer: addr(9) },
    { reference: addr(9) }, { network: 'devnet' }, { genesisHash: SOLANA_GENESIS.devnet }, { blockhash: addr(9) },
    { lastValidBlockHeight: -1 }, { messageBase64: prep.messageBase64 + '\n' }, { messageSha256: 'd'.repeat(64) },
    { feeLamports: '0' }, { createdAt: order.expiresAt }]) await assert.rejects(validatePaymentPreparation(order, { ...prep, ...patch }));
  assert(Object.isFrozen(await validatePaymentPreparation(order, prep)));
});
await test('reserve can verify the payer signature against exact saved bytes without broadcasting', async () => {
  // Ephemeral test-only software key; never funded, exported, logged or used on a network.
  const pair = generateKeyPairSync('ed25519'), publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const checked = createPaidOrder({ ...order, asset: 'SOL', payer: encode58(publicBytes) }), prepared = await preparation(checked);
  const signature = encode58(sign(null, paymentMessageBytes(prepared.messageBase64), pair.privateKey));
  await verifyPreparedPaymentSignature(checked, prepared, signature);
  await assert.rejects(verifyPreparedPaymentSignature(checked, prepared, sig(5)), /invalid_payment_signature/);
  const other = await createPaymentPreparation(checked, { blockhash: addr(9), lastValidBlockHeight: 1001, feeLamports: '5000', createdAt: checked.createdAt + 200 });
  await assert.rejects(verifyPreparedPaymentSignature(checked, other, signature), /invalid_payment_signature/);
});
await test('modern validator requires the persisted preparation and exact chain message', async () => {
  const evidence = decodeTransaction(rawTransaction(prep), sig(5), chain);
  assert.throws(() => validatePayment(order, evidence, chain), /preparation_required/);
  for (const patch of [{ recentBlockhash: addr(9) }, { messageBase64: undefined }, { messageBase64: buildPaidPaymentMessage(order, addr(9)) },
    { feeLamports: '5001' }, { commitment: 'confirmed' as const }, { blockTimeMs: order.expiresAt + 1 },
    { transfers: evidence.transfers.map(transfer => ({ ...transfer, amount: '30000001' })) },
    { transfers: evidence.transfers.map(transfer => ({ ...transfer, recipient: addr(9) })) }]) {
    await assert.rejects(validatePreparedPayment(order, { ...evidence, ...patch }, chain, prep));
  }
  await assert.rejects(validatePreparedPayment(order, evidence, { ...chain, genesisHash: SOLANA_GENESIS.devnet }, prep));
});
await test('late verification of timely inclusion credits once; current expiry cannot revoke payment', async () => {
  assert(order.expiresAt < Date.now());
  const store = new MemoryAtomicOrderStore(); await store.create(order); await store.beginReconciliation(order.id, sig(5));
  const reader = readerFor(order, prep), evidence = await reader.read(sig(5)); assert(evidence);
  const payment = await validatePreparedPayment(order, evidence, reader.chain, prep);
  assert.equal((await store.commitPayment(payment)).status, 'credited'); assert.equal((await store.commitPayment(payment)).status, 'already-credited');
  await assert.rejects(store.beginReconciliation(order.id, sig(6)), /unresolved/);
});
await test('v2 accepts creation-second inclusion at RPC precision, including reference recovery, and rejects an earlier second', async () => {
  const precise = createPaidOrder({ ...order, asset: 'SOL', createdAt: 1000500, expiresAt: 1100500 });
  const saved = await createPaymentPreparation(precise, { blockhash: addr(8), lastValidBlockHeight: 1000, feeLamports: '5000', createdAt: 1000700 });
  const raw = rawTransaction(saved, sig(5), 1000), evidence = decodeTransaction(raw, sig(5), chain);
  assert.equal((await validatePreparedPayment(precise, evidence, chain, saved)).orderId, precise.id);
  const found = await readerFor(precise, saved, {
    rows: [{ signature: sig(5), slot: 100, err: null, blockTime: 1000, confirmationStatus: 'finalized' }],
    transactions: { [sig(5)]: raw },
  }).findByReference(precise, saved);
  assert.equal(found.status, 'found');
  await assert.rejects(validatePreparedPayment(precise, { ...evidence, blockTimeMs: 999000 }, chain, saved));
  const legacy = createOrder({ ...precise, asset: 'SOL' });
  assert.throws(() => validatePayment(legacy, evidence, chain), /outside_order_window/);
});
for (const network of ['devnet', 'mainnet-beta'] as const) await test(`${network} preparePaid uses pinned genesis/RPC and fee for exact message`, async () => {
  const fresh = await orderFor(network, '0', true), dummy = await preparation(fresh), calls: string[] = [];
  const prepared = await new RpcPaymentPreparer(readerFor(fresh, dummy, {}, calls)).preparePaid(fresh);
  await validatePaymentPreparation(fresh, prepared);
  assert.equal(prepared.feeLamports, '5000'); assert.equal(prepared.genesisHash, SOLANA_GENESIS[network]);
  assert.equal(calls.filter(method => method === 'getAccountInfo').length, 1); assert(calls.includes('getFeeForMessage'));
  await assert.rejects(new RpcPaymentPreparer(readerFor(fresh, dummy)).prepare(fresh), /network_not_ready/);
});
await test('legacy mainnet preparation remains unavailable; modern bad readiness cannot reach wallet', async () => {
  const fresh = await orderFor('mainnet-beta', '0', true), dummy = await preparation(fresh);
  await assert.rejects(new RpcPaymentPreparer(readerFor(fresh, dummy)).prepare(createOrder({ ...fresh, asset: 'SOL' })), /network_not_ready/);
  for (const options of [{ genesis: SOLANA_GENESIS.devnet }, { fee: null }, { fee: 100001 }, { balance: 30004999 }, { balance: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(new RpcPaymentPreparer(readerFor(fresh, dummy, options)).preparePaid(fresh));
  }
  await assert.rejects(new RpcPaymentPreparer(readerFor(order, prep)).preparePaid(order), /expired/);
});
await test('unknown wallet outcome recovers exact old reference/preparation without sending', async () => {
  const calls: string[] = [], reader = readerFor(order, prep, {}, calls);
  const found = await reader.findByReference(order, prep);
  assert.equal(found.status, 'found'); if (found.status === 'found') {
    assert.equal(found.signature, sig(5)); assert.equal(found.payment.orderId, order.id); assert.equal(found.evidence.messageBase64, prep.messageBase64);
  }
  assert(calls.includes('getSignaturesForAddress')); assert(!calls.some(method => /send|requestAirdrop/i.test(method)));
});
await test('reference mention with different blockhash cannot substitute another preparation', async () => {
  const wrong = rawTransaction(prep); wrong.transaction.message.recentBlockhash = addr(9);
  assert.deepEqual(await readerFor(order, prep, { transactions: { [sig(5)]: wrong } }).findByReference(order, prep), { status: 'requires-reconciliation', reason: 'validation-rejected' });
});
await test('null, timeout/unavailable, wrong genesis and malformed lookup stay uncertain', async () => {
  for (const [options, reason] of [
    [{ rows: [] }, 'not-found'], [{ transactions: { [sig(5)]: null } }, 'reference-scan-incomplete'],
    [{ unavailable: true }, 'rpc-server-error'], [{ genesis: SOLANA_GENESIS.devnet }, 'wrong-network'],
    [{ rows: [{ signature: 'bad', slot: 1, err: null }] }, 'rpc-malformed'],
  ] as [ReadOptions, string][]) assert.deepEqual(await readerFor(order, prep, options).findByReference(order, prep), { status: 'requires-reconciliation', reason });
});
await test('two exact matching signatures are ambiguous; a full lookup page is not an empty proof', async () => {
  const rows = [5, 6].map(fill => ({ signature: sig(fill), slot: 100, err: null, blockTime: 1050, confirmationStatus: 'finalized' }));
  const transactions = Object.fromEntries(rows.map(row => [row.signature, rawTransaction(prep, row.signature)]));
  assert.deepEqual(await readerFor(order, prep, { rows, transactions }).findByReference(order, prep), { status: 'requires-reconciliation', reason: 'reference-ambiguous' });
  const full = Array.from({ length: 16 }, (_, index) => ({ signature: sig(index + 10), slot: 100, err: null, blockTime: 100 }));
  assert.deepEqual(await readerFor(order, prep, { rows: full }).findByReference(order, prep), { status: 'requires-reconciliation', reason: 'reference-scan-incomplete' });
});
await test('expired overall lookup budget stops before another HTTP request', async () => {
  let requests = 0;
  const reader = new SolanaRpcReader({ network: 'mainnet-beta' }, async () => { requests++; throw new Error('must not request'); });
  await assert.rejects(reader.rpc('getGenesisHash', [], Date.now() - 1), /rpc-timeout/); assert.equal(requests, 0);
});
await test('v2 receipt separates payment/storage networks and exact parent/payment evidence', () => {
  const receipt = { schema: 'sejire/preservation-receipt/v2', status: 'confirmed-and-verified', orderId: order.id, policyHash: order.policyHash,
    paymentNetwork: order.network, paymentSignature: sig(5), arweaveNetwork: 'arweave.N.1', txId: 'T'.repeat(43), archive: order.archive,
    treasuryAddress: order.storage.treasuryAddress, rewardWinston: '3408198040', verifiedAt: 2000000 };
  assert.equal(validatePaidReceipt(receipt, order).paymentSignature, sig(5));
  for (const patch of [{ paymentSignature: 'bad' }, { paymentNetwork: 'devnet' }, { arweaveNetwork: 'ar-io.dev' }, { policyHash: 'd'.repeat(64) },
    { archive: { ...order.archive, parentTxId: null } }, { archive: { ...order.archive, digest: 'd'.repeat(64) } },
    { treasuryAddress: 'Z'.repeat(43) }, { rewardWinston: '0' }, { status: 'accepted-by-turbo' }]) assert.throws(() => validatePaidReceipt({ ...receipt, ...patch }, order));
});
console.log(`paid.selftest: ${checks} synthetic scenarios PASS; ephemeral software-signature fixture only; no network, live keys, submission or activation`);
