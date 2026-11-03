import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

/**
 * Acceptance of the *built* ArNS pack: static dist + baked Fund Worker URL.
 * Fund HTTP is mocked (no live order / no AR spend). Production Worker origin
 * is asserted on every Fund call so a wrong bake cannot silently pass.
 */
const FUND = 'https://sejire-sponsor.azovskaya-alissa.workers.dev';
const ORIGIN = 'http://127.0.0.1:5191';
const archive = JSON.stringify({
  schema: 'sejire/envelope/v1',
  vault_id: 'a'.repeat(32),
  cipher: 'aes-gcm-256',
  kdf: 'hkdf-sha256',
  iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'A'.repeat(32),
  protocol: 'sejire/v0.3',
});
const digest = createHash('sha256').update(archive).digest('hex');
const tx = 'B'.repeat(43);
const json = (route, value, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

function fundOrder(orderId, status = 'COMPLETED') {
  return {
    order: {
      preservationId: orderId,
      orderId,
      promoRevision: 1,
      archiveSizeBytes: Buffer.byteLength(archive),
      archiveDigest: digest,
      vaultId: 'a'.repeat(32),
      parentTxId: null,
      estimatedRewardWinston: '1000',
      reservedRewardWinston: '1000',
      actualRewardWinston: status === 'COMPLETED' ? '1000' : null,
      arweaveTxId: status === 'COMPLETED' ? tx : null,
      status,
      createdAt: Date.now(),
      uploadedAt: status === 'COMPLETED' ? Date.now() : null,
      verifiedAt: status === 'COMPLETED' ? Date.now() : null,
    },
    verification: status === 'COMPLETED'
      ? { stage: 'verified', transactionConfirmed: true, confirmations: 3, reason: null, checkedAt: Date.now() }
      : { stage: 'awaiting_confirmation', transactionConfirmed: false, confirmations: null, reason: 'network_pending', checkedAt: Date.now() },
  };
}

test('static ArNS pack loads and completes mocked promo save against baked Worker origin', async ({ page, context }, testInfo) => {
  const fundCalls = [];
  const blocked = { http: 0, websocket: 0 };

  await context.routeWebSocket('**/*', (ws) => {
    blocked.websocket += 1;
    ws.close({ code: 1008, reason: 'ws blocked in arns hosted test' });
  });

  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (url.origin === FUND) {
      fundCalls.push({ method: req.method(), path: url.pathname });
      if (url.pathname === '/api/fund/validate' && req.method() === 'POST') {
        return json(route, { accepted: true });
      }
      if (url.pathname === '/api/fund/orders' && req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        expect(body.archive).toBe(archive);
        expect(body.orderId).toMatch(/^[0-9a-f]{32}$/i);
        return json(route, fundOrder(body.orderId, 'COMPLETED'));
      }
      if (url.pathname.startsWith('/api/fund/orders/') && req.method() === 'GET') {
        const id = url.pathname.split('/').pop();
        return json(route, fundOrder(id, 'COMPLETED'));
      }
      if (url.pathname === '/api/checkout/policy' && req.method() === 'GET') {
        return json(route, { ready: false, reason: 'paid_unavailable' });
      }
      return json(route, { error: 'unmocked_fund_path' }, 404);
    }

    if (url.origin === ORIGIN) return route.continue();

    blocked.http += 1;
    return route.abort('blockedbyclient');
  });

  await page.goto('/#/save');
  await expect(page.getByLabel('Зашифрованный архив для промокода')).toBeVisible();
  await page.getByLabel('Зашифрованный архив для промокода').setInputFiles({
    name: 'synthetic.json',
    mimeType: 'application/json',
    buffer: Buffer.from(archive),
  });
  // After a valid envelope import the UI offers the two save methods.
  await page.getByRole('button', { name: 'По промокоду', exact: true }).click();
  const region = page.getByRole('region', { name: 'Сохранение по промокоду', exact: true });
  await expect(region).toBeVisible();
  await region.getByLabel('Промокод', { exact: true }).fill('TEST-ARNS');
  await region.getByRole('button', { name: 'Сохранить бесплатно', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Семейная история сохранена', exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByText('Данные сохранения', { exact: true }).click();
  await expect(page.locator('code', { hasText: tx })).toBeVisible();

  expect(fundCalls.some((c) => c.method === 'POST' && c.path === '/api/fund/validate')).toBeTruthy();
  expect(fundCalls.some((c) => c.method === 'POST' && c.path === '/api/fund/orders')).toBeTruthy();
  expect(fundCalls.every((c) => c.path.startsWith('/api/fund') || c.path.startsWith('/api/checkout'))).toBeTruthy();
  expect(blocked.http).toBe(0);
  expect(blocked.websocket).toBe(0);

  const shotDir = testInfo.outputPath('arns-hosted');
  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/promo-complete.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shotDir}/promo-complete-mobile.png`, fullPage: true });
  await writeFile(`${shotDir}/fund-calls.json`, JSON.stringify({ fundCalls, blocked }, null, 2));
});

test('static pack does not call Fund on github-style relative shell without opening promo', async ({ page, context }) => {
  const fundCalls = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === FUND) {
      fundCalls.push(url.pathname);
      return json(route, { error: 'unexpected' }, 500);
    }
    if (url.origin === ORIGIN) return route.continue();
    return route.abort('blockedbyclient');
  });
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(fundCalls).toEqual([]);
});
