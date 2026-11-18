/** Upload only the recovered CI release with existing Turbo credits. Never updates ArNS. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCEPTED_DIR, EVIDENCE_DIR, checkPermawebRelease, requireValue, verifyAcceptedRelease, verifyRelease } from './permaweb-release.mjs';
import { verifyPathManifest, verifyPublishedRelease } from './verify-arns-published.mjs';

export const TURBO_VERSION = '2.1.0';
export const UPLOAD_ORIGIN = 'https://upload.ardrive.io';
export const PAYMENT_ORIGIN = 'https://payment.ardrive.io';
const TX = /^[A-Za-z0-9_-]{43}$/;
const MAX_QUOTE_AGE_MS = 60000;
// RSA-4096 ANS-104 headers and the small, fixed tags below fit comfortably in this allowance.
export const ITEM_OVERHEAD_ALLOWANCE = 4096;
const TAGS = [{ name: 'App-Name', value: 'SEJIRE' }, { name: 'App-Feature', value: 'Static-Site' }];

export function turboServiceConfig() {
  // In SDK 2.1.0 `retries` is the total number of attempts. Every outer retry
  // signs again; RSA-PSS can produce a new item ID after an accepted upload's ACK is lost.
  return { uploadServiceConfig: { url: UPLOAD_ORIGIN, retryConfig: { retries: 1, retryDelay: () => 0, onRetry() {} } },
    paymentServiceConfig: { url: PAYMENT_ORIGIN }, token: 'arweave' };
}

export function winc(value) {
  requireValue(typeof value === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(value), 'permaweb_invalid_winc');
  return BigInt(value);
}

export function uploadPlan(release) {
  const placeholder = 'x'.repeat(43), paths = Object.fromEntries(release.files.map(file => [file.path, { id: placeholder }]));
  const manifest = { manifest: 'arweave/paths', version: '0.2.0', index: { path: 'index.html' }, paths, fallback: { id: placeholder } };
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
  return { schema: 'sejire/permaweb-upload-plan/v1', sourceCommit: release.manifest.sourceCommit, profile: release.manifest.profile,
    files: release.files, totalFileBytes: release.files.reduce((sum, file) => sum + file.bytes, 0), manifestBytes,
    quotedItemBytes: [...release.files.map(file => file.bytes + ITEM_OVERHEAD_ALLOWANCE), manifestBytes + ITEM_OVERHEAD_ALLOWANCE],
    sdk: `@ardrive/turbo-sdk@${TURBO_VERSION}`, uploadOrigin: UPLOAD_ORIGIN, paymentOrigin: PAYMENT_ORIGIN,
    funding: 'existing-own-balance', autoTopUp: false, arnsTargetChange: false };
}

export async function quoteUpload(client, plan, maximum, now = Date.now) {
  const limit = winc(maximum), values = await client.getUploadCosts({ bytes: plan.quotedItemBytes });
  requireValue(Array.isArray(values) && values.length === plan.quotedItemBytes.length, 'permaweb_invalid_quote');
  const cost = values.reduce((sum, value) => sum + winc(value.winc), 0n);
  return { schema: 'sejire/permaweb-upload-quote/v1', sourceCommit: plan.sourceCommit, quotedAt: now(),
    quotedWinc: cost.toString(), maxQuoteWinc: limit.toString(), withinBudget: cost <= limit,
    items: values.map((value, index) => ({ bytes: plan.quotedItemBytes[index], winc: value.winc })),
    pricing: 'one quote per item including manifest and conservative signing overhead',
    limitKind: 'preflight-quote-only', providerHardCap: false, autoTopUp: false };
}

export function checkFunding(quote, balance, now = Date.now()) {
  const cost = winc(quote.quotedWinc);
  requireValue(cost <= winc(quote.maxQuoteWinc), 'permaweb_quote_exceeds_budget');
  requireValue(now >= quote.quotedAt && now - quote.quotedAt <= MAX_QUOTE_AGE_MS, 'permaweb_quote_stale');
  // Do not count shared-credit approvals as an owner's upload budget.
  requireValue(winc(balance.winc) >= cost, 'permaweb_insufficient_existing_credits');
  return { availableOwnWinc: balance.winc, quotedWinc: quote.quotedWinc, maxQuoteWinc: quote.maxQuoteWinc };
}

export async function loadTurboSdk() {
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const entry = require.resolve('@ardrive/turbo-sdk/node');
  const metadata = JSON.parse(await readFile(join(dirname(entry), '../../../package.json'), 'utf8'));
  requireValue(metadata.name === '@ardrive/turbo-sdk' && metadata.version === TURBO_VERSION, 'permaweb_sdk_version_mismatch');
  const sdk = require('@ardrive/turbo-sdk/node');
  sdk.TurboFactory.setLogLevel('none');
  return sdk;
}

function receipt(value) {
  requireValue(value && TX.test(value.id) && TX.test(value.owner), 'permaweb_upload_receipt_invalid');
  winc(value.winc);
  requireValue(!value.cryptoFundResult && !value.createdApproval && !value.revokedApprovals, 'permaweb_unexpected_funding');
  return Object.fromEntries(['id', 'owner', 'winc', 'timestamp', 'signature', 'public', 'version', 'deadlineHeight', 'dataCaches', 'fastFinalityIndexes']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function requireFreshUploadEvidence(directory) {
  requireValue(!existsSync(join(directory, 'upload-result.json')), 'permaweb_already_uploaded_verify_instead');
  requireValue(!['upload-attempt.json', 'folder-index.jsonl', 'completed-files.jsonl'].some(name => existsSync(join(directory, name))),
    'permaweb_upload_attempt_requires_review');
}

export async function uploadAcceptedRelease({ client, sdk, release, quote, uploadAddress, evidenceDirectory = EVIDENCE_DIR, now = Date.now }) {
  requireValue(TX.test(uploadAddress ?? ''), 'permaweb_upload_address_invalid');
  requireFreshUploadEvidence(evidenceDirectory);
  checkFunding(quote, await client.getBalance(), now());
  await mkdir(evidenceDirectory, { recursive: true });
  // Claim this evidence directory before the SDK can sign or send anything.
  // A lost ACK or process interruption leaves an ambiguous attempt even when no
  // completed file was recorded. Review its evidence instead of signing again.
  const attempt = { schema: 'sejire/permaweb-upload-attempt/v1', sourceCommit: release.manifest.sourceCommit,
    releaseManifestSha256: release.manifestSha256, uploadAddress, startedAt: new Date(now()).toISOString(),
    quotedWinc: quote.quotedWinc, maxQuoteWinc: quote.maxQuoteWinc };
  try { await writeFile(join(evidenceDirectory, 'upload-attempt.json'), JSON.stringify(attempt, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) {
    if (error?.code === 'EEXIST') throw Error('permaweb_upload_attempt_requires_review');
    throw error;
  }
  await writeFile(join(evidenceDirectory, 'upload-plan.json'), JSON.stringify(uploadPlan(release), null, 2) + '\n');
  await writeFile(join(evidenceDirectory, 'upload-quote.json'), JSON.stringify(quote, null, 2) + '\n');
  // Index writes happen after every accepted file; the evidence artifact preserves partial progress.
  const folderIndex = sdk.createFileFolderIndex({ filePath: join(evidenceDirectory, 'folder-index.jsonl') });
  const controller = new AbortController();
  let result;
  try {
    result = await client.uploadFolder({ folderPath: release.root, maxConcurrentUploads: 1, throwOnFailure: true,
      signal: controller.signal, fundingMode: new sdk.ExistingBalanceFunding(), folderIndex,
      dataItemOpts: { tags: TAGS, paidBy: uploadAddress },
      manifestDataItemOpts: { tags: [...TAGS, { name: 'Source-Commit', value: release.manifest.sourceCommit }], paidBy: uploadAddress },
      manifestOptions: { indexFile: 'index.html', fallbackFile: '404.html', disableManifest: false },
      events: {
        // uploadFolder queues all files in advance. Abort before its next queued
        // uploadFile reaches signing; throwOnFailure alone does not stop that queue.
        onFileError: () => controller.abort(), onFolderError: () => controller.abort(),
        onFileComplete: ({ id, fileName }) => {
          requireValue(TX.test(id), 'permaweb_upload_receipt_invalid');
          appendFileSync(join(evidenceDirectory, 'completed-files.jsonl'), JSON.stringify({ id, path: fileName.slice(release.root.length + 1) }) + '\n');
        },
      },
    });
  } catch (error) { controller.abort(); throw error; }
  requireValue(!result.errors?.length && !result.cryptoFundResult, 'permaweb_partial_upload');
  verifyPathManifest(result.manifest, release.files);
  const fileReceipts = result.fileResponses.map(receipt), manifestReceipt = receipt(result.manifestResponse);
  const actualWinc = [...fileReceipts, manifestReceipt].reduce((sum, value) => sum + winc(value.winc), 0n).toString();
  const report = { schema: 'sejire/permaweb-upload-result/v1', sourceCommit: release.manifest.sourceCommit,
    manifestId: manifestReceipt.id, manifest: result.manifest, fileReceipts, manifestReceipt,
    quotedWinc: quote.quotedWinc, maxQuoteWinc: quote.maxQuoteWinc, actualWinc, providerHardCap: false,
    arnsTargetChanged: false, settlementVerified: false, uploadedAt: new Date(now()).toISOString() };
  // Persist before public verification. A delivery delay must never cause an automatic second upload.
  await writeFile(join(evidenceDirectory, 'upload-result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  requireValue(winc(actualWinc) <= winc(quote.maxQuoteWinc), 'permaweb_actual_charge_exceeded_quote_budget');
  return report;
}

async function main(env) {
  const mode = process.argv[2] ?? '--plan';
  requireValue(['--plan', '--quote', '--upload'].includes(mode), 'permaweb_invalid_mode');
  if (mode === '--upload') {
    requireValue(env.PERMAWEB_MODE === 'upload', 'permaweb_explicit_upload_mode_required');
    requireValue(env.GITHUB_RUN_ATTEMPT === '1', 'permaweb_upload_rerun_requires_prior_evidence');
    requireFreshUploadEvidence(EVIDENCE_DIR);
  }
  // Plans and public price quotes never read a private key or sign anything.
  const provenance = JSON.parse(await readFile(join(ACCEPTED_DIR, 'build-provenance.json'), 'utf8'));
  const release = mode === '--upload'
    ? await verifyAcceptedRelease(await checkPermawebRelease(env))
    : await verifyRelease(ACCEPTED_DIR, provenance.sourceCommit, { provenance: true });
  requireValue(provenance.releaseManifestSha256 === release.manifestSha256, 'permaweb_provenance_mismatch');
  const plan = uploadPlan(release);
  if (mode === '--plan') { console.log(JSON.stringify(plan, null, 2)); return; }
  requireValue(typeof env.PERMAWEB_MAX_QUOTE_WINC === 'string', 'permaweb_quote_budget_required');
  const sdk = await loadTurboSdk();
  const serviceConfig = turboServiceConfig();
  const publicClient = sdk.TurboFactory.unauthenticated(serviceConfig);
  const quote = await quoteUpload(publicClient, plan, env.PERMAWEB_MAX_QUOTE_WINC);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(join(EVIDENCE_DIR, 'upload-quote.json'), JSON.stringify(quote, null, 2) + '\n');
  if (mode === '--quote') {
    console.log(JSON.stringify(quote, null, 2));
    if (!quote.withinBudget && env.PERMAWEB_MODE !== 'prepare') process.exitCode = 1;
    return;
  }
  requireValue(quote.withinBudget, 'permaweb_quote_exceeds_budget');
  requireValue(!existsSync(join(EVIDENCE_DIR, 'upload-result.json')), 'permaweb_already_uploaded_verify_instead');
  requireValue(typeof env.PERMAWEB_JWK === 'string' && env.PERMAWEB_JWK.length > 0, 'permaweb_upload_key_missing');
  let privateKey;
  try { privateKey = JSON.parse(env.PERMAWEB_JWK); } catch { throw Error('permaweb_upload_key_invalid'); }
  requireValue(privateKey?.kty === 'RSA' && typeof privateKey.n === 'string' && typeof privateKey.d === 'string' &&
    privateKey.e === 'AQAB' && Buffer.from(privateKey.n, 'base64url').length === 512, 'permaweb_upload_key_invalid');
  const address = createHash('sha256').update(Buffer.from(privateKey.n, 'base64url')).digest('base64url');
  checkFunding(quote, await publicClient.getBalance(address));
  // Re-read bytes and fresh CI immediately before the only signing operation.
  await verifyAcceptedRelease(await checkPermawebRelease(env));
  const client = sdk.TurboFactory.authenticated({ ...serviceConfig, privateKey });
  const result = await uploadAcceptedRelease({ client, sdk, release, quote, uploadAddress: address });
  const base = `https://turbo-gateway.com/${result.manifestId}/`;
  const verification = await verifyPublishedRelease(release, base);
  await writeFile(join(EVIDENCE_DIR, 'public-result.json'), JSON.stringify(verification, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'UPLOADED_AND_PUBLIC_BYTES_VERIFIED', sourceCommit: plan.sourceCommit, manifestId: result.manifestId,
    base, actualWinc: result.actualWinc, arnsTargetChanged: false, settlementVerified: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch(error => {
    // SDK/HTTP errors can contain request configuration. Only our fixed diagnostic codes reach logs.
    console.error(error instanceof Error && /^(?:permaweb_|release_|independent_)[a-z_]+$/.test(error.message) ? error.message : 'permaweb_upload_failed_review_evidence_before_retry');
    process.exitCode = 1;
  });
}
