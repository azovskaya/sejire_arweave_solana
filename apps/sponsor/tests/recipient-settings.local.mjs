import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipientSettings, withRecipientSettings } from '../src/checkout/recipientSettings.ts';
import { validateSolanaRecipients, recipientPolicyVersion } from '../../../packages/checkout/recipients.ts';
import { DEVNET_ONLY_RECIPIENTS } from '../../../packages/checkout/order.ts';
import { createPaidOrderFromPolicy, paidPolicyHash, SOLANA_GENESIS } from '../../../packages/checkout/paid.ts';
import { CheckoutLedger } from '../src/checkout/durableStore.ts';
import entry from '../src/configuredEntry.ts';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function address(byte) { let n = BigInt('0x' + Buffer.alloc(32, byte).toString('hex')), s = ''; for (; n; n /= 58n) s = alphabet[Number(n % 58n)] + s; return s; }
const service = address(31), fund = address(32), replacement = address(33), payer = address(34);
const temporary = await mkdtemp(join(tmpdir(), 'sejire-recipient-settings-'));
const originalFetch = globalThis.fetch; let outbound = 0, checks = 0;
globalThis.fetch = async () => { outbound++; throw Error('external_network_forbidden'); };
function open(file) {
  const db = new DatabaseSync(file); let alarm = null;
  const storage = {
    sql: { exec(sql, ...args) {
      let rows = [];
      if (!args.length && sql.includes(';')) db.exec(sql);
      else { const s = db.prepare(sql); if (s.columns().length) rows = s.all(...args).map(row => ({ ...row })); else s.run(...args); }
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    async sync() {}, async getAlarm() { return alarm; }, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; },
  };
  return { db, storage };
}
async function test(name, fn) { await fn(); checks++; console.log('PASS recipients: ' + name); }
let database;
try {
  database = open(join(temporary, 'settings.sqlite'));
  let settings = new RecipientSettings(database.storage);
  await test('empty state does not invent recipients or enable payments', async () => {
    assert.equal(settings.get(), null);
    const env = { CHECKOUT_PAID_ENABLED: 'false', CHECKOUT_PAID_EXECUTION_ENABLED: 'false' };
    assert.equal(withRecipientSettings(env, null), env);
  });
  await test('strict public address validation rejects invalid, equal, system and disposable pilot addresses', async () => {
    for (const [a, b] of [['', fund], ['twelve words are not an address', fund], [service, service], ['11111111111111111111111111111111', fund], ...DEVNET_ONLY_RECIPIENTS.map(x => [x, fund])]) {
      assert.throws(() => validateSolanaRecipients(a, b));
    }
    assert.deepEqual(validateSolanaRecipients(' ' + service + '\n', fund), { serviceRecipient: service, fundRecipient: fund });
    assert.equal(settings.get(), null);
  });
  await test('both recipients commit together, retry once, audit once', async () => {
    const input = { serviceRecipient: service, fundRecipient: fund, expectedRevision: 0 };
    const first = await settings.save(input, 1234);
    assert.equal(first.revision, 1);
    assert.deepEqual(await settings.save(input, 1250), first);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM solana_recipient_audit').get().n, 1);
    await assert.rejects(settings.save({ ...input, enabled: true }, 1260));
    assert.deepEqual(settings.get(), first);
  });
  await test('stale tab cannot overwrite the latest settings', async () => {
    await settings.save({ serviceRecipient: replacement, fundRecipient: fund, expectedRevision: 1 }, 2000);
    await assert.rejects(settings.save({ serviceRecipient: service, fundRecipient: fund, expectedRevision: 1 }, 2001), /revision_conflict/);
    assert.equal(settings.get().serviceRecipient, replacement);
  });
  await test('settings survive SQLite reopen without changing flags, network or budgets', async () => {
    database.db.close(); database = open(join(temporary, 'settings.sqlite')); settings = new RecipientSettings(database.storage);
    assert.equal(settings.get().revision, 2);
    const env = { CHECKOUT_PAID_ENABLED: 'false', CHECKOUT_PAID_EXECUTION_ENABLED: 'false', CHECKOUT_CONTRIBUTION_ENABLED: 'false', CHECKOUT_PAID_AR_BUDGET_WINSTON: '123', CHECKOUT_PAID_NETWORK: 'mainnet-beta' };
    const next = withRecipientSettings(env, settings.get());
    for (const key of Object.keys(env)) assert.equal(next[key], env[key]);
    assert.equal(next.CHECKOUT_SERVICE_RECIPIENT, replacement);
    assert.equal(next.CHECKOUT_PAID_POLICY_VERSION, recipientPolicyVersion(2));
  });
  database.db.close(); database = open(join(temporary, 'http.sqlite'));
  let ledger; const boot = [];
  const id = { equals: other => other === id };
  const ns = { idFromName: () => id, get: () => ({ fetch: (url, init) => ledger.fetch(new Request(url, init)) }) };
  const env = { CHECKOUT_LEDGER: ns, CHECKOUT_ALLOWED_ORIGINS: 'https://example.test', ADMIN_TOKEN: 'synthetic-admin-token-not-a-live-credential',
    CHECKOUT_PAID_ENABLED: 'false', CHECKOUT_PAID_EXECUTION_ENABLED: 'false', CHECKOUT_CONTRIBUTION_ENABLED: 'false',
    CHECKOUT_PAID_NETWORK: 'mainnet-beta', PAYMENT_PROVIDER: 'mock', PUBLISH_PRICE_MINOR: '1500', PUBLISH_CURRENCY: 'KZT', MAX_ENVELOPE_BYTES: '524288', APP_ORIGIN: 'https://example.test' };
  const ctx = { id, storage: database.storage, blockConcurrencyWhile: fn => { const p = Promise.resolve().then(fn); boot.push(p); return p; }, waitUntil: p => boot.push(p) };
  ledger = new CheckoutLedger(ctx, env); await Promise.all(boot);
  async function call(method = 'GET', value, options = {}) {
    const headers = { Origin: options.origin ?? 'https://example.test', ...(options.auth === false ? {} : { Authorization: 'Bearer ' + env.ADMIN_TOKEN }), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) };
    return entry.fetch(new Request('https://worker.test/api/fund/admin/solana-recipients' + (options.query ?? ''), { method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), env);
  }
  await test('actual entry authenticates reads and writes and rejects foreign origins', async () => {
    assert.equal((await call('GET', undefined, { auth: false })).status, 401);
    assert.equal((await call('POST', {}, { auth: false })).status, 401);
    assert.equal((await call('GET', undefined, { origin: 'https://attacker.test' })).status, 403);
    assert.equal((await call('GET', undefined, { query: '?token=forbidden' })).status, 400);
    assert.equal((await call('DELETE')).status, 405);
    assert.equal((await call('OPTIONS', undefined, { auth: false })).status, 204);
  });
  await test('admin form endpoint saves with all payment gates OFF and no treasury key', async () => {
    assert.equal((await call()).status, 200);
    const r = await call('POST', { serviceRecipient: service, fundRecipient: fund, expectedRevision: 0 });
    assert.equal(r.status, 200); const body = await r.json();
    assert.equal(body.source, 'admin'); assert.equal(body.paymentEnabled, false); assert.equal(body.executionEnabled, false);
    assert.equal((await (await call()).json()).serviceRecipient, service);
    assert.equal((await call('POST', { serviceRecipient: service, fundRecipient: service, expectedRevision: 1 })).status, 400);
    assert.equal((await call('POST', { serviceRecipient: service, fundRecipient: fund, expectedRevision: 1, enabled: true })).status, 400);
    assert.equal((await call('POST', { serviceRecipient: 'x'.repeat(2100) })).status, 413);
  });
  await test('new offer reads stored recipients; address save alone cannot activate it', async () => {
    const request = new Request('https://worker.test/api/checkout/policy/contribution', { headers: { Origin: 'https://example.test' } });
    const off = await (await entry.fetch(request, env)).json(); assert.equal(off.contributionReady, false);
    const on = await (await entry.fetch(request, { ...env, CHECKOUT_CONTRIBUTION_ENABLED: 'true' })).json();
    assert.equal(on.contributionReady, true); assert.equal(on.contributionPolicy.serviceRecipient, service); assert.equal(on.contributionPolicy.fundRecipient, fund);
    assert.equal(on.contributionPolicy.version, recipientPolicyVersion(1));
  });
  await test('changing recipients preserves the already admitted order; stale new admission is refused', async () => {
    const hash = 'a'.repeat(64), now = Date.now();
    async function internal(data) { const r = await ledger.fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify(data) })); return { status: r.status, body: await r.json() }; }
    await internal({ action: 'apiIssue', hash, expiresAt: now + 60000 });
    const policy = { schema: 'sejire/contribution-policy/v1', version: recipientPolicyVersion(1), network: 'mainnet-beta', genesisHash: SOLANA_GENESIS['mainnet-beta'], serviceLamports: '0', serviceRecipient: service, fundRecipient: fund };
    const order = await createPaidOrderFromPolicy(policy, { kind: 'contribution', id: 'b'.repeat(32), payer, reference: address(35), createdAt: now, expiresAt: now + 60000, contribution: '1000000' });
    assert.equal(order.policyHash, await paidPolicyHash(policy));
    const input = { hash, key: 'synthetic-order-key-0001', intent: 'synthetic-fixed-intent', order, policy };
    assert.equal((await internal({ action: 'paidCreate', input })).status, 200);
    assert.equal((await call('POST', { serviceRecipient: replacement, fundRecipient: fund, expectedRevision: 1 })).status, 200);
    const prior = await internal({ action: 'paidGet', hash, id: order.id });
    assert.deepEqual(prior.body.record.order, order);
    const retry = await internal({ action: 'paidCreate', input });
    assert.equal(retry.status, 200); assert.equal(retry.body.reused, true);
    const rejected = await internal({ action: 'paidCreate', input: { ...input, key: 'synthetic-order-key-0002' } });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.error, 'payment_settings_changed');
    assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  });
  assert.equal(outbound, 0);
  console.log(`recipient-settings: ${checks} scenarios PASS; actual SQLite and Worker handlers; zero external requests, payments, signing or archive publication.`);
} finally { globalThis.fetch = originalFetch; database?.db.close(); await rm(temporary, { recursive: true, force: true }); }
