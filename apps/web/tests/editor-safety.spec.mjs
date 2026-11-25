import { test, expect } from '@playwright/test';

const CHILD = 'safety_child', MOTHER = 'safety_mother';
const CHILD_NAME = 'Regression Child', MOTHER_NAME = 'Regression Mother';

async function draft(page) {
  return page.evaluate(async () => (await import('/src/lib/draftStorage.ts')).loadDraftTree());
}
async function profile(page, name) {
  await page.locator('button.person-card').filter({ hasText: name }).dispatchEvent('click');
  await expect(page.locator('.person-panel.is-open input').first()).toHaveValue(name);
}
async function setup(page) {
  const external = [], writes = [], errors = [];
  async function watchPage(target) {
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', msg => { if (/flushSync.*(lifecycle|rendering)/i.test(msg.text())) errors.push(msg.text()); });
    target.on('request', request => {
      if (request.method() !== 'GET' && request.method() !== 'HEAD') writes.push(request.url());
    });
    await target.route('**/*', route => {
      if (new URL(route.request().url()).origin === 'http://127.0.0.1:5186') return route.continue();
      external.push(route.request().url()); return route.abort();
    });
  }
  await watchPage(page);
  await page.addInitScript(() => {
    const original = window.setTimeout.bind(window);
    // Reproduce an action BEFORE autosave deterministically, independent of CI speed.
    // Keep undo available while Playwright checks intermediate state.
    window.setTimeout = (handler, delay, ...args) => original(handler,
      delay === 350 || delay === 7000 ? 60000 : delay, ...args);
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Освободить черновик', exact: true })).toBeVisible();
  const baseline = await page.evaluate(async ({ CHILD, MOTHER, CHILD_NAME, MOTHER_NAME }) => {
    const engine = await import('/src/lib/treeEngine.ts');
    const { saveDraftTree } = await import('/src/lib/draftStorage.ts');
    const { defaultGuide, saveGuide } = await import('/src/lib/guide.ts');
    const { rememberScreen } = await import('/src/lib/lastScreen.ts');
    let store = engine.createTree('Synthetic editor safety');
    for (const person of [
      { id: CHILD, name: CHILD_NAME, sex: 'M', parents: [MOTHER], media: [], notes: 'Original child note' },
      { id: MOTHER, name: MOTHER_NAME, sex: 'F', parents: [], media: [], notes: 'Original mother note' },
    ]) store = engine.setDraftPerson(store, person);
    store = engine.commitDraft(store, 'Synthetic baseline');
    if (!saveDraftTree(store)) throw Error('synthetic_draft_not_saved');
    saveGuide({ ...defaultGuide(), selfId: CHILD, motherId: MOTHER, step: 'done' });
    rememberScreen('work');
    return store;
  }, { CHILD, MOTHER, CHILD_NAME, MOTHER_NAME });
  await page.reload();
  await expect(page.locator('button.person-card').filter({ hasText: CHILD_NAME })).toBeVisible();
  await expect(page.locator('.app-topbar .top-actions > button.btn')).toBeEnabled();
  return { baseline, watchPage, assertReadOnly(expectedRenderErrors = []) {
    expect(external).toEqual([]); expect(writes).toEqual([]);
    expect(errors.filter(error => !expectedRenderErrors.includes(error))).toEqual([]);
  } };
}

test('the final input is durable in the same event task before immediate reload', async ({ page }) => {
  const f = await setup(page);
  await profile(page, CHILD_NAME);
  const text = 'Последняя буква: Ә — не терять пробел ';
  const firstReload = page.waitForEvent('domcontentloaded');
  await page.locator('.person-panel textarea').evaluate((field, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    // No blur, timeout or React effect can complete a delayed save first.
    location.reload();
  }, text);
  await firstReload;
  await expect(page.locator('.workspace-main')).toBeVisible();
  expect((await draft(page)).draft.persons[CHILD].notes).toBe(text);
  expect((await draft(page)).commits).toEqual(f.baseline.commits);
  await profile(page, CHILD_NAME);
  const name = 'Алия Мария ';
  const secondReload = page.waitForEvent('domcontentloaded');
  await page.locator('.person-panel input').first().evaluate((field, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    location.reload();
  }, name);
  await secondReload;
  await expect(page.locator('.workspace-main')).toBeVisible();
  expect((await draft(page)).draft.persons[CHILD].name).toBe(name);
  expect((await draft(page)).draft.persons[CHILD].notes).toBe(text);
  expect((await draft(page)).commits).toEqual(f.baseline.commits);
  f.assertReadOnly();
});

test('two real tabs share one writer, explicitly hand off and reload the newest complete draft', async ({ page, context }) => {
  const f = await setup(page), other = await context.newPage();
  await f.watchPage(other);
  try {
    await profile(page, CHILD_NAME);
    await page.locator('.person-panel textarea').fill('Written immediately by the first tab');
    await page.locator('.person-panel-head button').click();
    await other.goto('/');
    await expect(other.locator('.draft-access-notice')).toContainText('открыт в другой вкладке');
    await expect(other.getByRole('button', { name: 'Продолжить', exact: true })).toBeDisabled();
    await expect(other.getByRole('button', { name: 'Новое древо', exact: true })).toBeDisabled();
    await expect(other.getByRole('button', { name: 'Открыть по 12 словам', exact: true })).toBeDisabled();
    await expect(other.locator('.workspace-main')).toHaveCount(0);
    const downloading = other.waitForEvent('download');
    await other.getByRole('button', { name: 'Скачать сохранённую копию', exact: true }).click();
    const downloaded = await downloading, chunks = [];
    for await (const chunk of await downloaded.createReadStream()) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(exported.store.draft.persons[CHILD].notes).toBe('Written immediately by the first tab');
    expect(exported.store.commits).toEqual(f.baseline.commits);

    await page.getByRole('button', { name: 'Освободить черновик', exact: true }).click();
    await expect(page.locator('.workspace-main')).toHaveCount(0);
    await other.getByRole('button', { name: 'Продолжить здесь', exact: true }).click();
    await expect(other.getByRole('button', { name: 'Продолжить', exact: true })).toBeEnabled();
    await other.getByRole('button', { name: 'Продолжить', exact: true }).click();
    await profile(other, CHILD_NAME);
    await expect(other.locator('.person-panel textarea')).toHaveValue('Written immediately by the first tab');
    await other.locator('.person-panel textarea').fill('The second tab owns these newer changes');
    await other.locator('.person-panel-head button').click();

    await page.getByRole('button', { name: 'Продолжить здесь', exact: true }).click();
    await expect(page.locator('.draft-access-notice')).toContainText('открыт в другой вкладке');
    expect((await draft(page)).draft.persons[CHILD].notes).toBe('The second tab owns these newer changes');
    // Reloading the reader also cannot take over or autosave its old snapshot.
    await page.reload();
    await expect(page.locator('.draft-access-notice')).toContainText('открыт в другой вкладке');
    expect((await draft(page)).draft.persons[CHILD].notes).toBe('The second tab owns these newer changes');

    await other.close();
    // Browser document-close completion and the Web Locks cleanup task are
    // separate events. Confirm release before one explicit ifAvailable retry.
    await expect.poll(() => page.evaluate(async () =>
      (await navigator.locks.query()).held.filter(lock => lock.name === 'sejire.draft-writer.v1').length
    ), { message: 'The closed tab must release its actual draft writer lock' }).toBe(0);
    await page.getByRole('button', { name: 'Продолжить здесь', exact: true }).click();
    await expect(page.locator('.workspace-main')).toBeVisible();
    expect(await page.evaluate(async () =>
      (await navigator.locks.query()).held.filter(lock => lock.name === 'sejire.draft-writer.v1').map(lock => lock.mode)
    )).toEqual(['exclusive']);
    await profile(page, CHILD_NAME);
    await expect(page.locator('.person-panel textarea')).toHaveValue('The second tab owns these newer changes');
    expect((await draft(page)).commits).toEqual(f.baseline.commits);
    f.assertReadOnly();
  } finally { if (!other.isClosed()) await other.close(); }
});

test('pagehide releases the writer and persisted pageshow cannot overwrite a tab that acquired it', async ({ page, context }) => {
  const f = await setup(page), other = await context.newPage();
  await f.watchPage(other);
  try {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await other.goto('/');
    await expect(other.getByRole('button', { name: 'Продолжить', exact: true })).toBeEnabled();
    await other.getByRole('button', { name: 'Продолжить', exact: true }).click();
    await profile(other, CHILD_NAME);
    await other.locator('.person-panel textarea').fill('Changed while the first document was suspended');
    await other.locator('.person-panel-head button').click();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('.draft-access-notice')).toContainText('открыт в другой вкладке');
    await expect(page.locator('.workspace-main')).toHaveCount(0);
    expect((await draft(page)).draft.persons[CHILD].notes).toBe('Changed while the first document was suspended');
    await other.close();
    await expect.poll(() => page.evaluate(async () =>
      (await navigator.locks.query()).held.filter(lock => lock.name === 'sejire.draft-writer.v1').length
    ), { message: 'The closed tab must release its actual draft writer lock' }).toBe(0);
    await page.getByRole('button', { name: 'Продолжить здесь', exact: true }).click();
    await expect(page.locator('.workspace-main')).toBeVisible();
    expect(await page.evaluate(async () =>
      (await navigator.locks.query()).held.filter(lock => lock.name === 'sejire.draft-writer.v1').map(lock => lock.mode)
    )).toEqual(['exclusive']);
    expect((await draft(page)).draft.persons[CHILD].notes).toBe('Changed while the first document was suspended');
    f.assertReadOnly();
  } finally { if (!other.isClosed()) await other.close(); }
});

test('missing Web Locks leaves the saved draft downloadable without an unsafe writer fallback', async ({ page }) => {
  const f = await setup(page), before = await draft(page);
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
  await page.reload();
  await expect(page.locator('.draft-access-notice')).toContainText('Редактирование остановлено');
  await expect(page.locator('.workspace-main')).toHaveCount(0);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать сохранённую копию', exact: true }).click();
  const download = await downloading, chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8')).store).toEqual(before);
  expect(await draft(page)).toEqual(before);
  f.assertReadOnly();
});

test('quota refusal retains the last input for export and explicit retry without deleting the old draft', async ({ page }) => {
  const f = await setup(page), before = await draft(page);
  await profile(page, CHILD_NAME);
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    window.allowDraftWrites = () => { Storage.prototype.setItem = write; };
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === 'sejire.draft.tree.v1') throw new DOMException('Synthetic draft quota', 'QuotaExceededError');
      return write.call(this, key, value);
    };
  });
  const note = 'Latest unsaved text must remain recoverable';
  await page.locator('.person-panel textarea').fill(note);
  await expect(page.locator('.draft-access-notice')).toContainText('пока не записаны');
  expect(await draft(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Освободить черновик', exact: true })).toBeDisabled();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать мои изменения', exact: true }).click();
  const download = await downloading, chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(exported.store.draft.persons[CHILD].notes).toBe(note);
  expect(exported.store.commits).toEqual(before.commits);
  await page.evaluate(() => window.allowDraftWrites());
  await page.getByRole('button', { name: 'Повторить локальное сохранение', exact: true }).click();
  await expect(page.locator('.draft-access-notice')).not.toContainText('пока не записаны');
  expect((await draft(page)).draft.persons[CHILD].notes).toBe(note);
  expect((await draft(page)).commits).toEqual(before.commits);
  f.assertReadOnly();
});

test('opening the saved draft after a render failure leaves the failed deep link', async ({ page }) => {
  const f = await setup(page);
  const before = await draft(page);
  const crash = 'Synthetic save-screen render failure';
  // Exercise the real boundary and reload boot path, with a deliberately broken
  // screen. Once the fragment is cleared this component is no longer mounted.
  await page.route('**/src/components/PreservationV2.tsx*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export function PreservationV2() { throw Error(${JSON.stringify(crash)}); }`,
  }));
  await page.goto('/#/save');
  await page.reload();
  await expect(page.locator('.crash-detail')).toHaveText(crash);
  expect(await draft(page)).toEqual(before);
  await page.getByRole('button', { name: 'Открыть черновик', exact: true }).click();
  await expect(page).toHaveURL(/:\/\/127\.0\.0\.1:5186\/$/);
  await expect(page.locator('.workspace-main')).toBeVisible();
  await expect(page.locator('.crash-screen')).toHaveCount(0);
  expect(await draft(page)).toEqual(before);
  f.assertReadOnly([crash]);
});

test('a delayed save lookup cannot replace a new tree after leaving the old editor', async ({ page }) => {
  const f = await setup(page);
  await profile(page, CHILD_NAME);
  await page.locator('.person-panel textarea').fill('Old dirty tree waiting to save');
  await page.locator('.person-panel-head button').click();
  await expect.poll(async () => (await draft(page)).dirty).toBe(true);
  await page.evaluate(async () => {
    // Hold the actual shared journal lock, rather than replacing a runtime module.
    await new Promise(acquired => {
      window.editorSaveGate = navigator.locks.request('sejire.preservation-attempts.v1', async () => {
        const release = new Promise(resolve => { window.releaseEditorSaveGate = resolve; });
        acquired();
        await release;
      });
    });
  });
  await page.locator('.app-topbar .top-actions > button.btn').click();
  await expect.poll(() => page.evaluate(async () =>
    (await navigator.locks.query()).pending.filter(lock => lock.name === 'sejire.preservation-attempts.v1').length
  )).toBe(1);
  await page.locator('.top-more > summary').click();
  await page.locator('.top-more-menu > button').last().click();
  await expect(page.locator('.workspace-main')).toHaveCount(0);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Новое древо', exact: true }).click();
  await expect(page.locator('.pedigree-empty')).toBeVisible();
  const replacement = await draft(page);
  expect(replacement.meta.id).not.toBe(f.baseline.meta.id);
  expect(replacement.draft.persons).toEqual({});
  await page.evaluate(async () => {
    window.releaseEditorSaveGate();
    await window.editorSaveGate;
    await navigator.locks.request('sejire.preservation-attempts.v1', () => undefined);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator('.app-topbar .top-actions > button.btn')).toBeEnabled();
  expect(await draft(page)).toEqual(replacement);
  await expect(page.locator('.pedigree-empty')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  f.assertReadOnly();
});

async function prepareFundedRestore(page) {
  const f = await setup(page);
  await page.goto('/#/restore');
  const encrypted = await page.evaluate(async () => {
    window.restoreAuditFixture = await (await import('/tests/browser-fixture.ts')).fixture();
    return window.restoreAuditFixture.serialized;
  });
  await page.getByRole('button', { name: 'Открыть из файла', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-restore-audit.json', mimeType: 'application/json', buffer: Buffer.from(encrypted) });
  await page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' }).evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, window.restoreAuditFixture.words);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return f;
}

async function restorationSelection(page) {
  return page.evaluate(() => ({
    draft: localStorage.getItem('sejire.draft.tree.v1'),
    session: sessionStorage.getItem('sejire.vaultSession.v1'),
    cache: localStorage.getItem('sejire.envelope.' + window.restoreAuditFixture.vault.vault_id),
  }));
}

test('pending restoration cannot write cache, session or draft after another real tab receives ownership', async ({ page, context }) => {
  const f = await prepareFundedRestore(page), before = await restorationSelection(page);
  const other = await context.newPage();
  await f.watchPage(other);
  let confirmations = 0;
  page.on('dialog', async dialog => { confirmations++; await dialog.accept(); });
  await page.evaluate(() => {
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    crypto.subtle.decrypt = async (...args) => {
      const result = await decrypt(...args);
      window.draftOwnershipDecryptWaiting = true;
      await new Promise(resolve => { window.releaseDraftOwnershipDecrypt = resolve; });
      return result;
    };
  });
  try {
    await page.getByRole('button', { name: 'Восстановить архив', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.draftOwnershipDecryptWaiting)).toBe(true);
    await page.getByRole('button', { name: 'Освободить черновик', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' })).toHaveCount(0);
    await other.goto('/');
    await other.getByRole('button', { name: 'Продолжить', exact: true }).click();
    await profile(other, CHILD_NAME);
    await other.locator('.person-panel textarea').fill('The new owner retains this draft');
    await other.locator('.person-panel-head button').click();
    const latest = await draft(other);
    await page.evaluate(async () => {
      window.releaseDraftOwnershipDecrypt();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(confirmations).toBe(0);
    const after = await restorationSelection(page);
    expect(after.cache).toBe(before.cache);
    expect(after.session).toBe(before.session);
    expect(await draft(page)).toEqual(latest);
    expect(latest.draft.persons[CHILD].notes).toBe('The new owner retains this draft');
    expect(latest.commits).toEqual(f.baseline.commits);
    f.assertReadOnly();
  } finally { await other.close(); }
});

test('an old application writing without the lock is detected before this tab can overwrite it', async ({ page, context }) => {
  const f = await setup(page), other = await context.newPage();
  await f.watchPage(other);
  try {
    await other.goto('/');
    await expect(other.locator('.draft-access-notice')).toContainText('открыт в другой вкладке');
    await other.evaluate(id => {
      const tree = JSON.parse(localStorage.getItem('sejire.draft.tree.v1'));
      tree.draft.persons[id].notes = 'Written by an older application without Web Locks';
      localStorage.setItem('sejire.draft.tree.v1', JSON.stringify(tree));
    }, CHILD);
    await expect(page.locator('.draft-access-notice')).toContainText('изменён вне этой вкладки');
    await expect(page.locator('.workspace-main')).toHaveCount(0);
    expect((await draft(page)).draft.persons[CHILD].notes).toBe('Written by an older application without Web Locks');
    await page.getByRole('button', { name: 'Продолжить здесь', exact: true }).click();
    await expect(page.locator('.workspace-main')).toBeVisible();
    await profile(page, CHILD_NAME);
    await expect(page.locator('.person-panel textarea')).toHaveValue('Written by an older application without Web Locks');
    expect((await draft(page)).commits).toEqual(f.baseline.commits);
    f.assertReadOnly();
  } finally { await other.close(); }
});

test('funded restoration rolls back the full selection when session persistence fails', async ({ page }) => {
  const f = await prepareFundedRestore(page);
  const before = await restorationSelection(page);
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && key === 'sejire.vaultSession.v1') throw new DOMException('Synthetic write failure', 'QuotaExceededError');
      return write.call(this, key, value);
    };
  });
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Восстановить архив', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' })).toBeVisible();
  expect(await restorationSelection(page)).toEqual(before);
  expect(await page.evaluate(async () => (await import('/src/lib/vaultSession/session.ts')).getSessionMnemonic())).toBeNull();
  f.assertReadOnly();
});

test('a restored full vault survives two funded preparations and closing without an order', async ({ page }) => {
  const f = await prepareFundedRestore(page);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Восстановить архив', exact: true }).click();
  await expect(page.locator('.workspace-main')).toBeVisible();
  const original = await page.evaluate(() => window.restoreAuditFixture.vault);
  let previousDigest = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('.app-topbar .top-actions > button.btn').click();
    await page.getByRole('dialog').getByRole('button', { name: 'По промокоду', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Сохранить по промокоду', exact: true })).toBeVisible();
    const prepared = await page.evaluate(async () => {
      const { getVaultSession, vaultEnvelopeDigest } = await import('/src/lib/vaultSession/session.ts');
      const { deriveKeysFromMnemonic } = await import('/src/lib/crypto/keys.ts');
      const { openEnvelope } = await import('/src/lib/crypto/vault.ts');
      const session = getVaultSession();
      const envelope = JSON.parse(localStorage.getItem('sejire.envelope.' + session.vaultId));
      return { session, digest: vaultEnvelopeDigest(envelope), vault: await openEnvelope(deriveKeysFromMnemonic(window.restoreAuditFixture.words), envelope) };
    });
    expect(prepared.session.source).toBe('local');
    expect(prepared.session.headTxId).toBeNull();
    expect(prepared.session.cacheDigest).toBe(prepared.digest);
    expect(prepared.digest).not.toBe(previousDigest);
    expect(Object.keys(prepared.vault.trees).sort()).toEqual(Object.keys(original.trees).sort());
    for (const [treeId, tree] of Object.entries(original.trees)) {
      for (const [commitId, commit] of Object.entries(tree.commits)) expect(prepared.vault.trees[treeId].commits[commitId]).toEqual(commit);
      if (treeId !== original.active_tree_id) expect(prepared.vault.trees[treeId]).toEqual(tree);
    }
    previousDigest = prepared.digest;
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  f.assertReadOnly();
});

test('funded encryption finishing after route departure cannot change the selected archive', async ({ page }) => {
  const f = await prepareFundedRestore(page);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Восстановить архив', exact: true }).click();
  await expect(page.locator('.workspace-main')).toBeVisible();
  await page.locator('.app-topbar .top-actions > button.btn').click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'По промокоду', exact: true })).toBeVisible();
  const before = await restorationSelection(page);
  await page.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = async (...args) => {
      const encrypted = await encrypt(...args);
      window.preparationAuditWaiting = true;
      await new Promise(resolve => { window.releasePreparationAudit = resolve; });
      return encrypted;
    };
  });
  await page.getByRole('dialog').getByRole('button', { name: 'По промокоду', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.preparationAuditWaiting)).toBe(true);
  await page.evaluate(() => { location.hash = '#/restore'; });
  await expect(page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' })).toBeVisible();
  await page.evaluate(async () => {
    window.releasePreparationAudit();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  expect(await restorationSelection(page)).toEqual(before);
  f.assertReadOnly();
});

test('funded restoration cannot replace edits after leaving while decryption is pending', async ({ page }) => {
  const f = await prepareFundedRestore(page);
  const before = await restorationSelection(page);
  let prompts = 0;
  page.on('dialog', async dialog => { prompts++; await dialog.accept(); });
  await page.evaluate(() => {
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    crypto.subtle.decrypt = async (...args) => {
      const decrypted = await decrypt(...args);
      window.restoreAuditWaiting = true;
      await new Promise(resolve => { window.releaseRestoreAudit = resolve; });
      return decrypted;
    };
  });
  await page.getByRole('button', { name: 'Восстановить архив', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.restoreAuditWaiting)).toBe(true);
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' })).toHaveCount(0);
  await page.evaluate(async () => {
    window.releaseRestoreAudit();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  expect(prompts).toBe(0);
  expect(await restorationSelection(page)).toEqual(before);
  await expect(page.locator('.workspace-main')).toHaveCount(0);
  f.assertReadOnly();
});

test('leaving funded restoration clears its fragment and reload does not reopen it', async ({ page }) => {
  const f = await setup(page);
  const before = await draft(page);
  await page.goto('/#/restore');
  await expect(page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' })).toBeVisible();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page).toHaveURL(/:\/\/127\.0\.0\.1:5186\/$/);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' })).toHaveCount(0);
  expect(await draft(page)).toEqual(before);
  f.assertReadOnly();
});

test('funded restore fragment changed before subscription is reconciled without changing the draft', async ({ page }) => {
  const f = await setup(page);
  const before = await draft(page);
  await page.addInitScript(() => {
    const add = window.addEventListener;
    window.addEventListener = function (type, listener, options) {
      if (type === 'hashchange') {
        window.addEventListener = add;
        const oldURL = location.href;
        history.replaceState(null, '', location.pathname + location.search + '#/restore');
        window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
      }
      return add.call(this, type, listener, options);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' })).toBeVisible();
  expect(await draft(page)).toEqual(before);
  // Browser Back/fragment clearing also leaves restoration.
  await page.evaluate(() => { location.hash = ''; });
  await expect(page.getByRole('textbox', { name: '12 слов восстановления SEJIRE' })).toHaveCount(0);
  expect(await draft(page)).toEqual(before);
  f.assertReadOnly();
});

test('ordinary funded save imports a general ciphertext without entering the fixed Devnet pilot', async ({ page }) => {
  const f = await setup(page);
  await page.addInitScript(() => {
    window.auditWalletCalls = 0;
    const unexpected = () => { window.auditWalletCalls++; throw Error('Unexpected synthetic wallet access'); };
    window.phantom = { solana: { connect: unexpected, signTransaction: unexpected } };
    window.arweaveWallet = { connect: unexpected, sign: unexpected };
  });
  await page.goto('/#/save');
  // A fragment-only goto keeps the existing document and skips addInitScript.
  // Reload so the wallet trap exists before React's initial render.
  await page.reload();
  await expect(page.getByLabel('Зашифрованный архив', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Зашифрованный архив пилота', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Solana Devnet|Прежний тестовый пилот|0\.03 SOL/)).toHaveCount(0);
  const encrypted = await page.evaluate(async () => (await (await import('/tests/browser-fixture.ts')).fixture()).serialized);
  await page.getByLabel('Зашифрованный архив', { exact: true }).setInputFiles({ name: 'synthetic-general-vault.json', mimeType: 'application/json', buffer: Buffer.from(encrypted) });
  await expect(page.getByRole('button', { name: 'По промокоду', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Через Solana', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.auditWalletCalls)).toBe(0);
  f.assertReadOnly();
});

test('ordinary funded file import cannot adopt its late result after returning to the editor', async ({ page }) => {
  const f = await setup(page);
  const before = await draft(page);
  await page.goto('/#/save');
  const encrypted = await page.evaluate(async () => (await (await import('/tests/browser-fixture.ts')).fixture()).serialized);
  await page.evaluate(() => {
    const read = File.prototype.text;
    File.prototype.text = async function () {
      const text = await read.call(this);
      window.importAuditWaiting = true;
      await new Promise(resolve => { window.releaseImportAudit = resolve; });
      return text;
    };
  });
  await page.getByLabel('Зашифрованный архив', { exact: true }).setInputFiles({ name: 'synthetic-delayed-vault.json', mimeType: 'application/json', buffer: Buffer.from(encrypted) });
  await expect.poll(() => page.evaluate(() => window.importAuditWaiting)).toBe(true);
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.locator('.workspace-main')).toBeVisible();
  await page.evaluate(async () => {
    window.releaseImportAudit();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  expect(await draft(page)).toEqual(before);
  await expect(page.getByLabel('Зашифрованный архив', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'По промокоду', exact: true })).toHaveCount(0);
  f.assertReadOnly();
});

test('undo deletion keeps newer edits to another person and immutable history', async ({ page }) => {
  const f = await setup(page);
  await profile(page, MOTHER_NAME);
  await page.locator('.person-panel .delete-zone > button').click();
  await page.locator('.person-panel .delete-confirm button.danger').click();
  await expect.poll(async () => (await draft(page)).draft.persons[MOTHER].tombstone).toBe(true);
  await profile(page, CHILD_NAME);
  await page.locator('.person-panel textarea').fill('Newer child note must survive undo');
  await page.locator('.person-panel-head button').click();
  await expect.poll(async () => (await draft(page)).draft.persons[CHILD].notes).toBe('Newer child note must survive undo');
  await page.locator('.toast-undo').click();
  await expect.poll(async () => (await draft(page)).draft.persons[MOTHER].tombstone).toBe(false);
  const restored = await draft(page);
  expect(restored.draft.persons[CHILD].notes).toBe('Newer child note must survive undo');
  expect(restored.commits).toEqual(f.baseline.commits);
  expect(restored.draft.persons[CHILD].parents).toEqual([MOTHER]);
  f.assertReadOnly();
});

test('switching directly to another card flushes pending notes', async ({ page }) => {
  const f = await setup(page);
  await profile(page, CHILD_NAME);
  await page.locator('.person-panel textarea').fill('Pending before card switch');
  await profile(page, MOTHER_NAME);
  await expect.poll(async () => (await draft(page)).draft.persons[CHILD].notes).toBe('Pending before card switch');
  expect((await draft(page)).draft.persons[MOTHER].notes).toBe('Original mother note');
  f.assertReadOnly();
});

test('going home flushes pending notes before the editor unmounts', async ({ page }) => {
  const f = await setup(page);
  await profile(page, CHILD_NAME);
  await page.locator('.person-panel textarea').fill('Pending before home');
  await page.locator('.top-more > summary').click();
  await page.locator('.top-more-menu > button').last().click();
  await expect(page.locator('.workspace-main')).toHaveCount(0);
  expect((await draft(page)).draft.persons[CHILD].notes).toBe('Pending before home');
  await page.reload();
  expect((await draft(page)).draft.persons[CHILD].notes).toBe('Pending before home');
  f.assertReadOnly();
});

test('JSON download contains the visible final note without waiting for autosave', async ({ page }) => {
  const f = await setup(page);
  await profile(page, CHILD_NAME);
  await page.locator('.person-panel textarea').fill('Final note in downloaded JSON');
  await page.locator('.top-more > summary').click();
  const downloading = page.waitForEvent('download');
  await page.locator('.top-more-menu > button').filter({ hasText: /JSON/i }).first().click();
  const download = await downloading;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(JSON.stringify(exported)).toContain('Final note in downloaded JSON');
  expect((await draft(page)).draft.persons[CHILD].notes).toBe('Final note in downloaded JSON');
  f.assertReadOnly();
});

test('save snapshots the final visible note and preserves previous commits without an order', async ({ page }) => {
  const f = await setup(page);
  await profile(page, CHILD_NAME);
  await page.locator('.person-panel textarea').fill('Final note in saved snapshot');
  await page.locator('.app-topbar .top-actions > button.btn').click();
  await expect.poll(async () => {
    const store = await draft(page);
    return store.commits[store.meta.head]?.snapshot.persons[CHILD].notes;
  }).toBe('Final note in saved snapshot');
  const saved = await draft(page);
  expect(Object.keys(saved.commits)).toHaveLength(Object.keys(f.baseline.commits).length + 1);
  for (const [id, commit] of Object.entries(f.baseline.commits)) expect(saved.commits[id]).toEqual(commit);
  expect(saved.draft.persons[CHILD].parents).toEqual([MOTHER]);
  f.assertReadOnly();
});

test('unchanged profile does not create an extra revision when opening save', async ({ page }) => {
  const f = await setup(page);
  await profile(page, CHILD_NAME);
  await page.locator('.app-topbar .top-actions > button.btn').click();
  expect((await draft(page)).commits).toEqual(f.baseline.commits);
  f.assertReadOnly();
});

test('PDF export receives the current snapshot, not the pre-autosave profile', async ({ page }) => {
  const f = await setup(page);
  // Test the data handed to the exporter, without generating or uploading a PDF.
  await page.route('**/src/lib/pdf/classicTreePdf.ts*', route => route.fulfill({
    contentType: 'application/javascript', body: 'export async function downloadClassicTreePdf(input) { window.editorPdfInput = input; return "A4"; }',
  }));
  await profile(page, CHILD_NAME);
  await page.locator('.person-panel textarea').fill('Final note handed to PDF');
  await page.locator('.top-more > summary').click();
  // The first menu item is affiliation; the second is the classic tree exporter.
  await page.locator('.top-more-menu > button').nth(1).click();
  await expect.poll(() => page.evaluate(id => window.editorPdfInput?.snapshot.persons[id].notes, CHILD))
    .toBe('Final note handed to PDF');
  f.assertReadOnly();
});
