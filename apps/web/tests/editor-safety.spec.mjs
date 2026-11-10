import { test, expect } from '@playwright/test';

const CHILD = 'safety_child', MOTHER = 'safety_mother';
const CHILD_NAME = 'Regression Child', MOTHER_NAME = 'Regression Mother';

async function draft(page) {
  return page.evaluate(async () => (await import('/src/lib/draftStorage.ts')).loadDraftTree());
}
async function profile(page, name) {
  await page.locator('button.person-card').filter({ hasText: name }).dispatchEvent('click');
  await expect(page.locator('.person-panel.is-open input').first()).toHaveValue(name);
  // Let the panel's zero-delay readiness callback run; keep its 350 ms save blocked.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
}
async function setup(page) {
  const external = [], writes = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (/flushSync.*(lifecycle|rendering)/i.test(msg.text())) errors.push(msg.text()); });
  page.on('request', request => {
    if (request.method() !== 'GET' && request.method() !== 'HEAD') writes.push(request.url());
  });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === 'http://127.0.0.1:5186') return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.addInitScript(() => {
    const original = window.setTimeout.bind(window);
    // Reproduce an action BEFORE autosave deterministically, independent of CI speed.
    // Keep undo available while Playwright checks intermediate state.
    window.setTimeout = (handler, delay, ...args) => original(handler,
      delay === 350 || delay === 7000 ? 60000 : delay, ...args);
  });
  await page.goto('/');
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
  return { baseline, assertReadOnly() {
    expect(external).toEqual([]); expect(writes).toEqual([]); expect(errors).toEqual([]);
  } };
}

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
