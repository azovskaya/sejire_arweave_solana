import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { dashboard, paidOverview, topupsView, serviceRecipient, fundRecipient } from './server-admin.fixture.mjs';
const origin = 'http://127.0.0.1:5191', api = process.env.SEJIRE_TEST_API_ORIGIN;
const credential = 'Synthetic-portable-admin-credential!';
const canonical = value => JSON.stringify(value === null || typeof value !== 'object' ? value : Array.isArray(value)
  ? value.map(x => JSON.parse(canonical(x))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])));
test.beforeEach(async ({ context }) => { await context.addInitScript(() => localStorage.setItem('sejire.locale', 'ru')); });
test('published profile and recovery decoder exist; admin uses server authentication and forgets it on reload', async ({ page, context, request }) => {
  const profile = await request.get('/release-profile.json');
  expect(profile.ok()).toBeTruthy(); const value = await profile.json();
  expect(value).toMatchObject({ profile: 'portable-funded-mainnet', apiOrigin: api, paymentNetwork: 'mainnet-beta', mandatoryCloudflare: false, adminAuthorization: 'server' });
  const recovery = await request.get('/recovery/README.md'); expect(recovery.ok()).toBeTruthy(); expect(await recovery.text()).toContain('SEJIRE');
  const blocked = [], calls = [];
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== api) { blocked.push(url.href); return route.abort('blockedbyclient'); }
    calls.push({ path: url.pathname, method: req.method(), auth: req.headers().authorization });
    expect(req.method()).toBe('GET'); expect(req.url()).not.toContain(credential); expect(req.postData()).toBeNull();
    if (req.headers().authorization !== `Bearer ${credential}`) return route.fulfill({ status: 401, json: { error: 'admin_unauthorized' } });
    const reply = data => route.fulfill({ json: data });
    if (url.pathname === '/api/fund/admin/dashboard') return reply(dashboard());
    if (url.pathname === '/api/fund/admin/paid-orders') return reply(paidOverview());
    if (url.pathname === '/api/fund/admin/treasury-topups') return reply(topupsView());
    if (url.pathname === '/api/fund/admin/solana-recipients') return reply({ schema: 'sejire/sol-recipients-admin/v1', serviceRecipient, fundRecipient,
      revision: 1, updatedAt: Date.now(), source: 'admin', network: 'mainnet-beta', paymentEnabled: true, executionEnabled: true, contributionEnabled: true });
    return route.fulfill({ status: 404, json: { error: 'unexpected_route' } });
  });
  await page.goto('/#/admin'); await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.getByLabel('Пароль', { exact: true }).fill(credential); await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
  expect(calls.some(x => x.path === '/api/fund/admin/dashboard')).toBeTruthy();
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(credential);
  await page.reload(); await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible(); expect(blocked).toEqual([]);
});
test('valid Devnet offer is rejected by the Mainnet static build before any wallet or order request', async ({ page, context }) => {
  const p = { schema: 'sejire/checkout-policy/v1', version: 'synthetic-devnet', network: 'devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    serviceLamports: '30000000', serviceRecipient, fundRecipient, storage: { kind: 'arweave-direct', network: 'arweave.N.1', treasuryAddress: 'A'.repeat(43), budgetId: 'synthetic', maxBytes: 524288, maxRewardWinston: '1000' } };
  const policyHash = createHash('sha256').update(canonical(p)).digest('hex'), calls = [], blocked = [];
  await context.addInitScript(() => { window.portableWalletCalls = 0; window.phantom = { solana: { isPhantom: true, connect() { window.portableWalletCalls++; throw Error('Unexpected wallet'); } } }; });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); if (url.origin === origin) return route.continue();
    calls.push({ path: url.pathname, method: route.request().method() });
    if (url.origin === api && url.pathname === '/api/checkout/policy') return route.fulfill({ json: { ready: true, policy: p, policyHash, contributionReady: false } });
    blocked.push(url.href); return route.abort('blockedbyclient');
  });
  const archive = JSON.stringify({ schema: 'sejire/envelope/v1', vault_id: 'a'.repeat(32), cipher: 'aes-gcm-256', kdf: 'hkdf-sha256', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'A'.repeat(32), protocol: 'sejire/v0.3' });
  await page.goto('/#/save'); await page.getByLabel('Зашифрованный архив', { exact: true }).setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(archive) });
  await page.getByRole('button', { name: 'Через Solana', exact: true }).click();
  await expect(page.getByText('Оплата через Solana пока недоступна. Вы можете сохранить дерево по промокоду.', { exact: true })).toBeVisible();
  expect(calls.length).toBeGreaterThan(0); expect(calls.every(x => x.method === 'GET' && x.path === '/api/checkout/policy')).toBeTruthy();
  expect(await page.evaluate(() => window.portableWalletCalls)).toBe(0); expect(blocked).toEqual([]);
});
