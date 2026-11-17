import { test, expect } from '@playwright/test';
import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Arweave from 'arweave';
import { deriveKeysFromWords, recoverText } from '../../../tools/recovery/recover.mjs';

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
  const state = { signs: 0, posts: [], external: [], denied: [], header: null, raw: null, bytesVisible: !unavailable, chunks: 0, reject: false, versions: [], onlyNode: null };
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
    if (state.onlyNode && url.origin !== state.onlyNode) {
      state.denied.push('unexpected default gateway ' + url.origin + url.pathname);
      return route.abort('blockedbyclient');
    }
    const allowed = ['arweave.net', 'ar-io.net', 'g8way.io', 'node.test.example'];
    if (!allowed.includes(url.hostname)) { state.denied.push(url.origin + url.pathname); return route.abort('blockedbyclient'); }
    if (url.pathname === '/info') return json(route, { network: 'arweave.N.1' });
    if (/^\/price\/\d+$/.test(url.pathname)) return text(route, '1000000');
    if (/^\/wallet\/[^/]+\/balance$/.test(url.pathname)) return text(route, '999999999999');
    if (url.pathname === '/tx_anchor') return text(route, 'a'.repeat(64));
    if (url.pathname === '/graphql') return json(route, { data: { transactions: { edges: state.versions.map(node => ({ node })) } } });
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

async function prepareNew(page, { prepared = true } = {}) {
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
  if (prepared) await expect(page.getByText('Подготовлено локально', { exact: true })).toBeVisible();
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

async function restoreFile(page, archiveText = vector.archiveText) {
  await page.goto('/#/restore');
  await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
  await page.getByLabel('Зашифрованный архив, комплект или квитанция', { exact: true }).setInputFiles({
    name: 'synthetic-vault.json', mimeType: 'application/json', buffer: Buffer.from(archiveText),
  });
  await page.getByRole('button', { name: 'Открыть архив', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeVisible();
}

async function syntheticNativeVersion(contents) {
  const keys = await deriveKeysFromWords(vector.words), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.encKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(contents)), cipher.final(), cipher.getAuthTag()]);
  keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0);
  const envelope = { ...JSON.parse(vector.archiveText), iv: iv.toString('base64'), ciphertext: encrypted.toString('base64') };
  const raw = JSON.stringify(envelope), data = Buffer.from(raw);
  const tx = await ar.createTransaction({ data, owner: jwk.n, reward: '1000', last_tx: 'A'.repeat(64) });
  const tags = [
    { name: 'App-Name', value: 'SEJIRE' }, { name: 'Type', value: 'vault-envelope' },
    { name: 'Schema', value: 'sejire/envelope/v1' }, { name: 'Protocol-Version', value: 'sejire/v0.3' },
    { name: 'Vault-Id', value: vector.expectedVaultId }, { name: 'Archive-Bytes', value: String(data.length) },
    { name: 'Archive-SHA256', value: createHash('sha256').update(data).digest('hex') },
  ];
  for (const tag of tags) tx.addTag(tag.name, tag.value);
  await ar.transactions.sign(tx, jwk);
  return { raw, envelope, header: { ...tx.toJSON(), data: '' },
    listed: { id: tx.id, block: { timestamp: 1, height: 1 }, tags } };
}

async function selectionState(page) {
  return page.evaluate(vaultId => ({
    cache: localStorage.getItem('sejire.envelope.' + vaultId),
    draft: localStorage.getItem('sejire.draft.tree.v1'),
    session: sessionStorage.getItem('sejire.vaultSession.v1'),
  }), vector.expectedVaultId);
}

async function openVersions(page) {
  await page.locator('summary[aria-label="Ещё"]').click();
  await page.getByRole('button', { name: 'Версии сейфа', exact: true }).click();
  await expect(page.locator('.vault-version-item').first()).toBeVisible();
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

test('declining an older network version preserves the selected full vault and the next local export', async ({ page, context }) => {
  const state = await install(context, page);
  const earlier = await syntheticNativeVersion({ ...vault, trees: { [vault.active_tree_id]: tree } });
  state.header = earlier.header; state.raw = earlier.raw; state.versions = [earlier.listed];
  await restoreFile(page);
  const before = await selectionState(page);
  await openVersions(page);
  const confirmation = page.waitForEvent('dialog');
  const opening = page.locator('.vault-version-item').first().click();
  await (await confirmation).dismiss();
  await opening;
  await expect(page.locator('.vault-version-item').first()).toBeEnabled();
  expect(await selectionState(page)).toEqual(before);
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Подготовить зашифрованную копию', exact: true }).click();
  await expect(page.getByText('Подготовлено локально', { exact: true })).toBeVisible();
  const operation = (await journal(page))[0];
  const next = JSON.parse(new TextDecoder().decode((await recoverText(operation.archiveText, vector.words)).plaintext));
  expect(Object.keys(next.trees).sort()).toEqual(Object.keys(vault.trees).sort());
  for (const [id, original] of Object.entries(vault.trees)) if (id !== vault.active_tree_id) expect(next.trees[id]).toEqual(original);
  expect(operation.parentTxId).toBeNull(); expect(state.signs).toBe(0); expect(state.posts).toEqual([]); expect(state.denied).toEqual([]);
});

test('opening a local_ version adopts its complete vault without inventing a network parent', async ({ page, context }) => {
  const state = await install(context, page);
  const earlier = await syntheticNativeVersion({ ...vault, trees: { [vault.active_tree_id]: tree } });
  await restoreFile(page, earlier.raw);
  await page.evaluate(({ vaultId, envelope }) => {
    localStorage.setItem('sejire.vaultArchive.v1.' + vaultId, JSON.stringify([{
      id: 'local_synthetic_full_vault', vaultId, savedAt: new Date(0).toISOString(), parentId: null, source: 'export', envelope,
    }]));
  }, { vaultId: vector.expectedVaultId, envelope: JSON.parse(vector.archiveText) });
  await openVersions(page);
  const confirmation = page.waitForEvent('dialog');
  const opening = page.locator('.vault-version-item').first().click();
  await (await confirmation).accept();
  await opening;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const selected = await selectionState(page);
  expect(JSON.parse(selected.session)).toEqual({ vaultId: vector.expectedVaultId, headTxId: null, source: 'local' });
  expect(JSON.parse(selected.cache)).toEqual(JSON.parse(vector.archiveText));
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Подготовить зашифрованную копию', exact: true }).click();
  await expect(page.getByText('Подготовлено локально', { exact: true })).toBeVisible();
  const operation = (await journal(page))[0];
  const next = JSON.parse(new TextDecoder().decode((await recoverText(operation.archiveText, vector.words)).plaintext));
  expect(Object.keys(next.trees).sort()).toEqual(Object.keys(vault.trees).sort());
  for (const [id, original] of Object.entries(vault.trees)) if (id !== vault.active_tree_id) expect(next.trees[id]).toEqual(original);
  expect(operation.parentTxId).toBeNull(); expect(state.signs).toBe(0); expect(state.posts).toEqual([]); expect(state.denied).toEqual([]);
});

test('a gateway cannot bind an old valid ciphertext to an unsigned network version', async ({ page, context }) => {
  const state = await install(context, page);
  const earlier = await syntheticNativeVersion({ ...vault, trees: { [vault.active_tree_id]: tree } });
  state.header = { ...earlier.header, signature: '' }; state.raw = earlier.raw; state.versions = [earlier.listed];
  let confirmations = 0;
  page.on('dialog', async dialog => { confirmations++; await dialog.dismiss(); });
  await restoreFile(page);
  const before = await selectionState(page);
  await openVersions(page);
  await page.locator('.vault-version-item').first().click();
  await expect(page.getByRole('dialog').locator('.form-error')).toBeVisible();
  await expect(page.locator('.vault-version-item').first()).toBeEnabled();
  expect(await selectionState(page)).toEqual(before); expect(confirmations).toBe(0);
  expect(state.signs).toBe(0); expect(state.posts).toEqual([]); expect(state.denied).toEqual([]);
});

async function denyVaultSessionWrites(context) {
  await context.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && key === 'sejire.vaultSession.v1') {
        throw new DOMException('Synthetic session storage failure', 'QuotaExceededError');
      }
      return write.call(this, key, value);
    };
  });
}

test('restoration does not claim success when the selected vault session cannot be persisted', async ({ page, context }) => {
  const state = await install(context, page); await denyVaultSessionWrites(context);
  await page.goto('/#/restore');
  const before = await selectionState(page);
  await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
  await page.getByLabel('Зашифрованный архив, комплект или квитанция', { exact: true }).setInputFiles({
    name: 'synthetic-vault.json', mimeType: 'application/json', buffer: Buffer.from(vector.archiveText),
  });
  await page.getByRole('button', { name: 'Открыть архив', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Браузер не смог сохранить');
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toHaveCount(0);
  expect(await selectionState(page)).toEqual(before);
  expect(state.signs).toBe(0); expect(state.posts).toEqual([]); expect(state.external).toEqual([]);
});

test('a failed preparation session write retains the encrypted attempt and never offers a payment as successful preparation', async ({ page, context }) => {
  const state = await install(context, page, { draft: true, wallet: true }); await denyVaultSessionWrites(context);
  const phrase = await prepareNew(page, { prepared: false });
  await expect(page.getByRole('alert')).toContainText('Браузер не смог сохранить');
  await expect(page.getByText('Подготовлено локально', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Подключить кошелёк|Подписать и отправить/ })).toHaveCount(0);
  const operations = await journal(page); expect(operations).toHaveLength(1);
  expect(operations[0].state).toBe('prepared'); expect(operations[0].signedTx).toBeNull();
  expect(JSON.stringify(operations)).not.toContain(phrase);
  const recovered = JSON.parse(new TextDecoder().decode((await recoverText(operations[0].archiveText, phrase)).plaintext));
  expect(recovered.trees[tree.meta.id].commits).toEqual(tree.commits);
  expect(await page.evaluate(() => sessionStorage.getItem('sejire.vaultSession.v1'))).toBeNull();
  expect(state.signs).toBe(0); expect(state.posts).toEqual([]); expect(state.external).toEqual([]);
});

test('both PDF downloads work with every external service blocked', async ({ page, context }) => {
  const state = await install(context, page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await restoreFile(page);
  for (const type of ['classic', 'shezhire']) {
    await page.locator('summary[aria-label="Ещё"]').click();
    const event = page.waitForEvent('download');
    if (type === 'classic') await page.getByRole('button', { name: 'Древо в PDF', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Шежіре PDF', exact: true }).click();
      await page.locator('.shezhire-template-option').first().click();
    }
    const download = await event, bytes = await readFile(await download.path());
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.subarray(-32).toString()).toContain('%%EOF');
  }
  expect(state.external).toEqual([]); expect(state.denied).toEqual([]); expect(state.signs).toBe(0); expect(state.posts).toEqual([]); expect(errors).toEqual([]);
});

test('the offline decoder link downloads the exact standalone HTML from the real static server', async ({ page, context }) => {
  const state = await install(context, page);
  await page.goto('/#/restore');
  const recovery = page.getByRole('link', { name: 'Скачать автономный расшифровщик', exact: true });
  expect(await recovery.evaluate(link => link.href)).toBe(ORIGIN + '/recovery/recovery.html');
  const event = page.waitForEvent('download');
  await recovery.click();
  const download = await event;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe('sejire-recovery.html');
  const downloaded = await readFile(await download.path());
  expect(downloaded.equals(await readFile(new URL('../../../tools/recovery/recovery.html', import.meta.url)))).toBe(true);
  expect(state.external).toEqual([]); expect(state.denied).toEqual([]); expect(state.signs).toBe(0); expect(state.posts).toEqual([]);
});

test('a sandboxed manifest fallback loads independent assets and the exact offline decoder under its manifest path', async ({ page, context }) => {
  const host = `https://${'a'.repeat(52)}.arweave.net`, prefix = '/' + 'M'.repeat(43);
  const requested = [], denied = [], errors = [];
  await context.addInitScript(() => localStorage.setItem('sejire.locale', 'ru'));
  page.on('pageerror', error => errors.push(error.message));
  await context.routeWebSocket('**/*', route => { denied.push(route.url()); route.close({ code: 1008, reason: 'Synthetic offline test' }); });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== host || !url.pathname.startsWith(prefix + '/')) { denied.push(url.origin + url.pathname); return route.abort('blockedbyclient'); }
    requested.push(url.pathname);
    const path = url.pathname === prefix + '/unknown/deep/route' ? '/' : url.pathname.slice(prefix.length);
    const response = await route.fetch({ url: ORIGIN + path + url.search });
    return route.fulfill({ response });
  });
  try {
    await page.goto(host + prefix + '/unknown/deep/route#/restore');
    await expect(page.locator('base')).toHaveAttribute('href', prefix + '/');
    const recovery = page.getByRole('link', { name: 'Скачать автономный расшифровщик', exact: true });
    expect(await recovery.evaluate(link => link.href)).toBe(host + prefix + '/recovery/recovery.html');
    // Chromium cancels downloads answered by route.fulfill (Playwright #28253).
    // Check this virtual gateway's actual resolved response bytes here, and
    // keep the native browser download assertion in the real-server test above.
    const decoder = await recovery.evaluate(async link => {
      const response = await fetch(link.href, { credentials: 'omit' });
      return { status: response.status, url: response.url, text: await response.text() };
    });
    expect(decoder.status).toBe(200);
    expect(decoder.url).toBe(host + prefix + '/recovery/recovery.html');
    expect(Buffer.from(decoder.text).equals(await readFile(new URL('../../../tools/recovery/recovery.html', import.meta.url)))).toBe(true);
    await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
    await page.getByLabel('Зашифрованный архив, комплект или квитанция', { exact: true }).setInputFiles({
      name: 'synthetic-vault.json', mimeType: 'application/json', buffer: Buffer.from(vector.archiveText),
    });
    await page.getByRole('button', { name: 'Открыть архив', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeVisible();
    expect(requested.some(path => path.startsWith(prefix + '/assets/') && path.endsWith('.js'))).toBe(true);
    expect(denied).toEqual([]); expect(errors).toEqual([]);
  } finally {
    // Stop new favicon/assets before waiting for local proxy handlers to drain.
    await page.route('**/*', route => route.abort('blockedbyclient'));
    await context.unrouteAll({ behavior: 'wait' });
  }
});

test('a chosen custom node remains usable through restore, versions, preparation and reload with default gateways blocked', async ({ page, context }) => {
  const state = await install(context, page, { wallet: true });
  const custom = 'https://node.test.example', remote = await syntheticNativeVersion(vault);
  state.onlyNode = custom; state.header = remote.header; state.raw = remote.raw; state.versions = [remote.listed];
  await page.goto('/#/restore');
  await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
  await page.getByLabel('ID транзакции Arweave (необязательно)', { exact: true }).fill(remote.header.id);
  await page.locator('.independent-restore details > summary').click();
  await page.locator('.independent-restore input[type="url"]').fill(custom);
  await page.getByRole('button', { name: 'Открыть архив', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeVisible();
  await openVersions(page);
  const confirmation = page.waitForEvent('dialog');
  const opening = page.locator('.vault-version-item').first().click();
  await (await confirmation).accept(); await opening;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Подготовить зашифрованную копию', exact: true }).click();
  await expect(page.getByText('Подготовлено локально', { exact: true })).toBeVisible();
  await expect(page.locator('.direct-node input[type="url"]')).toHaveValue(custom);
  await page.getByRole('button', { name: 'Подключить кошелёк и узнать цену', exact: true }).click();
  await expect(page.getByRole('button', { name: /Подписать и отправить/ })).toBeVisible();
  const before = (await journal(page))[0];
  expect(before.parentTxId).toBe(remote.header.id); expect(before.quote.node).toBe(custom);
  const next = JSON.parse(new TextDecoder().decode((await recoverText(before.archiveText, vector.words)).plaintext));
  expect(Object.keys(next.trees).sort()).toEqual(Object.keys(vault.trees).sort());
  for (const [id, original] of Object.entries(vault.trees)) if (id !== vault.active_tree_id) expect(next.trees[id]).toEqual(original);
  await page.reload();
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  await expect(page.locator('.direct-node input[type="url"]')).toHaveValue(custom);
  await page.getByRole('button', { name: 'Обновить цену', exact: true }).click();
  await expect.poll(async () => (await journal(page))[0].revision).toBeGreaterThan(before.revision);
  await expect(page.getByRole('button', { name: 'Обновить цену', exact: true })).toBeEnabled();
  const after = (await journal(page))[0];
  expect(after.id).toBe(before.id); expect(after.archiveText).toBe(before.archiveText); expect(after.quote.node).toBe(custom);
  expect(state.external.length).toBeGreaterThan(0);
  expect(state.external.every(request => request.split(' ')[1].startsWith(custom + '/'))).toBe(true);
  expect(state.denied).toEqual([]); expect(state.signs).toBe(0); expect(state.posts).toEqual([]);
});
