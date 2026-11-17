import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { disableExternalPdfViewer, independentPdfPlugin } from './independent-pdf-build.mjs';
import { assertIndependentCode } from './static-release-profile.mjs';

const web = resolve('apps/web'), requireWeb = createRequire(join(web, 'package.json'));
const ts = requireWeb('typescript');
const entry = requireWeb.resolve('jspdf').replace(/jspdf\.node\.min\.js$/, 'jspdf.es.min.js');

test('the installed jsPDF external viewer is removed while ordinary PDF bytes and blobs still work', async t => {
  const original = await readFile(entry, 'utf8');
  assert.match(original, /cdnjs\.cloudflare\.com/);
  assert.throws(() => assertIndependentCode(original), /cloudflare_endpoint_in_bundle/);
  const transformed = disableExternalPdfViewer(original, ts);
  assertIndependentCode(transformed);
  assert(!transformed.includes('pdfObjectUrl'), 'the external script loader and its URL override are removed together');
  assert.match(transformed, /Copyright/, 'upstream license notice is preserved');

  // Import the actual transformed browser module with its installed dependencies.
  // It writes only a temporary synthetic PDF module, never a key or family archive.
  const cache = join(web, '.cache'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'independent-pdf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'jspdf.mjs'); await writeFile(path, transformed);
  const { jsPDF } = await import(pathToFileURL(path).href);
  const doc = new jsPDF(); doc.text('SEJIRE public synthetic PDF', 20, 20);
  const bytes = Buffer.from(doc.output('arraybuffer'));
  assert.match(bytes.toString('latin1'), /^%PDF-/);
  assert.match(bytes.toString('latin1'), /SEJIRE public synthetic PDF/);
  assert.match(bytes.toString('latin1'), /%%EOF$/);
  const blob = doc.output('blob');
  assert.equal(blob.type, 'application/pdf');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  assert.equal(typeof doc.save, 'function');
});

test('an unknown upstream viewer shape stops the build instead of keeping a CDN loader', () => {
  for (const source of [
    'export const noViewer = true;',
    'switch(x){case "pdfobjectnewwindow":break;case "pdfobjectnewwindow":break;}',
  ]) assert.throws(() => disableExternalPdfViewer(source, ts), /viewer_shape_changed/);
  assert.throws(() => disableExternalPdfViewer('switch (', ts), /pdf_source_invalid/);
  const plugin = independentPdfPlugin(ts);
  assert.equal(plugin.transform('untouched', '/src/app.js'), null);
  assert.throws(() => plugin.buildEnd(), /pdf_entry_missing/);
});
