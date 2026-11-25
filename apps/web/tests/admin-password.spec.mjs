import { test, expect } from '@playwright/test';
import { adminPassword, mockServerAdmin, loginServerAdmin as login, openFundAdmin, installSyntheticWander } from './server-admin.fixture.mjs';

const diagnosticsTab = page => page.getByRole('tab', { name: 'Диагностика', exact: true });
const topup = page => page.getByRole('region', { name: 'Пополнение фонда AR', exact: true });
const topupStatus = page => topup(page).locator(':scope > [role="status"]');
const writes = fixture => fixture.requests.filter(row => row.method === 'POST');
async function open(page, options) {
  const api = await mockServerAdmin(page, options); await page.goto('/#/admin'); return api;
}
async function prepare(page, amount = '1.000000000001') {
  await topup(page).getByLabel('Сумма нового пополнения (AR)', { exact: true }).fill(amount);
  page.once('dialog', dialog => dialog.accept());
  await topup(page).getByRole('button', { name: 'Подготовить пополнение', exact: true }).click();
}
async function confirm(page) {
  await topup(page).getByLabel('Публичный ID транзакции Arweave', { exact: true }).fill('C'.repeat(43));
  page.once('dialog', dialog => dialog.accept());
  await topup(page).getByRole('button', { name: 'Проверить и учесть пополнение', exact: true }).click();
}

test('public home has no admin controls and restore stays separate', async ({ page }) => {
  await mockServerAdmin(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Открыть по 12 словам' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Админ-панель' })).toHaveCount(0);
  await page.goto('/#/restore');
  await expect(page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' })).toBeVisible();
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveCount(0);
});
test('admin login cannot create a password or accept wallet words', async ({ page }) => {
  const api = await open(page);
  await expect(page.getByRole('heading', { name: 'Админ-панель' })).toBeVisible();
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Создать пароль' })).toHaveCount(0);
  await expect(diagnosticsTab(page)).toHaveCount(0);
  await expect(page.getByLabel(/12 слов|мнемоник|seed|vault/i)).toHaveCount(0);
  expect(api.requests).toEqual([]);
});
test('server denial fails closed even when a public verifier exists', async ({ page }) => {
  const api = await open(page); await login(page, 'wrong password');
  await expect(page.getByRole('alert')).toContainText('Неверный пароль');
  await expect(diagnosticsTab(page)).toHaveCount(0);
  expect(api.requests.map(row => new URL(row.url).pathname)).toEqual(['/api/fund/admin/dashboard']);
});
test('show hide and Enter open only the server-authorized desk', async ({ page }) => {
  await open(page);
  const input = page.getByLabel('Пароль', { exact: true });
  await input.fill(adminPassword); await page.getByRole('button', { name: 'Показать пароль' }).click();
  await expect(input).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Скрыть пароль' }).click(); await expect(input).toHaveAttribute('type', 'password');
  await input.press('Enter'); await expect(diagnosticsTab(page)).toBeVisible();
  await expect(page.getByTestId('admin-paid-overview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Создать пароль' })).toHaveCount(0);
});
test('reload and logout erase in-memory authority and never activate legacy key storage', async ({ page }) => {
  await open(page); await login(page); await expect(diagnosticsTab(page)).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/lib/opsDesk/store.ts')).readSessionPassword())).toBeNull();
  await page.reload(); await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible();
  await expect(diagnosticsTab(page)).toHaveCount(0); await login(page);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('sejire.ops.session'))).toBeNull();
  expect(await page.evaluate(async () => (await import('/src/lib/opsDesk/store.ts')).getHotTreasury())).toBeNull();
});
test('the server authorizes two clean browsers without a local verifier', async ({ browser }) => {
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ locale: 'ru-RU' }), page = await context.newPage();
    await open(page); await login(page); await expect(diagnosticsTab(page)).toBeVisible();
    const disk = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(disk).not.toContain(adminPassword); await context.close();
  }
});
test('old browser hash and session cannot grant server authorization', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sejire.ops.v1', JSON.stringify({ passwordHash: 'pbkdf2$210000$fake$fake', settings: {}, movements: [] }));
    sessionStorage.setItem('sejire.ops.session', 'old-browser-password');
  });
  await open(page); await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('sejire.ops.session'))).toBeNull();
  await login(page, 'old-browser-password'); await expect(page.getByRole('alert')).toContainText('Неверный пароль');
});
test('malformed and unavailable admin responses never authorize the desk', async ({ page }) => {
  const api = await open(page, { dashboard: { promo: { enabled: true } } });
  await login(page); await expect(page.getByRole('alert')).toContainText('неполные данные');
  await expect(diagnosticsTab(page)).toHaveCount(0);
  api.state.denied = true; await login(page); await expect(page.getByRole('alert')).toContainText('Неверный пароль');
});
test('credential travels only in the intended authorization header, with no wallet calls, storage, or logs', async ({ page }) => {
  const api = await mockServerAdmin(page), consoleMessages = [];
  page.on('console', message => consoleMessages.push(message.text()));
  await page.addInitScript(() => {
    window.__adminReads = []; window.__walletCalls = 0;
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) { window.__adminReads.push(key); return original.call(this, key); };
    Object.defineProperty(window, 'phantom', { get() { window.__walletCalls++; return undefined; } });
    Object.defineProperty(window, 'arweaveWallet', { get() { window.__walletCalls++; return undefined; } });
  });
  await page.goto('/#/admin'); await login(page); await expect(diagnosticsTab(page)).toBeVisible();
  await expect(page.getByTestId('admin-paid-total-mainnet-beta')).toBeVisible();
  const disk = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(disk).not.toContain(adminPassword); expect(page.url()).not.toContain(adminPassword);
  expect(await page.evaluate(() => window.__adminReads.filter(key => /mnemonic|seed|envelope|vault/i.test(key)))).toEqual([]);
  expect(await page.evaluate(() => window.__walletCalls)).toBe(0);
  expect(api.requests.every(row => !row.url.includes(adminPassword) && !row.body?.includes(adminPassword))).toBe(true);
  expect(api.requests.every(row => row.headers.authorization === `Bearer ${adminPassword}` && new URL(row.url).pathname.startsWith('/api/fund/admin/'))).toBe(true);
  expect(writes(api)).toEqual([]); expect(api.blocked).toEqual([]); expect(consoleMessages.join('\n')).not.toContain(adminPassword);
});
test('diagnostics requires server authorization and does not open local treasury keys', async ({ page }) => {
  await mockServerAdmin(page); await page.goto('/#/admin/diagnostics');
  await expect(page.getByRole('heading', { name: 'Диагностика сохранения V2' })).toHaveCount(0);
  await login(page); await expect(page.getByRole('heading', { name: 'Диагностика сохранения V2' })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/lib/opsDesk/store.ts')).readSessionPassword())).toBeNull();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Диагностика сохранения V2' })).toHaveCount(0);
});
test('Mainnet paid ledger separates Devnet totals and uses the right transaction explorers', async ({ page }) => {
  const api = await open(page); await login(page);
  const mainnet = page.getByTestId('admin-paid-total-mainnet-beta'), devnet = page.getByTestId('admin-paid-total-devnet');
  await expect(mainnet).toContainText('0.060000000 SOL'); await expect(mainnet).toContainText('0.001000000 SOL');
  await expect(devnet).toContainText('0.030000000 SOL'); await expect(devnet).toContainText('0.009000000 SOL');
  await expect(page.getByTestId('admin-paid-overview')).toContainText('512 KiB');
  const links = page.getByRole('link', { name: 'Транзакция SOL', exact: true });
  await expect(links.nth(0)).toHaveAttribute('href', `https://explorer.solana.com/tx/${'2'.repeat(88)}`);
  await expect(links.nth(1)).toHaveAttribute('href', `https://explorer.solana.com/tx/${'3'.repeat(88)}?cluster=devnet`);
  await page.getByRole('button', { name: 'Обновить обзор Solana' }).click();
  await expect(mainnet).toBeVisible(); expect(writes(api)).toEqual([]);
  expect(api.requests.some(row => /graphql|api\.devnet|getTransaction/.test(row.url + row.body))).toBe(false);
});
test('paid overview failure clears old totals and shows unknown instead of fake zero', async ({ page }) => {
  const api = await open(page); await login(page);
  await expect(page.getByTestId('admin-paid-total-mainnet-beta')).toBeVisible();
  api.state.overviewError = true; await page.getByRole('button', { name: 'Обновить обзор Solana' }).click();
  await expect(page.getByTestId('admin-paid-overview').getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('admin-paid-total-mainnet-beta')).toHaveCount(0);
  await expect(page.getByTestId('admin-paid-overview')).toContainText('пока не подтверждены');
  expect(writes(api)).toEqual([]);
});
test('late login response cannot revive a cancelled credential', async ({ page }) => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const api = await open(page, { holdDashboard: hold }); await login(page);
  await expect.poll(() => api.requests.filter(row => row.url.endsWith('/dashboard')).length).toBe(1);
  await page.getByLabel('Пароль', { exact: true }).fill('replacement-wrong-credential');
  release(); await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('replacement-wrong-credential');
  await expect(diagnosticsTab(page)).toHaveCount(0);
  await login(page, 'replacement-wrong-credential'); await expect(page.getByRole('alert')).toContainText('Неверный пароль');
});
test('leaving admin aborts login and returning requires authorization again', async ({ page }) => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const api = await open(page, { holdDashboard: hold }); await login(page);
  await expect.poll(() => api.requests.filter(row => row.url.endsWith('/dashboard')).length).toBe(1);
  await page.evaluate(() => { location.hash = '#/'; }); release();
  await expect(page.getByRole('button', { name: 'Открыть по 12 словам' })).toBeVisible();
  await page.goto('/#/admin'); await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');
  await expect(diagnosticsTab(page)).toHaveCount(0);
});
test('promo success requires readback and a late mutation never follows logout with an authorized GET', async ({ page }) => {
  const api = await open(page, { readbackMismatch: true }); await login(page); await openFundAdmin(page);
  await page.getByRole('button', { name: 'Изменить промокод', exact: true }).click();
  await page.getByLabel('Новый промокод', { exact: true }).fill('NEW-CODE-26');
  await page.getByLabel('Повторите новый промокод', { exact: true }).fill('NEW-CODE-26');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Сохранить промокод', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('другой сессии');
  await expect(page.getByText('Новый промокод сохранён и проверен на сервере.')).toHaveCount(0);
  let release; api.state.holdPromo = new Promise(resolve => { release = resolve; }); api.state.readbackMismatch = false;
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Сохранить промокод', exact: true }).click();
  await expect.poll(() => writes(api).filter(row => row.url.endsWith('/promo')).length).toBe(2);
  const reads = api.requests.filter(row => row.url.endsWith('/dashboard')).length;
  await page.getByRole('button', { name: 'Выйти', exact: true }).click(); release();
  await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');
  await expect(page.getByText('Новый промокод сохранён и проверен на сервере.')).toHaveCount(0);
  expect(api.requests.filter(row => row.url.endsWith('/dashboard'))).toHaveLength(reads);
});
test('topup begins with a durable intent then confirms one exact transfer and readback', async ({ page }, testInfo) => {
  const api = await open(page); await login(page); await openFundAdmin(page);
  await expect(topup(page)).toContainText('Ещё не зафиксирован'); expect(writes(api)).toEqual([]);
  await prepare(page); await expect(topupStatus(page)).toContainText('Заявка сохранена и проверена');
  const request = writes(api)[0], body = JSON.parse(request.body);
  expect(body.amountWinston).toBe('1000000000001'); expect(body.expectedRevision).toBe(0);
  await expect(topup(page).getByTestId('admin-topup-selected')).toContainText('1.000000000001 AR');
  await expect(topup(page).getByLabel('Имя тега пополнения')).toHaveValue('SEJIRE-Topup-Intent');
  await expect(topup(page).getByLabel('Значение тега пополнения')).toHaveValue('d'.repeat(64));
  await expect(topup(page)).toContainText('Перевод без этого тега');
  await confirm(page); await expect(topupStatus(page)).toContainText('Пополнение подтверждено и учтено');
  expect(api.state.topups.treasuries[0].ceilingWinston).toBe('21000000000001');
  expect(writes(api)).toHaveLength(2); await expect(topup(page).getByLabel('Публичный ID транзакции Arweave')).toHaveCount(0);
  await expect(topup(page)).toContainText('Новый перевод по этой заявке не требуется');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('server-admin-fund-mobile.png'), fullPage: true });
});
test('lost prepare acknowledgment recovers the same durable intent without making another transfer', async ({ page }) => {
  const api = await open(page, { prepareLostAck: true }); await login(page); await openFundAdmin(page);
  await prepare(page); await expect(topup(page).getByRole('alert')).toBeVisible();
  const id = JSON.parse(writes(api)[0].body).requestId;
  await topup(page).getByRole('button', { name: 'Обновить пополнения', exact: true }).click();
  await expect(topup(page).getByTestId('admin-topup-selected')).toContainText(id);
  await expect(topupStatus(page)).toContainText('найдена в журнале');
  expect(api.state.topups.intents).toHaveLength(1); expect(writes(api)).toHaveLength(1);
});
test('topup revision conflict and missing confirmations cannot claim a credit', async ({ page }) => {
  const api = await open(page); await login(page); await openFundAdmin(page); await prepare(page);
  await expect(topupStatus(page)).toContainText('Заявка сохранена');
  api.state.topupError = 'treasury_revision_conflict'; await confirm(page);
  await expect(topup(page).getByRole('alert')).toContainText('Состояние фонда уже изменилось');
  expect(api.state.topups.treasuries[0].ceilingWinston).toBe('20000000000000');
  api.state.topupError = 'topup_not_confirmed'; await confirm(page);
  await expect(topup(page).getByRole('alert')).toContainText('нужное число подтверждений');
  await expect(topup(page).getByText('Пополнение подтверждено и учтено.', { exact: false })).toHaveCount(0);
});
test('HTTP success without credited readback cannot claim a successful topup', async ({ page }) => {
  const api = await open(page, { confirmReadbackMismatch: true }); await login(page); await openFundAdmin(page); await prepare(page);
  await expect(topupStatus(page)).toContainText('Заявка сохранена'); await confirm(page);
  await expect(topup(page).getByRole('alert')).toContainText('другой сессии');
  await expect(topup(page).getByText('Пополнение подтверждено и учтено.', { exact: false })).toHaveCount(0);
  expect(api.state.topups.treasuries[0].ceilingWinston).toBe('20000000000000');
});

test('owner previews exact AR amount and fee then signs and submits once through synthetic Wander', async ({ page }) => {
  const native = await installSyntheticWander(page), api = await open(page, { native });
  await login(page); await openFundAdmin(page); await prepare(page);
  await expect(topupStatus(page)).toContainText('Заявка сохранена');
  const panel = page.getByRole('region', { name: 'Перевод через Wander', exact: true });
  await panel.getByRole('button', { name: 'Подключить Wander и рассчитать комиссию', exact: true }).click();
  await expect(panel.getByTestId('topup-transfer-preview')).toContainText('1.000000001001 AR');
  expect(await page.evaluate(() => window.__wanderCalls.sign)).toBe(0); expect(native.posts).toEqual([]);
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Подписать один перевод в Wander', exact: true }).click();
  await expect(panel.getByTestId('topup-signed-transfer')).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('Подпись сохранена');
  expect(await page.evaluate(() => window.__wanderCalls.sign)).toBe(1); expect(native.posts).toEqual([]);
  const transfer = [...api.state.transfers.values()][0], id = JSON.parse(transfer.signedTx).id;
  const signed = JSON.parse(transfer.signedTx);
  expect(signed.quantity).toBe('1000000000001'); expect(signed.reward).toBe('1000');
  expect(signed.tags.some(tag => Buffer.from(tag.name, 'base64url').toString() === 'SEJIRE-Topup-Intent' && Buffer.from(tag.value, 'base64url').toString() === 'd'.repeat(64))).toBe(true);
  await panel.getByRole('button', { name: 'Отправить подписанный перевод', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Узел принял');
  expect(native.posts).toEqual([transfer.signedTx]);
  await expect(topup(page).getByLabel('Публичный ID транзакции Arweave')).toHaveValue(id);
  expect(writes(api).some(row => row.url.endsWith('/confirm'))).toBe(false);
  page.once('dialog', dialog => dialog.accept());
  await topup(page).getByRole('button', { name: 'Проверить и учесть пополнение', exact: true }).click();
  await expect(topupStatus(page)).toContainText('Пополнение подтверждено и учтено');
  expect(await page.evaluate(() => window.__wanderCalls.sign)).toBe(1); expect(api.blocked).toEqual([]);
});
test('unknown native submit response and reload preserve the exact transaction without a second Wander signature', async ({ page }) => {
  const native = await installSyntheticWander(page), api = await open(page, { native });
  await login(page); await openFundAdmin(page); await prepare(page);
  await expect(topupStatus(page)).toContainText('Заявка сохранена');
  let panel = page.getByRole('region', { name: 'Перевод через Wander', exact: true });
  await panel.getByRole('button', { name: 'Подключить Wander и рассчитать комиссию', exact: true }).click();
  await panel.getByRole('checkbox').check(); await panel.getByRole('button', { name: 'Подписать один перевод в Wander', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Подпись сохранена');
  const signed = [...api.state.transfers.values()][0].signedTx, intentId = api.state.topups.intents[0].id;
  expect(await page.evaluate(() => window.__wanderCalls.sign)).toBe(1);
  native.loseAck = true; await panel.getByRole('button', { name: 'Отправить подписанный перевод', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible(); expect(new Set(native.posts)).toEqual(new Set([signed]));
  const transferReads = () => api.requests.filter(row => row.method === 'GET' && row.url.endsWith(`/treasury-topups/${intentId}/transfer`)).length;
  const readsBeforeReload = transferReads();
  await page.reload(); await login(page); await openFundAdmin(page);
  // The wrapping label's text also includes every option; select by its accessible role/name.
  const intents = topup(page).getByRole('combobox', { name: 'Заявка для перевода или проверки', exact: true });
  await intents.selectOption(intentId);
  await expect(intents).toHaveValue(intentId);
  panel = page.getByRole('region', { name: 'Перевод через Wander', exact: true });
  await expect(panel.getByTestId('topup-signed-transfer')).toBeVisible();
  await expect(panel.getByTestId('topup-signed-transfer')).toContainText(JSON.parse(signed).id);
  await expect.poll(transferReads).toBeGreaterThan(readsBeforeReload);
  expect(api.state.transfers.get(intentId).signedTx).toBe(signed);
  expect(api.state.transfers.size).toBe(1);
  expect(await page.evaluate(() => window.__wanderCalls.sign)).toBe(0);
  native.loseAck = false;
  await panel.getByRole('button', { name: 'Повторно отправить этот же перевод', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Узел принял');
  expect(new Set(native.posts)).toEqual(new Set([signed]));
  expect(await page.evaluate(() => window.__wanderCalls.sign)).toBe(0); expect(api.blocked).toEqual([]);
});
