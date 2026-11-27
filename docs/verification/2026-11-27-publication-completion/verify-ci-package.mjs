/** Offline verification of public GitHub evidence and the original CI ZIP. No wallet or network. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateReleaseEvidence } from '../../../scripts/worker-release-gate.mjs';
import { releaseContract, acceptedArtifact, digest, extractAcceptedZip, verifyRelease, buildProvenance } from '../../../scripts/permaweb-release.mjs';
import { PORTABLE_FUNDED_PROFILE, verifyPortableFundedBuild } from '../../../scripts/portable-funded-profile.mjs';

const [metadataPath, zipPath, outputPath] = process.argv.slice(2);
assert(metadataPath && zipPath && outputPath, 'Usage: node verify-ci-package.mjs METADATA_DIR ORIGINAL_ZIP NEW_OUTPUT_DIR');
const metadata = resolve(metadataPath);
const readJson = async name => JSON.parse(await readFile(join(metadata, name), 'utf8'));
const [run, ref, jobsPage, artifactsPage] = await Promise.all(
  ['run.json', 'ref.json', 'jobs.json', 'artifacts.json'].map(readJson));
for (const [page, key] of [[jobsPage, 'jobs'], [artifactsPage, 'artifacts']]) {
  assert(Number.isSafeInteger(page.total_count) && page.total_count > 0 && page.total_count <= 1000);
  assert(Array.isArray(page[key]));
  assert.equal(page[key].length, page.total_count, 'Incomplete evidence pagination');
  assert.equal(new Set(page[key].map(row => row.id)).size, page.total_count, 'Duplicate evidence entries');
}
const request = { sha: 'ef0252025c32687dce018368ea94d74af2728c66', runId: 45984285862, attempt: 1, profile: PORTABLE_FUNDED_PROFILE };
const contract = releaseContract(request.profile);
const ci = validateReleaseEvidence(request, run, ref, jobsPage.jobs, { branch: contract.branch });
const verify = jobsPage.jobs.find(job => job.name === 'verify');
assert.equal(verify.id, 140455799472);
for (const name of [
  'Offline recovery format, standalone decoder and current-envelope compatibility',
  'Standalone recovery HTML with OS network isolation in Chromium, Firefox and WebKit (synthetic data)',
  'Read-only Arweave recovery gateway and CORS acceptance',
  'Web production dependency audit (blocking high and critical)',
  'Sponsor production dependency audit (blocking high and critical)',
]) assert(verify.steps.some(step => step.name === name && step.conclusion === 'success'), 'Missing required successful step: ' + name);

const artifact = acceptedArtifact(request, artifactsPage.artifacts, jobsPage.jobs);
const zip = await readFile(resolve(zipPath));
assert.equal(zip.length, artifact.size_in_bytes);
assert.equal(digest(zip), artifact.digest.slice(7));
extractAcceptedZip(zip, resolve(outputPath));
const release = await verifyRelease(resolve(outputPath), request.sha, { expectedProfile: request.profile });
const boundary = await verifyPortableFundedBuild(release.root, 'https://sejire-api.azovskaya.prod.page');
const provenance = buildProvenance({ request, artifact }, release);
const result = {
  schema: 'sejire/offline-ci-package-verification/v1',
  checkedAt: new Date().toISOString(),
  status: 'CI_PACKAGE_VERIFIED_NOT_PRODUCTION_AUTHORIZED',
  sourceCommit: request.sha, sourceTree: '1bf283fa8fd157348cf7bb4cf67e49c0f93e5cbb',
  ci, verifyJobId: verify.id, artifact, provenance, boundary,
  totalFiles: release.files.length,
  totalBytes: release.files.reduce((sum, file) => sum + file.bytes, 0),
  payloadFiles: release.manifest.fileCount, payloadBytes: release.manifest.totalBytes,
  releaseManifestSha256: release.manifestSha256, files: release.files,
  productionHostingVerified: false, legacyMigrationVerified: false,
  realWalletAcceptanceVerified: false, arnsTargetChanged: false, permanentUploadPerformed: false,
};
// Keep the recorded evidence immutable; a repeat verification writes only its new
// extracted output directory and emits its result on stdout.
console.log(JSON.stringify(result, null, 2));

