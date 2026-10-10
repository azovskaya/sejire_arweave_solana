import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import bs58 from 'bs58';
const base = 'http://127.0.0.1:5173';
const b58 = fill => bs58.encode(new Uint8Array(32).fill(fill));
let runtime, temp, protocol;
const protocolMode=process.env.SEJIRE_PROTOCOL_TEST==='1';
test.beforeEach(async ({page}) => {
  page.on('pageerror', error => console.error('checkout pageerror:', error.message));
  page.on('requestfailed', request => console.error('checkout requestfailed:', request.url(), request.failure()?.errorText));
});
test.beforeAll(async () => {
  temp = await mkdtemp(resolve(tmpdir(), 'sejire-browser-'));
  if(protocolMode){
    const {bundle}=await import('../../../scripts/build-protocol-bundle.mjs');
    const script=resolve(temp,'protocol.mjs');
    await bundle(resolve('../sponsor/tests/protocol-browser-entry.ts'),script);
    protocol=await import('file://'+script);
    return;
  }
  const {Miniflare}=await import('../../sponsor/node_modules/miniflare/dist/src/index.js');
  const {buildWorker}=await import('../../sponsor/tests/build-worker.mjs');
  const scriptPath = resolve(temp, 'worker.mjs');
  await buildWorker(resolve('../sponsor/tests/api-worker.ts'), scriptPath);
  runtime = new Miniflare({ modules: true, scriptPath, modulesRoot: temp, compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { CHECKOUT_LEDGER: { className: 'CheckoutLedger', useSQLite: true } }, durableObjectsPersist: resolve(temp, 'db'),
    bindings: { CHECKOUT_API_ENABLED: 'true', CHECKOUT_ALLOWED_ORIGINS: base, CHECKOUT_SERVICE_RECIPIENT: b58(2), CHECKOUT_FUND_RECIPIENT: b58(3), CHECKOUT_POLICY_VERSION: 'browser-synthetic-v1', MAX_ENVELOPE_BYTES: '524288' } });
});
test.afterAll(async () => { await runtime?.dispose(); if (temp) await rm(temp, { recursive: true, force: true }); });
async function externalFixtures(page, options = {}) {
  let broadcast = false, lost = false; const archives = new Map(), counts = { send: 0, upload: 0 };
  const pilot=protocolMode?await protocol.pilot():null;
  if(pilot)pilot.control.missing=true;
  const handler=pilot?protocol.protocolHttp(pilot.engine,base,true):null;
  await page.addInitScript(() => localStorage.setItem('sejire.locale', 'ru'));
  // Publishing a recovered local vault checks Arweave version history before
  // opening checkout. Keep browser tests hermetic instead of waiting on a live gateway.
  await page.route(/https:\/\/(?:arweave\.net|arweave-search\.goldsky\.com|ar-io\.dev)\/graphql/, route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { transactions: { edges: [] } } }) }));
  await page.route('**/api/checkout/**', async route => {
    const request = route.request(), headers = { ...request.headers(), 'CF-Connecting-IP': '192.0.2.10', 'X-Test-Rpc': broadcast ? 'success' : 'null' };
    const optionsHTTP={ method: request.method(), headers, ...(request.postData() ? { body: request.postData() } : {}) };
    const response=handler?await handler(new Request(request.url(),optionsHTTP)):await runtime.dispatchFetch(request.url(),optionsHTTP);
    const data = await response.text();
    if (request.url().endsWith('/execute')) {
      counts.upload++;
      const parsed = JSON.parse(data), payload = JSON.parse(request.postData());
      if (parsed.execution?.accepted) archives.set(parsed.execution.id, payload.serialized);
    }
    if (options.loseResponse && !lost && request.url().endsWith('/reconcile') && broadcast) { lost = true; await route.abort('failed'); return; }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: data });
  });
  await page.route('https://api.devnet.solana.com/**', async route => {
    const p = route.request().postDataJSON(); let result;
    if (p.method === 'getFeeForMessage') result = { context: { slot: 100 }, value: 5000 };
    else if (p.method === 'sendTransaction') { counts.send++; broadcast = true; if(pilot)pilot.control.missing=false; const raw = Buffer.from(p.params[0], 'base64'); result = bs58.encode(raw.subarray(1, 65)); }
    else throw new Error(`unexpected external method ${p.method}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: p.id, result }) });
  });
  await page.route('https://ar-io.dev/raw/**', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    if (!archives.has(id)) await route.fulfill({ status: 404, body: '' });
    else await route.fulfill({ contentType: 'application/json', body: archives.get(id) });
  });
  return { counts, archives };
}
async function installWallet(page) { await page.evaluate(async () => (await import('/tests/browser-fixture.ts')).installWallet()); }
async function restore(page, words, serialized, receipt = false) {
  await page.getByRole('button', { name: 'Открыть по 12 словам', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть из файла', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: receipt ? 'receipt.json' : 'archive.json', mimeType: 'application/json', buffer: Buffer.from(serialized) });
  await page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' }).fill(words);
  await page.getByRole('button', { name: 'Восстановить архив', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true }).first()).toBeVisible();
}
async function openPreservation(page) {
  await page.getByRole('button', { name: 'Сохранить', exact: true }).first().click();
  await page.getByRole('button', { name: 'Сохранить через Solana', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Сохранить мою историю' })).toBeVisible();
}
async function confirm(page, value = '0') {
  await page.locator('#checkout-contribution').fill(value);
  await page.getByRole('button', { name: 'Phantom — Проверить условия оплаты' }).click();
  await expect(page.getByRole('button', { name: /^Подтвердить .*SOL/ })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Я проверил точную сумму, сеть и получателей.' }).check();
  await page.getByRole('button', { name: /^Подтвердить .*SOL/ }).click();
}
for (const amount of ['0', '0.005']) test(`existing editor → SOL ${amount} contribution → actual HTTP/store → download → clean/offline recovery (synthetic externals)`, async ({ page, browser }) => {
  const external = await externalFixtures(page); await page.goto('/');
  const fixture = await page.evaluate(async () => (await import('/tests/browser-fixture.ts')).fixture());
  await restore(page, fixture.words, fixture.serialized); await installWallet(page); await openPreservation(page);
  const backupEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать зашифрованную резервную копию' }).click();
  const backup = await backupEvent;
  await confirm(page, amount); await expect(page.getByText(/Архив получен из тестовой сети/)).toBeVisible({ timeout: 90000 });
  const receiptEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать квитанцию', exact: true }).click();
  const receipt = JSON.parse(await readFile(await (await receiptEvent).path(), 'utf8'));
  expect(receipt.network).toBe('devnet'); expect(receipt.status).toBe('accepted-by-turbo');
  expect(external.counts.send).toBe(1); expect(external.counts.upload).toBe(1);
  const clean = await browser.newContext(), cleanPage = await clean.newPage(); await externalFixtures(cleanPage);
  // Independent gateway fixture returns the exact uploaded bytes, without session or payment wallet.
  await cleanPage.unroute('https://ar-io.dev/raw/**');
  await cleanPage.route('https://ar-io.dev/raw/**', route => route.fulfill({ contentType: 'application/json', body: external.archives.get(receipt.receipt.id) }));
  await cleanPage.goto('/'); await restore(cleanPage, fixture.words, JSON.stringify(receipt), true);
  const recovered = await cleanPage.evaluate(async words => (await import('/tests/browser-fixture.ts')).recovered(words), fixture.words);
  expect(recovered.trees).toEqual(fixture.vault.trees); expect(await cleanPage.evaluate(() => Boolean(window.phantom))).toBe(false); await clean.close();
  const offline = await browser.newContext(), offlinePage = await offline.newPage(); await offlinePage.addInitScript(() => localStorage.setItem('sejire.locale', 'ru'));
  await offlinePage.goto('/');
  // Warm local module code first; then block ALL external network. Recovery uses the downloaded file.
  await offlinePage.getByRole('button', { name: 'Открыть по 12 словам', exact: true }).click();
  await offlinePage.getByRole('button', { name: 'Открыть из файла', exact: true }).click();
  await offlinePage.locator('input[type=file]').setInputFiles({ name: 'downloaded-backup.json', mimeType: 'application/json', buffer: await readFile(await backup.path()) });
  await offlinePage.evaluate(() => import('/tests/browser-fixture.ts'));
  await offlinePage.route('**/*', route => route.abort('internetdisconnected'));
  await offlinePage.getByRole('textbox', { name: '12 слов восстановления SEJIRE' }).fill(fixture.words);
  await offlinePage.getByRole('button', { name: 'Восстановить архив', exact: true }).click();
  await expect(offlinePage.getByRole('button', { name: 'Сохранить', exact: true }).first()).toBeVisible();
  expect(await offlinePage.evaluate(async words => (await import('/tests/browser-fixture.ts')).recovered(words), fixture.words)).toMatchObject({ trees: fixture.vault.trees });
  await offline.close();
});
test('standalone support requires neither tree nor service fee; repeated click creates one signed payment', async ({ page }) => {
  const external = await externalFixtures(page); await page.goto('/'); await installWallet(page);
  await page.getByRole('button', { name: 'Поддержать сохранение других семей' }).click();
  await confirm(page, '0.005'); await expect(page.getByText(/Спасибо, Хранитель памяти/)).toBeVisible({ timeout: 90000 });
  expect(external.counts.send).toBe(1); expect(external.counts.upload).toBe(0);
  await expect(page.locator('dd').filter({ hasText: /^0 SOL$/ })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/lib/checkout/client.ts')).operations().then(list => list.at(-1).order.servicePayment.amount))).toBe('0');
});
test('wallet rejection sends nothing and allows explicit retry', async ({ page }) => {
  const external = await externalFixtures(page); await page.goto('/'); await installWallet(page);
  await page.evaluate(() => { window.fixtureWallet.reject = true; });
  await page.getByRole('button', { name: 'Поддержать сохранение других семей' }).click(); await confirm(page, '10');
  await expect(page.getByRole('alert')).toContainText('Подпись отклонена'); expect(external.counts.send).toBe(0);
  await page.evaluate(() => { window.fixtureWallet.reject = false; });
  const nextPreparation = page.waitForResponse(response => response.url().endsWith('/prepare'));
  await page.getByRole('button', { name: 'Phantom — Проверить условия оплаты' }).click();
  await nextPreparation;
  await expect(page.getByRole('checkbox')).toBeEnabled();
  await page.getByRole('checkbox').check();
  const confirmButton = page.getByRole('button', { name: /^Подтвердить .*SOL/ });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.evaluate(button => { button.click(); button.click(); });
  await expect(page.getByText(/Спасибо, Хранитель памяти/)).toBeVisible({ timeout: 90000 }); expect(external.counts.send).toBe(1);
  expect(await page.evaluate(() => window.fixtureWallet.signCount)).toBe(2);
});
test('lost verification response and reload reconcile original payment without another wallet signature', async ({ page }) => {
  const external = await externalFixtures(page, { loseResponse: true }); await page.goto('/'); await installWallet(page);
  await page.getByRole('button', { name: 'Поддержать сохранение других семей' }).click(); await confirm(page, '50');
  await expect(page.getByRole('alert')).toBeVisible(); expect(external.counts.send).toBe(1);
  await page.reload(); await page.getByRole('button', { name: 'Поддержать сохранение других семей' }).click();
  await page.getByRole('button', { name: 'Продолжить сверку' }).click(); await expect(page.getByText(/Спасибо, Хранитель памяти/)).toBeVisible();
  expect(external.counts.send).toBe(1); expect(await page.evaluate(() => Boolean(window.phantom))).toBe(false);
});
