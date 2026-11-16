/** Real browser, file://, offline context, synthetic archives only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const { vectors } = JSON.parse(await readFile(new URL('./public-vectors.json', import.meta.url), 'utf8'));

test('standalone HTML opens raw files and kits offline, preserves exact JSON and rejects tampering without storage or network', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sejire-offline-html-'));
  const html = join(directory, 'recovery.html');
  await copyFile(new URL('./recovery.html', import.meta.url), html);
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.SEJIRE_BROWSER_EXECUTABLE ? { executablePath: process.env.SEJIRE_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ offline: true, acceptDownloads: true, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      window.__storageWrites = 0;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (...args) { window.__storageWrites++; return original.apply(this, args); };
    });
    const page = await context.newPage(), network = [], errors = [];
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(html).href);
    assert.equal(await page.title(), 'SEJIRE — независимое восстановление');
    assert.equal(await page.getByLabel('12 слов SEJIRE', { exact: true }).count(), 1);
    for (const [index, vector] of vectors.entries()) {
      const archive = join(directory, 'synthetic-' + index + '.json');
      const value = index === 0 ? vector.archiveText : JSON.stringify({ schema: 'sejire/recovery-kit/v1', format: 'sejire/envelope/v1',
        archiveText: vector.archiveText, archiveDigest: vector.archiveDigest, archiveBytes: vector.archiveBytes, receipt: null });
      await writeFile(archive, value);
      await page.getByLabel('Зашифрованный архив или recovery kit', { exact: true }).setInputFiles(archive);
      await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
      await page.getByRole('button', { name: 'Восстановить файл', exact: true }).click();
      await page.getByRole('link', { name: 'Скачать приватный JSON', exact: true }).waitFor({ state: 'visible' });
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Скачать приватный JSON', exact: true }).click();
      const download = await downloadEvent, destination = join(directory, 'private-' + index + '.json');
      await download.saveAs(destination);
      assert.equal(await readFile(destination, 'utf8'), vector.expectedPlaintext);
      assert.equal(await page.getByLabel('12 слов SEJIRE', { exact: true }).inputValue(), '');
      assert(!(await page.locator('body').innerText()).includes('PUBLIC SYNTHETIC Parent'));
      await page.getByRole('button', { name: 'Очистить', exact: true }).click();
      assert.equal(await page.locator('#download').isVisible(), false);
    }
    const broken = join(directory, 'corrupted-kit.json');
    await writeFile(broken, JSON.stringify({ schema: 'sejire/recovery-kit/v1', format: 'sejire/envelope/v1', archiveText: vectors[0].archiveText,
      archiveDigest: vectors[0].archiveDigest, archiveBytes: vectors[0].archiveBytes + 1, receipt: null }));
    await page.getByLabel('Зашифрованный архив или recovery kit', { exact: true }).setInputFiles(broken);
    await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vectors[0].words);
    await page.getByRole('button', { name: 'Восстановить файл', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'не совпадает' }).waitFor();
    assert.equal(await page.locator('#download').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__storageWrites), 0);
    assert.deepEqual(network, []); assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
