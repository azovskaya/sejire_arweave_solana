import { test, expect } from '@playwright/test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Arweave from 'arweave';
import { recoverText } from '../../../tools/recovery/recover.mjs';

const ORIGIN = 'http://127.0.0.1:5193';
const { vectors } = JSON.parse(await readFile(new URL('../../../tools/recovery/public-vectors.json', import.meta.url), 'utf8'));
const vector = vectors[0], vault = JSON.parse(vector.expectedPlaintext);
const tree = vault.trees[vault.active_tree_id];
const kit = { schema: 'sejire/recovery-kit/v1', format: 'sejire/envelope/v1', archiveText: vector.archiveText,
  archiveDigest: vector.archiveDigest, archiveBytes: vector.archiveBytes, receipt: null };
const ar = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
let jwk, owner;
test.beforeAll(async () => {
  // An ephemeral, never-funded test key. No real wallet or network is used.
  jwk = generateKeyPairSync('rsa', { modulusLength: 4096 }).privateKey.export({ format: 'jwk' });
  owner = await ar.wallets.jwkToAddress(jwk);
});
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const text = (route, body, status = 200) => route.fulfill({ status, contentType: 'text/plain', body });

async function install(context, page, { draft = false, wallet = false, unavailable = false } = {}) {
  const state = { signs: 0, posts: [], external: [], denied: [], header: null, raw: null, bytesVisible: !unavailable, chunks: 0, reject: false };
  await context.addInitScript(({ tree, draft }) => {
    localStorage.setItem('sejire.locale', 'ru');
    if (draft) { localStorage.setItem('sejire.draft.tree.v1', JSON.stringify(tree)); sessionStorage.setItem('sejire.lastScreen', 'work'); }
  }, { tree, draft });
  if (wallet) {
    await page.exposeBinding('__syntheticDirectSignature', async (_source, raw) => {
      state.signs++;
      if (state.reject) throw Error('Synthetic wallet unavailable');
      const tx = ar.transactions.fromRaw(raw);
      await ar.transactions.sign(tx, jwk);
      const signed = tx.toJSON();
      state.raw = Buffer.from(signed.data, 'base64url').toString('utf8');
      return signed;
    });
    await context.addInitScript(({ owner, publicKey }) => {
      window.arweaveWallet = {
        connect: async () => {}, getActiveAddress: async () => owner, getActivePublicKey: async () => publicKey,
        sign: async transaction => window.__syntheticDirectSignature(transaction.toJSON()),
        dispatch: () => { throw Error('Bundled dispatch must not be used'); },
      };
    }, { owner, publicKey: jwk.n });
  }
  await context.routeWebSocket('**/*', route => {
    const url = new URL(route.url());
    if (url.host !== new URL(ORIGIN).host) state.external.push('WEBSOCKET ' + url.origin + url.pathname);
    state.denied.push('websocket'); route.close({ code: 1008, reason: 'Synthetic offline test' });
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === ORIGIN) return route.continue();
    state.external.push(req.method() + ' ' + url.origin + url.pathname);
    const allowed = ['arweave.net', 'ar-io.net', 'g8way.io', 'node.test.example'];
    if (!allowed.includes(url.hostname)) { state.denied.push(url.origin + url.pathname); return route.abort('blockedbyclient'); }
    if (url.pathname === '/info') return json(route, { network: 'arweave.N.1' });
    if (/^\/price\/\d+$/.test(url.pathname)) return text(route, '1000000');
    if (/^\/wallet\/[^/]+\/balance$/.test(url.pathname)) return text(route, '999999999999');
    if (url.pathname === '/tx_anchor') return text(route, 'a'.repeat(64));
    if (url.pathname === '/graphql') return json(route, { data: { transactions: { edges: [] } } });
    if (req.method() === 'POST') {
      state.posts.push(url.pathname);
      if (url.pathname === '/tx') {
        state.header = req.postDataJSON(); expect(state.header.data).toBe('');
        return json(route, {}, 202);
      }
      if (url.pathname === '/chunk') { state.chunks++; return json(route, {}, 200); }
      state.denied.push('unexpected write ' + url.pathname); return route.abort('blockedbyclient');
    }
    const id = state.header?.id;
    if (id && url.pathname === `/tx/${id}`) return json(route, state.header);
    if (id && url.pathname === `/tx/${id}/status`) return state.chunks
      ? json(route, { number_of_confirmations: 3, block_height: 1, block_indep_hash: 'b'.repeat(64) }) : json(route, {}, 202);
    if (id && [`/raw/${id}`, `/${id}`, `/tx/${id}/data`].includes(url.pathname)) {
      if (!state.bytesVisible) return text(route, '<html>temporarily unavailable</html>'.repeat(300), 404);
      return text(route, url.pathname.endsWith('/data') ? Buffer.from(state.raw).toString('base64url') : state.raw);
    }
    return json(route, {}, 404);
  });
  return state;
}

async function prepareNew(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Создать 12 слов SEJIRE', exact: true }).click();
  await expect(page.locator('.seed-grid li')).toHaveCount(12);
  const words = await page.locator('.seed-grid li').allTextContents();
  const phrase = words.map(value => value.replace(/^\s*\d+\.\s*/, '').trim()).join(' ');
  await page.getByRole('button', { name: 'Я записал', exact: false }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(phrase);
  await page.getByRole('dialog').getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Подготовить зашифрованную копию', exact: true }).click();
  await expect(page.getByText('Подготовлено локально', { exact: true })).toBeVisible();
  return phrase;
}
async function journal(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('sejire-direct-arweave-v1', 1);
    req.onsuccess = () => { const db = req.result, read = db.transaction('operations').objectStore('operations').getAll();
      read.onsuccess = () => { db.close(); resolve(read.result); }; read.onerror = () => { db.close(); reject(Error('journal read failed')); }; };
    req.onerror = () => reject(Error('journal open failed'));
  }));
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`independent landing and encrypted-file restoration have no external runtime calls at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    const state = await install(context, page); await page.setViewportSize(viewport);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await expect(page.locator('[data-deployment-profile="decentralized-direct-arweave"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /SOL|промокод|Помочь другим/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Открыть по 12 словам', exact: true }).click();
    await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
    await page.getByLabel('Зашифрованный архив, комплект или квитанция', { exact: true }).setInputFiles({ name: 'synthetic-kit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(kit)) });
    await page.getByRole('button', { name: 'Открыть архив', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeVisible();
    const stored = await page.evaluate(() => ({ draft: JSON.parse(localStorage.getItem('sejire.draft.tree.v1')), session: JSON.parse(sessionStorage.getItem('sejire.vaultSession.v1')) }));
    expect(stored.draft.meta.id).toBe(tree.meta.id); expect(stored.session.vaultId).toBe(vector.expectedVaultId); expect(stored.session.headTxId).toBeNull();
    expect(state.signs).toBe(0); expect(state.posts).toEqual([]); expect(state.external).toEqual([]); expect(state.denied).toEqual([]); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`independent-${viewport.width}.png`), fullPage: true });
  });
}

test('direct save resumes one signed transaction after reload and portable import, and restores by known ID', async ({ page, context, browser }) => {
  const state = await install(context, page, { draft: true, wallet: true, unavailable: true });
  const phrase = await prepareNew(page);
  await page.getByRole('button', { name: 'Подключить кошелёк и узнать цену', exact: true }).click();
  await page.getByRole('button', { name: /Подписать и отправить/ }).click();
  await expect.poll(() => state.chunks).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Продолжить ту же загрузку', exact: true })).toBeEnabled();
  const before = (await journal(page))[0];
  expect(before.state).toBe('confirming'); expect(before.lastError).toBe('archive_unavailable');
  expect(before.archiveText).not.toContain(phrase); expect(JSON.stringify(before)).not.toContain(phrase);
  expect(state.signs).toBe(1); expect(state.posts.filter(path => path === '/tx')).toHaveLength(1);
  expect(state.header.data_size).toBe(String(Buffer.byteLength(state.raw)));
  expect(createHash('sha256').update(state.raw).digest('hex')).toBe(before.archiveDigest);
  await page.reload();
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  state.bytesVisible = true;
  await page.getByRole('button', { name: 'Продолжить ту же загрузку', exact: true }).click();
  await expect(page.getByText('Подтверждено и проверено', { exact: true })).toBeVisible();
  const after = (await journal(page))[0];
  expect(after.txId).toBe(before.txId); expect(after.signedTx).toEqual(before.signedTx); expect(after.archiveText).toBe(before.archiveText);
  expect(state.signs).toBe(1); expect(state.posts.filter(path => path === '/tx')).toHaveLength(1); expect(state.denied).toEqual([]);
  const clean = await browser.newContext({ locale: 'ru-RU', serviceWorkers: 'block' });
  try {
    const nextPage = await clean.newPage(), next = await install(clean, nextPage);
    next.header = state.header; next.raw = state.raw; next.chunks = 1;
    await nextPage.goto('/#/save');
    await nextPage.getByLabel('Открыть файл продолжения загрузки', { exact: true }).setInputFiles({
      name: 'synthetic-signed-attempt.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schema: 'sejire/direct-arweave-package/v1', operation: before })),
    });
    await expect(nextPage.getByText('Транзакция подписана', { exact: true })).toBeVisible();
    expect(next.posts).toEqual([]); expect(next.external).toEqual([]); expect(next.signs).toBe(0);
    await nextPage.getByRole('button', { name: 'Продолжить ту же загрузку', exact: true }).click();
    await expect(nextPage.getByText('Подтверждено и проверено', { exact: true })).toBeVisible();
    const restoredAttempt = (await journal(nextPage))[0];
    expect(restoredAttempt.txId).toBe(before.txId); expect(restoredAttempt.signedTx).toEqual(before.signedTx); expect(next.signs).toBe(0);
    const writes = next.posts.length;
    await nextPage.goto('/#/restore');
    await nextPage.getByLabel('12 слов SEJIRE', { exact: true }).fill(phrase);
    await nextPage.getByLabel('ID транзакции Arweave (необязательно)', { exact: true }).fill(before.txId);
    await nextPage.getByRole('button', { name: 'Открыть архив', exact: true }).click();
    await expect(nextPage.getByRole('button', { name: 'Сохранить', exact: true })).toBeVisible();
    expect(next.posts).toHaveLength(writes); expect(next.signs).toBe(0); expect(next.denied).toEqual([]);
    expect(await nextPage.evaluate(() => JSON.parse(sessionStorage.getItem('sejire.vaultSession.v1')).headTxId)).toBe(before.txId);
  } finally { await clean.close(); }
});

test('offline multitreed archive stays complete when saved locally and cancellation never requires payment', async ({ page, context }) => {
  const state = await install(context, page);
  await page.goto('/#/restore');
  await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
  await page.getByLabel('Зашифрованный архив, комплект или квитанция', { exact: true }).setInputFiles({ name: 'synthetic-multitree.json', mimeType: 'application/json', buffer: Buffer.from(vector.archiveText) });
  await page.getByRole('button', { name: 'Открыть архив', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Подготовить зашифрованную копию', exact: true }).click();
  await expect(page.getByText('Подготовлено локально', { exact: true })).toBeVisible();
  const first = (await journal(page))[0];
  const opened = await recoverText(first.archiveText, vector.words);
  const entire = JSON.parse(new TextDecoder().decode(opened.plaintext));
  expect(Object.keys(entire.trees).sort()).toEqual(Object.keys(vault.trees).sort());
  for (const [id, previous] of Object.entries(vault.trees)) if (id !== vault.active_tree_id) expect(entire.trees[id]).toEqual(previous);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать комплект восстановления', exact: true }).click();
  const download = await downloadEvent, downloaded = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(downloaded.archiveText).toBe(first.archiveText); expect(JSON.stringify(downloaded)).not.toContain(vector.words);
  await page.getByRole('button', { name: 'Оставить только локальную копию', exact: true }).click();
  await expect(page.getByText('Оставлена локальная копия', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Назад', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Подготовить зашифрованную копию', exact: true }).click();
  await expect(page.getByText('Подготовлено локально', { exact: true })).toBeVisible();
  const all = await journal(page);
  expect(all).toHaveLength(2); expect(all.find(op => op.id === first.id).archiveText).toBe(first.archiveText);
  expect(all.find(op => op.id === first.id).state).toBe('cancelled'); expect(state.signs).toBe(0); expect(state.posts).toEqual([]); expect(state.external).toEqual([]); expect(state.denied).toEqual([]);
});

test('legacy order blocks a fresh AR signature and remains byte-for-byte unchanged', async ({ page, context }) => {
  const state = await install(context, page, { draft: true, wallet: true });
  await page.goto('/');
  const previous = { id: '1'.repeat(32), version: 2, intent: { kind: 'preservation' }, localCompletion: 'pending', synthetic: true };
  await page.evaluate(row => new Promise((resolve, reject) => {
    const req = indexedDB.open('sejire-checkout-journal', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('operations', { keyPath: 'id' }); req.result.createObjectStore('session', { keyPath: 'id' }); };
    req.onsuccess = () => { const db = req.result, tx = db.transaction('operations', 'readwrite'); tx.objectStore('operations').put(row);
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(Error('fixture write failed')); };
    req.onerror = () => reject(Error('fixture open failed'));
  }), previous);
  await page.reload();
  await expect(page.getByText(/В этом браузере найден прежний заказ/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Подключить кошелёк|Подписать и отправить/ })).toHaveCount(0);
  expect(state.signs).toBe(0); expect(state.posts).toEqual([]); expect(state.external).toEqual([]);
  const unchanged = await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('sejire-checkout-journal', 1);
    req.onsuccess = () => { const db = req.result, read = db.transaction('operations').objectStore('operations').getAll(); read.onsuccess = () => { db.close(); resolve(read.result[0]); }; };
  }));
  expect(unchanged).toEqual(previous);
});

test('a damaged portable kit is refused without any network request', async ({ page, context }) => {
  const state = await install(context, page);
  await page.goto('/#/restore');
  await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
  await page.getByLabel('Зашифрованный архив, комплект или квитанция', { exact: true }).setInputFiles({ name: 'synthetic-tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...kit, archiveBytes: kit.archiveBytes + 1 })) });
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('sejire.draft.tree.v1'))).toBeNull();
  expect(state.posts).toEqual([]); expect(state.external).toEqual([]); expect(state.denied).toEqual([]);
});
