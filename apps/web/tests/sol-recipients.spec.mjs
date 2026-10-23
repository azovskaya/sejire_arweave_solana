import { test, expect } from '@playwright/test';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function address(byte) { let n = BigInt('0x' + Buffer.alloc(32, byte).toString('hex')), s = ''; for (; n; n /= 58n) s = alphabet[Number(n % 58n)] + s; return s; }
const service = address(31), fund = address(32), replacement = address(33);
const initial = () => ({ schema: 'sejire/sol-recipients-admin/v1', serviceRecipient: '', fundRecipient: '', revision: 0, updatedAt: null,
  source: 'not-configured', network: null, paymentEnabled: false, executionEnabled: false, contributionEnabled: false });
async function fixture(page, { denied = false, conflict = false } = {}) {
  let stored = initial(), writes = 0, external = 0;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:5199') { external++; return route.abort(); }
    if (url.pathname !== '/api/fund/admin/solana-recipients') return route.continue();
    expect(route.request().headers().authorization).toBe('Bearer synthetic-browser-admin-not-production');
    if (denied) return route.fulfill({ status: 401, json: { error: 'admin_unauthorized' } });
    if (route.request().method() === 'POST') {
      writes++;
      if (conflict) return route.fulfill({ status: 409, json: { error: 'solana_recipient_revision_conflict' } });
      const data = route.request().postDataJSON();
      expect(Object.keys(data).sort()).toEqual(['expectedRevision', 'fundRecipient', 'serviceRecipient']);
      expect(data.expectedRevision).toBe(stored.revision);
      stored = { ...stored, serviceRecipient: data.serviceRecipient, fundRecipient: data.fundRecipient,
        source: 'admin', revision: stored.revision + 1, updatedAt: 1792700000000 };
    }
    return route.fulfill({ json: stored });
  });
  await page.goto('/tests/fixtures/sol-recipients.html');
  return { writes: () => writes, external: () => external };
}
test('two fields validate, save once, reload server values, and never activate payments', async ({ page }) => {
  const state = await fixture(page);
  const a = page.getByLabel('Получатель оплаты сохранений', { exact: true });
  const b = page.getByLabel('Получатель помощи', { exact: true });
  const save = page.getByRole('button', { name: 'Сохранить адреса', exact: true });
  await expect(a).toBeEnabled(); await expect(save).toBeDisabled();
  await a.fill('invalid'); await b.fill(fund); await expect(save).toBeDisabled();
  await a.fill(service); await b.fill(service); await expect(save).toBeDisabled();
  await b.fill(fund); await expect(save).toBeEnabled(); await save.click();
  await expect(page.getByText('Адреса сохранены на сервере и проверены повторным чтением.')).toBeVisible();
  expect(state.writes()).toBe(1); await expect(save).toBeDisabled();
  await page.reload(); await expect(a).toHaveValue(service); await expect(b).toHaveValue(fund);
  await expect(page.getByText(/Оплата SOL пока выключена/)).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('synthetic-browser-admin');
  expect(state.external()).toBe(0);
});
test('a stale tab shows conflict instead of pretending the recipients were saved', async ({ page }) => {
  const state = await fixture(page, { conflict: true });
  await page.getByLabel('Получатель оплаты сохранений', { exact: true }).fill(replacement);
  await page.getByLabel('Получатель помощи', { exact: true }).fill(fund);
  await page.getByRole('button', { name: 'Сохранить адреса', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('другой вкладке');
  await expect(page.getByText('Адреса сохранены на сервере и проверены повторным чтением.')).toHaveCount(0);
  expect(state.writes()).toBe(1); expect(state.external()).toBe(0);
});
test('invalid admin access cannot edit or save fields', async ({ page }) => {
  const state = await fixture(page, { denied: true });
  await expect(page.getByRole('alert')).toContainText('доступ администратора');
  await expect(page.getByLabel('Получатель оплаты сохранений', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Сохранить адреса', exact: true })).toBeDisabled();
  expect(state.writes()).toBe(0); expect(state.external()).toBe(0);
});
