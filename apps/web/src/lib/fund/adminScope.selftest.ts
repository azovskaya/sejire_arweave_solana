import assert from 'node:assert/strict';
import { AdminScope, adminError, parseAdminAr } from './adminScope';
import { checkedPaidOverview, checkedTopups, confirmTreasuryTopup, formatSol, prepareTreasuryTopup, readPaidOverview, solanaTransactionUrl } from './adminClient';
import { fundAdminCall } from './client';

const scope = new AdminScope();
assert.throws(() => scope.begin(), /admin_unauthorized/);
scope.replace('synthetic-admin-authority');
const old = scope.begin();
assert.equal(scope.current(old), true);
assert.throws(() => scope.begin(), /admin_request_in_progress/);
scope.clear();
assert.equal(old.signal.aborted, true);
assert.equal(scope.current(old), false);
scope.replace('synthetic-replacement-authority');
const current = scope.begin();
scope.finish(old);
assert.throws(() => scope.begin(), /admin_request_in_progress/);
assert.equal(scope.current(current), true);
scope.finish(current);
assert.equal(scope.current(current), false);
const subsequent = scope.begin();
scope.clear();
assert.equal(subsequent.signal.aborted, true);
assert.throws(() => scope.begin(), /admin_unauthorized/);

assert.equal(parseAdminAr('0.000000000001'), '1');
assert.equal(parseAdminAr('999999.123456789012'), '999999123456789012');
assert.equal(formatSol('90071992547409930000001'), '90071992547409.930000001');
for (const value of ['-1', '1e3', '1,2', ' 1', '1.0000000000001', 'Infinity', 'NaN', '1000000', '01']) assert.throws(() => parseAdminAr(value));
assert.equal(adminError(Error('private-token-must-not-be-reflected')).includes('private-token'), false);

const treasury = { address: 'A'.repeat(43), revision: 1, ceilingWinston: null, heldWinston: '0', unobservedDebitWinston: '0' };
const intent = { id: 'a'.repeat(32), address: treasury.address, amountWinston: '1', status: 'prepared', baselineHeight: 100,
  transferTag: { name: 'SEJIRE-Topup-Intent', value: 'd'.repeat(64) },
  priorCeilingWinston: '1000', preparedRevision: 1, createdAt: 1, txId: null, creditedWinston: null, creditedRevision: null, confirmedAt: null };
const topups = { schema: 'sejire/treasury-topups/v1', checkedAt: 1, minimumConfirmations: 12, treasuries: [treasury], intents: [intent], hasMore: false, cursor: null };
assert.equal(checkedTopups(topups).treasuries[0].ceilingWinston, null);
assert.throws(() => checkedTopups({ ...topups, minimumConfirmations: 0 }), /admin_response_invalid/);
assert.throws(() => checkedTopups({ ...topups, intents: [{ ...intent, status: 'credited' }] }), /admin_response_invalid/);
assert.throws(() => checkedTopups({ ...topups, intents: [{ ...intent, amountWinston: '-1' }] }), /admin_response_invalid/);
assert.throws(() => checkedTopups({ ...topups, intents: [{ ...intent, transferTag: { ...intent.transferTag, value: 'invalid' } }] }), /admin_response_invalid/);
assert.equal(checkedTopups({ ...topups, intents: [{ ...intent, transferTag: null }] }).intents[0].transferTag, null);

const row = { id: 'b'.repeat(32), kind: 'preservation', network: 'mainnet-beta', createdAt: 1, updatedAt: 1,
  paymentStatus: 'confirmed', storageStatus: 'STORED', serviceLamports: '30000000', contributionLamports: '0', signature: '2'.repeat(88), arweaveTxId: 'B'.repeat(43) };
const overview = { schema: 'sejire/admin-paid-orders/v1', checkedAt: 1, configuredNetwork: 'mainnet-beta',
  policy: { serviceLamports: '30000000', serviceRecipient: '2'.repeat(44), fundRecipient: '3'.repeat(44), paymentEnabled: true, executionEnabled: true, maxArchiveBytes: 524288 },
  totals: [{ network: 'mainnet-beta', totalOrders: 1, paymentConfirmed: 1, storageCompleted: 1, pending: 0, failed: 0, serviceLamports: '30000000', contributionLamports: '0' }],
  orders: [{ ...row, envelope: 'forbidden-envelope', capability: 'forbidden-capability' }], hasMore: false, cursor: null, credential: 'forbidden-credential' };
const projection = checkedPaidOverview(overview);
assert.equal(JSON.stringify(projection).includes('forbidden'), false);
assert.equal(solanaTransactionUrl(projection.orders[0]), `https://explorer.solana.com/tx/${row.signature}`);
assert.equal(solanaTransactionUrl({ ...projection.orders[0], network: 'devnet' }), `https://explorer.solana.com/tx/${row.signature}?cluster=devnet`);
assert.equal(solanaTransactionUrl({ ...projection.orders[0], signature: 'https://attacker.invalid' }), null);
assert.throws(() => checkedPaidOverview({ ...overview, orders: [{ ...row, arweaveTxId: 'javascript:alert(1)' }] }), /admin_response_invalid/);
assert.throws(() => checkedPaidOverview({ ...overview, policy: { ...overview.policy, serviceLamports: 30000000 } }), /admin_response_invalid/);
assert.throws(() => checkedPaidOverview({ ...overview, cursor: '2', hasMore: false }), /admin_response_invalid/);
assert.throws(() => checkedPaidOverview({ ...overview, totals: [...overview.totals, ...overview.totals] }), /admin_response_invalid/);

const originalFetch = globalThis.fetch, originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('http://127.0.0.1:5181') });
const requests: Array<{ url: string; init: RequestInit }> = [];
let response: unknown = overview;
globalThis.fetch = async (url, init = {}) => { requests.push({ url: String(url), init }); return Response.json(response); };
try {
  const credential = 'synthetic-admin-header-only';
  await readPaidOverview(credential, undefined, '19');
  const request = requests.at(-1)!;
  assert.equal(request.url, 'http://127.0.0.1:5181/api/fund/admin/paid-orders?limit=50&cursor=19');
  assert.equal(new Headers(request.init.headers).get('Authorization'), `Bearer ${credential}`);
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.referrerPolicy, 'no-referrer');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.body, undefined);
  assert.equal(request.url.includes(credential), false);
  assert.throws(() => fundAdminCall('/admin/paid-orders', credential, 'GET', undefined, undefined, { limit: 50, cursor: '1&token=secret' }), /invalid_admin_query/);
  response = { intent, treasury };
  await prepareTreasuryTopup(credential, { requestId: intent.id, address: treasury.address, amountWinston: '1', expectedRevision: 1 });
  const post = requests.at(-1)!;
  assert.equal(post.init.method, 'POST');
  assert.equal(String(post.init.body).includes(credential), false);
  assert.deepEqual(Object.keys(JSON.parse(String(post.init.body))).sort(), ['address', 'amountWinston', 'expectedRevision', 'requestId']);
  assert.equal(post.init.redirect, 'error');
  const before = requests.length;
  await assert.rejects(() => confirmTreasuryTopup(credential, intent.id, { txId: '../secret', expectedRevision: 1 }), /invalid_topup_request/);
  assert.equal(requests.length, before);
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(Error('aborted'));
    else signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  });
  const lifetime = new AbortController();
  const pending = readPaidOverview(credential, lifetime.signal);
  lifetime.abort();
  await assert.rejects(pending, /aborted/);
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('https://sejire.ar.io') });
  await assert.rejects(() => readPaidOverview(credential), /fund_api_not_configured/);
} finally {
  globalThis.fetch = originalFetch;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else Reflect.deleteProperty(globalThis, 'location');
}
console.log('PASS admin authority lifetime, exact amounts, safe projections, protected HTTP transport, abort, static-host fail-closed');
