import assert from 'node:assert/strict';
import { DEFAULT_DIRECT_NODES, directNodes } from './network';
import { DIRECT_NODE_PREFERENCE_KEY, readDirectNodePreference, saveDirectNodePreference } from './nodePreference';
import { listIndependentVaultVersions } from '../independentDiscovery';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); }, clear: () => { values.clear(); } };
}
const session = memoryStorage();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
const custom = 'https://native-choice.example', explicit = 'https://explicit-choice.example';
session.setItem('sejire.vaultSession.v1', '{"vaultId":"synthetic-unchanged"}');
let passed = 0;
async function test(name: string, action: () => void | Promise<void>) { await action(); passed++; console.log(`PASS ${name}`); }
try {
  await test('an unset preference uses defaults; a saved origin is canonical and shared by later native calls', () => {
    assert.equal(readDirectNodePreference(), null); assert.deepEqual(directNodes(), [...DEFAULT_DIRECT_NODES]);
    assert.equal(saveDirectNodePreference('  ' + custom + '/  '), custom);
    assert.equal(session.getItem(DIRECT_NODE_PREFERENCE_KEY), custom);
    assert.equal(readDirectNodePreference(), custom); assert.deepEqual(directNodes(), [custom]);
    assert.equal(session.getItem('sejire.vaultSession.v1'), '{"vaultId":"synthetic-unchanged"}');
  });
  await test('explicit transport options take precedence without reading or falling back from a stored preference', () => {
    assert.deepEqual(directNodes({ nodes: [explicit] }), [explicit]);
    session.setItem(DIRECT_NODE_PREFERENCE_KEY, 'https://node.example/?credential=not-allowed');
    assert.throws(() => directNodes(), /invalid_node/);
    assert.deepEqual(directNodes({ nodes: [explicit] }), [explicit]);
    saveDirectNodePreference(custom);
  });
  await test('invalid entered or saved addresses never select defaults or alter an existing valid preference', () => {
    for (const value of ['http://node.example', 'https://user:password@node.example', 'https://node.example/api', 'https://node.example/?token=x', 'x'.repeat(2049)]) {
      assert.throws(() => saveDirectNodePreference(value), /invalid_node/);
      assert.equal(readDirectNodePreference(), custom);
    }
    session.setItem(DIRECT_NODE_PREFERENCE_KEY, '');
    assert.throws(() => readDirectNodePreference(), /invalid_node/);
    saveDirectNodePreference(custom);
  });
  await test('unavailable session reads stop implicit native selection; explicit options remain explicit', () => {
    const read = session.getItem;
    session.getItem = () => { throw new DOMException('Synthetic unavailable session', 'SecurityError'); };
    try {
      assert.throws(() => directNodes(), /storage_unavailable/);
      assert.throws(() => saveDirectNodePreference(explicit), /storage_unavailable/);
      assert.deepEqual(directNodes({ nodes: [explicit] }), [explicit]);
    } finally { session.getItem = read; }
    assert.equal(readDirectNodePreference(), custom);
  });
  await test('failed or silently ignored preference writes preserve the previous choice and unrelated vault metadata', () => {
    const write = session.setItem;
    for (const mode of ['throw', 'ignore']) {
      session.setItem = (key, value) => {
        if (key === DIRECT_NODE_PREFERENCE_KEY && value === explicit) {
          if (mode === 'throw') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
          return;
        }
        write(key, value);
      };
      try { assert.throws(() => saveDirectNodePreference(explicit), /storage_unavailable/); }
      finally { session.setItem = write; }
      assert.deepEqual(directNodes(), [custom]);
      assert.equal(session.getItem('sejire.vaultSession.v1'), '{"vaultId":"synthetic-unchanged"}');
    }
  });
  await test('an uncertain failed clear cannot silently select defaults until an explicit successful setting repairs it', () => {
    const read = session.getItem, write = session.setItem; let reads = 0;
    session.getItem = key => {
      if (key === DIRECT_NODE_PREFERENCE_KEY && ++reads > 1) throw Error('Synthetic unavailable verification');
      return read(key);
    };
    session.setItem = () => { throw Error('Synthetic unavailable rollback'); };
    try { assert.throws(() => saveDirectNodePreference(''), /storage_unavailable/); }
    finally { session.getItem = read; session.setItem = write; }
    assert.throws(() => directNodes(), /storage_unavailable/);
    assert.equal(saveDirectNodePreference(custom), custom); assert.deepEqual(directNodes(), [custom]);
  });
  await test('custom discovery sends one bounded read-only GraphQL query only to the selected origin', async () => {
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); calls++;
      assert.equal(url.origin, custom); assert.equal(url.pathname, '/graphql');
      assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert(init?.signal);
      const query = JSON.parse(String(init?.body)); assert.equal(query.variables.vaultId, 'f'.repeat(32)); assert(!query.query.includes('mutation'));
      return new Response(JSON.stringify({ data: { transactions: { edges: [{ node: { id: 'A'.repeat(43), block: { timestamp: 123 }, tags: [] } }] } } }));
    };
    const found = await listIndependentVaultVersions('f'.repeat(32));
    assert.equal(found.length, 1); assert.equal(found[0].txId, 'A'.repeat(43)); assert.equal(calls, 1);
  });
  await test('an unsupported or oversized custom index fails without trying public discovery endpoints', async () => {
    for (const mode of ['missing', 'oversized']) {
      let calls = 0;
      globalThis.fetch = async input => {
        calls++; assert.equal(new URL(String(input)).origin, custom);
        return mode === 'missing' ? new Response('No search index', { status: 404 })
          : new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } });
      };
      await assert.rejects(() => listIndependentVaultVersions('f'.repeat(32)), /Arweave/);
      assert.equal(calls, 1);
    }
  });
  await test('explicit empty input clears only the preference and restores configured defaults', () => {
    assert.equal(saveDirectNodePreference('  '), null); assert.equal(session.getItem(DIRECT_NODE_PREFERENCE_KEY), null);
    assert.deepEqual(directNodes(), [...DEFAULT_DIRECT_NODES]);
    assert.equal(session.getItem('sejire.vaultSession.v1'), '{"vaultId":"synthetic-unchanged"}');
  });
  console.log(`native node preference: ${passed} local checks passed; no live network, signatures or uploads`);
} finally {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
}
