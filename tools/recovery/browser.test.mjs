/** Real browser, file://, offline context, synthetic archives only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readlink, rm, copyFile, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { chromium, firefox, webkit } = require('@playwright/test');
const { vectors } = JSON.parse(await readFile(new URL('./public-vectors.json', import.meta.url), 'utf8'));

async function verifyNetworkIsolation() {
  assert.equal(process.env.SEJIRE_TEST_OS_OFFLINE, '1', 'run this gate in a Linux network namespace with SEJIRE_TEST_OS_OFFLINE=1');
  assert.equal(process.platform, 'linux', 'the physical offline gate requires Linux network namespaces');
  const [self, initial, devices, ipv4, ipv6] = await Promise.all([
    readlink('/proc/self/ns/net'), readlink('/proc/1/ns/net'), readFile('/proc/net/dev', 'utf8'),
    readFile('/proc/net/route', 'utf8'), readFile('/proc/net/ipv6_route', 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error;
    }),
  ]);
  assert.match(self, /^net:\[\d+\]$/); assert.match(initial, /^net:\[\d+\]$/);
  assert.notEqual(self, initial, 'offline marker alone is insufficient: this process must use a separate network namespace');
  const deviceRows = devices.trim().split('\n');
  assert.match(deviceRows[0], /^Inter-\|/); assert.match(deviceRows[1], /face\s*\|/);
  const names = deviceRows.slice(2).filter(Boolean).map(row => row.split(':')[0].trim());
  assert(names.every(name => name === 'lo'), 'isolated namespace must contain no non-loopback devices, even if down');
  assert(Object.values(networkInterfaces()).flat().every(address => address.internal), 'isolated namespace must contain no external addresses');
  const v4Rows = ipv4.trim().split('\n'); assert.match(v4Rows[0], /^Iface\s+Destination\s+Gateway\s+Flags/);
  const v4Defaults = v4Rows.slice(1).filter(Boolean).map(row => row.trim().split(/\s+/)).filter(row => row[1] === '00000000');
  assert.equal(v4Defaults.length, 0, 'isolated namespace must have no IPv4 default route');
  const v6Defaults = ipv6.trim().split('\n').filter(Boolean).map(row => row.trim().split(/\s+/)).filter(row => {
    assert.equal(row.length, 10, 'unexpected kernel IPv6 route format');
    assert.match(row[0], /^[0-9a-f]{32}$/i); assert.match(row[1], /^[0-9a-f]{2}$/i); assert.match(row[8], /^[0-9a-f]{8}$/i);
    // Linux includes unreachable ::/0 sentinels on lo (RTF_REJECT=0x200).
    // They deny traffic; they are not usable default routes out of the namespace.
    return row[0] === '0'.repeat(32) && row[1] === '00' && !(Number.parseInt(row[8], 16) & 0x200);
  });
  assert.equal(v6Defaults.length, 0, 'isolated namespace must have no usable IPv6 default route');
}

const safeUiText = new Set(['',
  'Проверяем файл и расшифровываем на этом устройстве…',
  'Архив расшифрован. Скачайте приватный JSON: он содержит семейные данные без шифрования.',
  'Выберите зашифрованный архив или recovery kit.', 'Файл превышает предел 64 MiB.',
  'Проверьте 12 слов SEJIRE и их порядок.', 'Эти слова не соответствуют выбранному архиву.',
  'Не удалось проверить расшифровку. Проверьте слова и сохранность файла.',
  'Браузер не предоставляет WebCrypto. Используйте сохранённый recover.mjs с Node 22+.',
  'Размер или digest recovery kit не совпадает с исходными байтами.',
  'Квитанция не соответствует архиву в этом kit.',
  'Файл не прошёл проверку формата. Исходный архив не изменён.',
]);
async function waitRecovery(page, engine, vectorIndex, expectedError = null) {
  let timedOut = false;
  try {
    await page.waitForFunction(() => !document.getElementById('download').hidden ||
      document.getElementById('error').textContent.trim().length > 0, null, { timeout: 10000 });
  } catch { timedOut = true; }
  const state = await page.evaluate(() => ({
    status: document.getElementById('status').textContent.trim(),
    alert: document.getElementById('error').textContent.trim(),
    ready: !document.getElementById('download').hidden,
    busy: document.getElementById('recover').disabled,
  }));
  const safe = text => safeUiText.has(text) ? text : `[unexpected UI text, length=${text.length}]`;
  const diagnostic = JSON.stringify({ engine, vectorIndex, timedOut, status: safe(state.status), alert: safe(state.alert), ready: state.ready, busy: state.busy });
  assert(!timedOut, `recovery did not settle: ${diagnostic}`);
  if (expectedError === null) assert(state.ready && state.alert === '', `recovery did not produce a download: ${diagnostic}`);
  else assert(!state.ready && state.alert.includes(expectedError), `recovery did not reject the input as expected: ${diagnostic}`);
}

async function probeWebKitOffline(context, page, directory, t) {
  for (const offline of [true, false]) {
    const probe = join(directory, `public-file-probe-${offline}.txt`), expected = `PUBLIC FILE PROBE ${offline}`;
    await writeFile(probe, expected);
    // Isolate File.text/WebCrypto from automation's file-assignment operation.
    await context.setOffline(false);
    await page.locator('#archive').setInputFiles(probe);
    await context.setOffline(offline);
    const result = await page.evaluate(async expected => {
      const safeErrors = new Set(['AbortError', 'DataError', 'InvalidAccessError', 'InvalidStateError', 'NetworkError',
        'NotAllowedError', 'NotReadableError', 'NotSupportedError', 'OperationError', 'SecurityError', 'TimeoutError', 'TypeError', 'Error']);
      const bounded = async action => {
        let timer;
        try {
          return await Promise.race([
            action().then(ok => ({ ok: ok === true, error: null })).catch(error => ({ ok: false,
              error: safeErrors.has(error?.name) ? error.name : 'unexpected_error' })),
            new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'TimeoutError' }), 3000); }),
          ]);
        } finally { clearTimeout(timer); }
      };
      const [fileText, webcrypto] = await Promise.all([
        bounded(async () => (await document.getElementById('archive').files[0].text()) === expected),
        bounded(async () => {
          const data = new Uint8Array([1, 2, 3]), salt = new Uint8Array(32);
          const password = await crypto.subtle.importKey('raw', data, 'PBKDF2', false, ['deriveBits']);
          const seed = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', iterations: 2048, salt }, password, 512);
          const master = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits']);
          const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: data }, master, 256);
          const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
          const iv = new Uint8Array(12), ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
          const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
          return plaintext.length === data.length && plaintext.every((byte, index) => byte === data[index]);
        }),
      ]);
      return { online: navigator.onLine, fileText, webcrypto };
    }, expected);
    t.diagnostic(`webkit synthetic A/B probe (verified OS isolation): ${JSON.stringify({ offlineEmulation: offline, ...result })}`);
    if (!offline) {
      assert.equal(result.fileText.ok, true, 'WebKit must read a local File without offline emulation under verified OS isolation');
      assert.equal(result.webcrypto.ok, true, 'WebKit must support decoder cryptography under verified OS isolation');
    }
  }
  await page.getByRole('button', { name: 'Очистить', exact: true }).click();
}

for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit })) {
test(`${engine}: standalone HTML recovers current production vaults and rejects changed inputs without stale plaintext, storage or network`, { timeout: 90000 }, async t => {
  await verifyNetworkIsolation();
  t.diagnostic(`${engine}: kernel network isolation verified (different namespace, loopback only, no usable default routes)`);
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
    assert.equal(vectors.length, 2); assert.deepEqual(fixtures.map(fixture => fixture.index), [0, 3, 10, 15]);
    browser = await browserType.launch({ headless: true,
      ...(engine === 'chromium' && process.env.SEJIRE_BROWSER_EXECUTABLE ? { executablePath: process.env.SEJIRE_BROWSER_EXECUTABLE } : {}) });
    // The kernel-isolated namespace proves physical offline operation throughout,
    // including file:// navigation. HTTP interception is an additional guard.
    // WebKit's emulation flag affects local loading; the bounded A/B probe below
    // records File.text/WebCrypto outcomes without guessing the failed API.
    const emulateOffline = engine !== 'webkit';
    const context = await browser.newContext({ offline: emulateOffline, acceptDownloads: true, serviceWorkers: 'block' });
    const network = [], errors = [], consoleMessages = [];
    context.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await context.route(/^https?:\/\//, route => route.abort('internetdisconnected'));
    await context.addInitScript(() => {
      window.__storageWrites = 0;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (...args) { window.__storageWrites++; return original.apply(this, args); };
      window.__blobCreated = 0; window.__blobRevoked = 0;
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      URL.createObjectURL = function (...args) { window.__blobCreated++; return create.apply(this, args); };
      URL.revokeObjectURL = function (...args) { window.__blobRevoked++; return revoke.apply(this, args); };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => consoleMessages.push(message.text()));
    await page.goto(pathToFileURL(html).href);
    assert.equal(page.url(), pathToFileURL(html).href, 'the copied decoder must load from its actual local file');
    if (emulateOffline) assert.equal(await page.evaluate(() => navigator.onLine), false, 'Chromium/Firefox must also enable offline emulation');
    else await probeWebKitOffline(context, page, directory, t);
    t.diagnostic(`${engine}: actual file://; OS-isolated network throughout; HTTP denied; main recovery offlineEmulation=${emulateOffline}`);
    assert.equal(await page.title(), 'SEJIRE — независимое восстановление');
    assert.equal(await page.getByLabel('12 слов SEJIRE', { exact: true }).count(), 1);
    const inputs = [...vectors.map((vector, index) => ({ ...vector,
      input: index === 0 ? vector.archiveText : JSON.stringify({ schema: 'sejire/recovery-kit/v1', format: 'sejire/envelope/v1',
        archiveText: vector.archiveText, archiveDigest: vector.archiveDigest, archiveBytes: vector.archiveBytes, receipt: null }) })),
    ...fixtures.map(fixture => ({ ...fixture, input: JSON.stringify(fixture.kit) }))];
    assert.equal(inputs.length, 6);
    let successfulDownloads = 0, rejectedInputs = 0;
    for (const [index, vector] of inputs.entries()) {
      const archive = join(directory, 'synthetic-' + index + '.json');
      await writeFile(archive, vector.input);
      await page.getByLabel('Зашифрованный архив или recovery kit', { exact: true }).setInputFiles(archive);
      await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vector.words);
      await page.getByRole('button', { name: 'Восстановить файл', exact: true }).click();
      await waitRecovery(page, engine, index);
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Скачать приватный JSON', exact: true }).click();
      const download = await downloadEvent, destination = join(directory, 'private-' + index + '.json');
      await download.saveAs(destination);
      assert.equal(await download.failure(), null);
      assert.equal(download.suggestedFilename(), 'sejire-restored-private.json');
      assert.equal(await readFile(destination, 'utf8'), vector.expectedPlaintext);
      successfulDownloads++;
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
    await waitRecovery(page, engine, 'wrong-phrase', 'не соответствуют');
    rejectedInputs++;
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
      await waitRecovery(page, engine, input.name, input.error);
      rejectedInputs++;
      assert.equal(await page.locator('#download').isVisible(), false);
      assert.equal(await page.locator('#download').getAttribute('href'), null);
    }
    const broken = join(directory, 'corrupted-kit.json');
    await writeFile(broken, JSON.stringify({ schema: 'sejire/recovery-kit/v1', format: 'sejire/envelope/v1', archiveText: vectors[0].archiveText,
      archiveDigest: vectors[0].archiveDigest, archiveBytes: vectors[0].archiveBytes + 1, receipt: null }));
    await page.getByLabel('Зашифрованный архив или recovery kit', { exact: true }).setInputFiles(broken);
    await page.getByLabel('12 слов SEJIRE', { exact: true }).fill(vectors[0].words);
    await page.getByRole('button', { name: 'Восстановить файл', exact: true }).click();
    await waitRecovery(page, engine, 'corrupted-kit', 'не совпадает');
    rejectedInputs++;
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
    assert.equal(successfulDownloads, 6); assert.equal(rejectedInputs, 5);
    await verifyNetworkIsolation();
    await context.close();
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
}
