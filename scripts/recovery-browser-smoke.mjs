/**
 * Run against the Vite dev server using an independently installed Playwright:
 * NODE_PATH=/path/to/node_modules node scripts/recovery-browser-smoke.mjs
 * Optional: SEJIRE_TEST_URL, SEJIRE_BROWSER_CHANNEL (default: chrome).
 * All data is synthetic. External network calls are blocked; no wallets are used.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const base = process.env.SEJIRE_TEST_URL || "http://127.0.0.1:5173";
const origin = new URL(base).origin;
const browser = await chromium.launch({ channel: process.env.SEJIRE_BROWSER_CHANNEL || "chrome", headless: true });
const pageErrors = [];

async function freshPage(locale = "en", viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ locale, viewport, acceptDownloads: true });
  const external = [];
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(base);
  return { context, page, external };
}

async function restoreForm(page) {
  await page.getByRole("button", { name: "Open with 12 words", exact: true }).click();
  await page.getByRole("button", { name: "Open from file", exact: true }).click();
}

function filePayload(name, text) {
  return { name, mimeType: "application/json", buffer: Buffer.from(text) };
}

async function waitForWorkspace(page) {
  await page.getByRole("button", { name: "Save", exact: true }).waitFor();
}

try {
  const source = await freshPage();
  // Use application crypto/tree code to construct a two-tree fixture with history.
  const fixture = await source.page.evaluate(async () => {
    const { createTree, upsertPersonFields, commitDraft } = await import("/src/lib/treeEngine.ts");
    const { createMnemonic } = await import("/src/lib/crypto/bip39.ts");
    const { deriveKeysFromMnemonic } = await import("/src/lib/crypto/keys.ts");
    const { emptyVault, putTree } = await import("/src/lib/crypto/vault.ts");
    const { encryptJson } = await import("/src/lib/crypto/encrypt.ts");
    const words = createMnemonic();
    const wrongWords = createMnemonic();
    const keys = deriveKeysFromMnemonic(words);
    let tree = upsertPersonFields(createTree("Synthetic family A"), { id: "parent", name: "Synthetic Parent", parents: [] });
    tree = upsertPersonFields(tree, { id: "child", name: "Synthetic Child", parents: ["parent"] });
    tree = commitDraft(tree, "Synthetic family history");
    const second = createTree("Synthetic family B");
    const vault = putTree(putTree(emptyVault(keys.vaultId), second), tree);
    const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
    return { words, wrongWords, vault, envelope, activeId: tree.meta.id, secondId: second.meta.id };
  });

  await restoreForm(source.page);
  await source.page.locator('input[type="file"]').setInputFiles(filePayload("synthetic-archive.json", JSON.stringify(fixture.envelope)));
  await source.page.getByRole("button", { name: "Restore archive", exact: true }).waitFor();
  assert.equal(await source.page.getByRole("alert").count(), 0, "file-first does not ask the user to reselect it");
  await source.page.getByRole("textbox", { name: "12 SEJIRE recovery words" }).fill(fixture.words);
  await source.page.getByRole("button", { name: "Restore archive", exact: true }).click();
  await waitForWorkspace(source.page);
  assert.equal(source.external.length, 0, "file recovery must not request Arweave or another external service");

  await source.page.getByRole("button", { name: "Save", exact: true }).click();
  await source.page.getByRole("button", { name: "Save with Solana", exact: true }).click();
  const downloadPromise = source.page.waitForEvent("download");
  await source.page.getByRole("button", { name: "Download encrypted backup", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null, "the browser successfully downloaded the archive");
  const downloadedText = await readFile(await download.path(), "utf8");
  const downloaded = JSON.parse(downloadedText);
  assert.equal(downloaded.schema, "sejire/envelope/v1");
  assert.equal(downloaded.vault_id, fixture.envelope.vault_id);
  assert(!downloadedText.includes(fixture.words), "archive download never contains recovery words");
  assert(!downloadedText.includes("Synthetic Parent"), "archive download contains no plaintext family data");
  console.log("PASS: archive-first restore, Solana panel and real encrypted-file download");

  const target = await freshPage();
  assert.equal(await target.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("sejire.envelope.")).length), 0);
  await restoreForm(target.page);
  // Malformed files produce a translated error, without crashing or changing the draft.
  await target.page.locator('input[type="file"]').setInputFiles(filePayload("invalid.json", "null"));
  assert.match(await target.page.getByRole("alert").innerText(), /Need a sejire/);
  await target.page.locator('input[type="file"]').setInputFiles(filePayload(download.suggestedFilename(), downloadedText));
  await target.page.getByRole("button", { name: "Restore archive", exact: true }).waitFor();
  await target.page.getByRole("textbox", { name: "12 SEJIRE recovery words" }).fill(fixture.wrongWords);
  await target.page.getByRole("button", { name: "Restore archive", exact: true }).click();
  assert.match(await target.page.getByRole("alert").innerText(), /check the 12 words/);
  assert.equal(await target.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("sejire.envelope.")).length), 0);
  await target.page.getByRole("textbox", { name: "12 SEJIRE recovery words" }).fill(fixture.words);
  await target.page.getByRole("button", { name: "Restore archive", exact: true }).click();
  await waitForWorkspace(target.page);
  const recovered = await target.page.evaluate(async (words) => {
    const { deriveKeysFromMnemonic } = await import("/src/lib/crypto/keys.ts");
    const { openLocalVault } = await import("/src/lib/crypto/vault.ts");
    return openLocalVault(deriveKeysFromMnemonic(words));
  }, fixture.words);
  assert.equal(Object.keys(recovered.trees).length, 2);
  assert.deepEqual(recovered.trees[fixture.secondId], fixture.vault.trees[fixture.secondId]);
  assert.deepEqual(recovered.trees[fixture.activeId].draft.persons.child.parents, ["parent"]);
  assert.deepEqual(recovered.trees[fixture.activeId].commits, fixture.vault.trees[fixture.activeId].commits);
  assert.equal(target.external.length, 0, "retry and second-profile restoration made no external calls");
  console.log("PASS: fresh-profile recovery, wrong-word retry, malformed JSON, both trees and parent-child relation");

  // Seed-backup import must retain the selected archive; order must not matter.
  const seeded = await freshPage();
  await restoreForm(seeded.page);
  await seeded.page.locator('input[type="file"]').setInputFiles(filePayload("archive.json", downloadedText));
  await seeded.page.getByRole("button", { name: "Restore archive", exact: true }).waitFor();
  await seeded.page.locator('input[type="file"]').setInputFiles(filePayload("synthetic-words.json", JSON.stringify({ schema: "sejire/seed/v1", mnemonic: fixture.words })));
  await seeded.page.waitForFunction(() => document.querySelector("textarea")?.value.split(" ").length === 12);
  await seeded.page.getByRole("button", { name: "Restore archive", exact: true }).click();
  await waitForWorkspace(seeded.page);
  assert.equal(seeded.external.length, 0);
  console.log("PASS: recovery-words file after encrypted archive");

  const labels = {
    ru: { entry: "Открыть по 12 словам", file: "Открыть из файла", words: "12 слов восстановления SEJIRE", restore: "Восстановить архив" },
    kk: { entry: "12 сөзбен ашу", file: "Файлдан ашу", words: "SEJIRE қалпына келтірудің 12 сөзі", restore: "Архивті қалпына келтіру" },
  };
  for (const locale of ["ru", "kk"]) {
    const mobile = await freshPage(locale, { width: 390, height: 844 });
    const label = labels[locale];
    await mobile.page.getByRole("button", { name: label.entry, exact: true }).click();
    await mobile.page.getByRole("button", { name: label.file, exact: true }).click();
    await mobile.page.getByRole("textbox", { name: label.words }).fill(fixture.words);
    await mobile.page.locator('input[type="file"]').setInputFiles(filePayload("synthetic-archive-with-a-long-portable-filename.json", downloadedText));
    await mobile.page.getByRole("button", { name: label.restore, exact: true }).waitFor();
    assert(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${locale}: no horizontal overflow`);
    await mobile.context.close();
  }
  assert.deepEqual(pageErrors, [], "no uncaught browser errors");
  console.log("PASS: Russian/Kazakh restore forms at 390px; no uncaught browser errors");
} finally {
  await browser.close();
}
