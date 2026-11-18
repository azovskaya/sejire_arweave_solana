/** Real browser, file://, offline context, synthetic archives only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { chromium, firefox, webkit } = require('@playwright/test');
const { vectors } = JSON.parse(await readFile(new URL('./public-vectors.json', import.meta.url), 'utf8'));

for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit })) {
test(`${engine}: standalone HTML recovers current production vaults and rejects changed inputs without stale plaintext, storage or network`, { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sejire-offline-html-'));
  const html = join(directory, 'recovery.html');
  await copyFile(new URL('./recovery.html', import.meta.url), html);
  let browser;
  try {
    const fixtureFile = join(directory, 'production-fixtures.json');
    const generated = spawnSync(process.execPath, ['--import',
      fileURLToPath(new URL('../../apps/web/node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures.test-helper.mts', import.meta.url)), '--output', fixtureFile],
    { encoding: 'utf8', timeout: 30000 });
    assert.equal(generated.error, undefined); assert.equal(generated.status, 0, generated.stderr);
    const { fixtures, seed } = JSON.parse(await readFile(fixtureFile, 'utf8'));
    assert.equal(seed, 0x5e171118);
    browser = await browserType.launch({ headless: true,
      ...(engine === 'chromium' && process.env.SEJIRE_BROWSER_EXECUTABLE ? { executablePath: process.env.SEJIRE_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ offline: true, acceptDownloads: true, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      window.__storageWrites = 0;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (...args) { window.__storageWrites++; return original.apply(this, args); };
      window.__blobCreated = 0; window.__blobRevoked = 0;
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      URL.createObjectURL = function (...args) { window.__blobCreated++; return create.apply(this, args); };
      URL.revokeObjectURL = function (...args) { window.__blobRevoked++; return revoke.apply(this, args); };
    });
    const page = await context.newPage(), network = [], errors = [], consoleMessages = [];
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => consoleMessages.push(message.text()));
    await page.goto(pathToFileURL(html).href);
    assert.equal(await page.title(), 'SEJIRE — независимое восстановление');
    assert.equal(await page.getByLabel('12 слов SEJIRE', { exact: true }).count(), 1);
    const inputs = [...vectors.map((vector, index) => ({ ...vector,
      input: index === 0 ? vector.archiveText : JSON.stringify({ schema: 'sejire/recovery-kit/v1', format: 'sejire/envelope/v1',
        archiveText: vector.archiveText, archiveDigest: vector.archiveDigest, archiveBytes: vector.archiveBytes, receipt: null }) })),
    ...fixtures.map(fixture => ({ ...fixture, input: JSON.stringify(fixture.kit) }))];
    for (const [index, vector] of inputs.entries()) {
      const archive = join(directory, 'synthetic-' + index + '.json');
      await writeFile(archive, vector.input);
      await page.getByLabel('Зашифрованный архив или recovery kit', { exact: true }).setInputFiles(archive);
      await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
      await page.getByRole('button', { name: 'Восстановить файл', exact: true }).click();
      await page.getByRole('link', { name: 'Скачать приватный JSON', exact: true }).waitFor({ state: 'visible' });
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Скачать приватный JSON', exact: true }).click();
      const download = await downloadEvent, destination = join(directory, 'private-' + index + '.json');
      await download.saveAs(destination);
      assert.equal(await download.failure(), null);
      assert.equal(download.suggestedFilename(), 'sejire-restored-private.json');
      assert.equal(await readFile(destination, 'utf8'), vector.expectedPlaintext);
      assert.equal((await page.getByLabel('12 слов SEJIRE', { exact: true }).inputValue()).length, 0);
      assert(!(await page.locator('body').innerText()).includes('PUBLIC SYNTHETIC'));
      if (index !== inputs.length - 1) {
        await page.getByRole('button', { name: 'Очистить', exact: true }).click();
        assert.equal(await page.locator('#download').isVisible(), false);
      }
    }
    // The final successful download is still visible. Changing words must revoke
    // that plaintext URL before a failing recovery, not merely show a new error.
    const latest = fixtures.at(-1), wrong = fixtures[0];
    await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(wrong.words);
    assert.equal(await page.locator('#download').isVisible(), false);
    assert.equal(await page.locator('#download').getAttribute('href'), null);
    await page.getByRole('button', { name: 'Восстановить файл', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'не соответствуют' }).waitFor();
    assert.equal(await page.locator('#download').isVisible(), false);
    const ciphertext = Buffer.from(latest.envelope.ciphertext, 'base64'); ciphertext[Math.floor(ciphertext.length / 2)] ^= 1;
    const rejected = [
      { name: 'ciphertext', text: JSON.stringify({ ...latest.envelope, ciphertext: ciphertext.toString('base64') }), error: 'Не удалось проверить расшифровку' },
      { name: 'truncated', text: latest.archiveText.slice(0, -5), error: 'не прошёл проверку формата' },
      { name: 'unsupported', text: JSON.stringify({ ...latest.envelope, protocol: 'sejire/future-unsupported' }), error: 'не прошёл проверку формата' },
    ];
    for (const input of rejected) {
      const file = join(directory, `${input.name}.json`); await writeFile(file, input.text);
      await page.getByLabel('Зашифрованный архив или recovery kit', { exact: true }).setInputFiles(file);
      await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(latest.words);
      await page.getByRole('button', { name: 'Восстановить файл', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: input.error }).waitFor();
      assert.equal(await page.locator('#download').isVisible(), false);
      assert.equal(await page.locator('#download').getAttribute('href'), null);
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
    assert.deepEqual(await page.evaluate(() => ({ created: window.__blobCreated, revoked: window.__blobRevoked })),
      { created: inputs.length, revoked: inputs.length });
    const visibleText = (await page.locator('#status, #error, #download').allTextContents()).join('\n');
    for (const fixture of inputs) {
      assert(!visibleText.includes(fixture.words), 'archive words must not enter page output');
      assert(!consoleMessages.some(message => message.includes(fixture.words) || message.includes('PUBLIC SYNTHETIC')),
        'console must not contain words or plaintext');
    }
    assert.equal(network.length, 0, 'standalone recovery must not request HTTP resources');
    assert.equal(errors.length, 0, 'standalone recovery must not raise page errors');
    await context.close();
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
}
