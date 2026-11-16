import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { preparePermaweb } from './prepare-permaweb.mjs';
import { REPOSITORY } from './worker-release-gate.mjs';
import { ARTIFACT_NAME, BRANCH, FUND_ORIGIN, acceptedArtifact, boundedBytes, buildProvenance, checkPermawebRelease,
  digest, extractAcceptedZip, permawebRequest, recoverPermawebRelease, verifyAcceptedRelease, verifyRelease } from './permaweb-release.mjs';
import { BOUNDARY_FILE, FUNDED_PROFILE, INDEPENDENT_PROFILE, INDEPENDENT_PROFILE_DOCUMENT,
  PROFILE_FILE, RECOVERY_FILES, finalizeIndependentBoundary, verifyIndependentBuild } from './static-release-profile.mjs';
import { checkFunding, loadTurboSdk, quoteUpload, turboServiceConfig, uploadAcceptedRelease, uploadPlan, winc } from './upload-permaweb.mjs';
import { publicBase, readPublicManifest, verifyPathManifest, verifyPublishedRelease } from './verify-arns-published.mjs';
import { assessArnsLiveChecks } from './arns-live-policy.mjs';

const sha = 'a'.repeat(40), id = 'A'.repeat(43);
const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: `refs/heads/${BRANCH}`,
  GITHUB_SHA: sha, PERMAWEB_MODE: 'prepare', PERMAWEB_CONFIRM: 'pack-ready', PERMAWEB_CI_RUN_ID: '42', PERMAWEB_CI_ATTEMPT: '1', GH_TOKEN: 'synthetic-github-test-token' };
const request = permawebRequest(env);
const run = { id: 42, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
  path: '.github/workflows/checks.yml', name: 'SEJIRE checks', event: 'push', head_branch: BRANCH, head_sha: sha,
  run_attempt: 1, status: 'completed', conclusion: 'success' };
const ref = { ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha } };
const jobs = [{ id: 99, run_id: 42, run_attempt: 1, head_sha: sha, name: 'verify', status: 'completed', conclusion: 'success',
  started_at: '2026-11-16T10:00:00Z', completed_at: '2026-11-16T10:20:00Z',
  steps: [{ name: 'all acceptance checks', status: 'completed', conclusion: 'success' },
    { name: 'Preserve checkout failure diagnostics', status: 'completed', conclusion: 'skipped' }] }];
const artifact = { id: 123, name: ARTIFACT_NAME, expired: false, workflow_run: { id: 42, head_sha: sha, head_branch: BRANCH },
  digest: 'sha256:' + 'b'.repeat(64), size_in_bytes: 1024, created_at: '2026-11-16T10:10:00Z' };
const clone = value => structuredClone(value);
const json = value => new Response(JSON.stringify(value), { status: 200 });
function apiFetch(overrides = {}, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/actions/runs/42')) return json(overrides.run ?? run);
    if (url.includes('/git/ref/heads/')) return json(overrides.ref ?? ref);
    if (url.includes('/attempts/1/jobs?')) return json({ total_count: (overrides.jobs ?? jobs).length, jobs: overrides.jobs ?? jobs });
    if (url.endsWith('/artifacts?per_page=100&page=1')) return json({ total_count: (overrides.artifacts ?? [artifact]).length, artifacts: overrides.artifacts ?? [artifact] });
    throw Error('unexpected synthetic request');
  };
}
async function fixture(t, profile = INDEPENDENT_PROFILE) {
  const root = await mkdtemp(join(tmpdir(), 'sejire-permaweb-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), output = join(root, 'release');
  await mkdir(join(source, 'assets'), { recursive: true });
  await writeFile(join(source, 'index.html'), '<!doctype html><script type="module" src="./assets/app.js"></script>');
  const code = profile === FUNDED_PROFILE ? `export const origin=${JSON.stringify(FUND_ORIGIN)};` : 'export const storage="arweave.N.1";';
  await writeFile(join(source, 'assets/app.js'), code);
  await writeFile(join(source, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(source, 'favicon.ico'), 'synthetic-icon');
  if (profile === FUNDED_PROFILE) {
    // Legacy source/profile is preserved, but cannot pass the new release gate.
    await writeFile(join(source, 'admin-lock.json'), await readFile('apps/web/public/admin-lock.json'));
  } else {
    await writeFile(join(source, PROFILE_FILE), JSON.stringify(INDEPENDENT_PROFILE_DOCUMENT));
    await writeFile(join(source, BOUNDARY_FILE), JSON.stringify({ schema: 'sejire/browser-boundary/v1', profile,
      chunks: [{ file: 'assets/app.js', sha256: digest(code), imports: [], dynamicImports: [],
        modules: ['apps/web/src/lib/directArweave/client.ts'] }] }));
    await mkdir(join(source, 'recovery'));
    for (const name of RECOVERY_FILES) await writeFile(join(source, 'recovery', name), 'Public synthetic offline recovery fixture\n');
  }
  await preparePermaweb(source, output, sha);
  const release = await verifyRelease(output, sha);
  return { root, source, output, release };
}
async function withProvenance(f) {
  const evidence = { request, artifact };
  await writeFile(join(f.output, 'build-provenance.json'), JSON.stringify(buildProvenance(evidence, f.release), null, 2) + '\n');
  return verifyAcceptedRelease(evidence, f.output);
}
function zipFrom(entries, symlinks = []) {
  const script = `import base64,io,json,stat,sys,zipfile
data=json.load(sys.stdin);buf=io.BytesIO()
with zipfile.ZipFile(buf,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,value in data['entries']:
  info=zipfile.ZipInfo(name)
  if name in data['symlinks']: info.external_attr=(stat.S_IFLNK|0o777)<<16
  z.writestr(info,base64.b64decode(value))
sys.stdout.buffer.write(buf.getvalue())`;
  return execFileSync('python3', ['-c', script], { input: JSON.stringify({ entries: entries.map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]), symlinks }) });
}

test('manual feature-branch request is mandatory; malformed release inputs fail closed', () => {
  assert.deepEqual(request, { sha, runId: 42, attempt: 1 });
  for (const changes of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/heads/feat/promo-funded-preservation' }, { PERMAWEB_CONFIRM: 'DEPLOY' },
    { PERMAWEB_MODE: 'automatic' }, { GITHUB_SHA: 'short' }, { PERMAWEB_CI_RUN_ID: '42x' }, { PERMAWEB_CI_ATTEMPT: '0' }, { GITHUB_REPOSITORY: 'attacker/repo' }]) {
    assert.throws(() => permawebRequest({ ...env, ...changes }), /permaweb_/);
  }
});

test('a fresh runner cannot repeat an upload when GitHub reruns an earlier dispatch', () => {
  assert.deepEqual(permawebRequest({ ...env, PERMAWEB_MODE: 'upload', GITHUB_RUN_ATTEMPT: '1' }), request);
  for (const attempt of [undefined, '0', '2', '3']) {
    assert.throws(() => permawebRequest({ ...env, PERMAWEB_MODE: 'upload', GITHUB_RUN_ATTEMPT: attempt }), /upload_rerun_requires_prior_evidence/);
  }
  assert.deepEqual(permawebRequest({ ...env, GITHUB_RUN_ATTEMPT: '2' }), request, 'read-only preparation can be rerun');
});

test('exact CI, attempt, all steps and current feature head are checked before artifact use', async () => {
  const calls = [], evidence = await checkPermawebRelease(env, apiFetch({}, calls));
  assert.equal(evidence.artifact.id, artifact.id);
  assert(calls.every(call => call.options.redirect === 'error' && call.options.headers.Authorization === `Bearer ${env.GH_TOKEN}`));
  const failedJobs = clone(jobs); failedJobs[0].steps[0].conclusion = 'failure';
  for (const overrides of [
    { run: { ...run, event: 'pull_request' } }, { run: { ...run, run_attempt: 2 } },
    { run: { ...run, conclusion: 'failure' } }, { ref: { ...ref, object: { type: 'commit', sha: 'c'.repeat(40) } } },
    { jobs: failedJobs }, { artifacts: [artifact, { ...artifact, id: 124 }] },
    { artifacts: [{ ...artifact, created_at: '2026-11-16T09:59:59Z' }] },
  ]) await assert.rejects(() => checkPermawebRelease(env, apiFetch(overrides)), /release_|permaweb_/);
  assert.throws(() => acceptedArtifact(request, [{ ...artifact, digest: null }], jobs), /artifact_mismatch/);
  assert.throws(() => acceptedArtifact(request, [{ ...artifact, expired: true }], jobs), /ambiguous_artifact/);
});

test('artifact ZIP is hashed, extracted without overwrite, and gets CI-bound public provenance', async t => {
  const f = await fixture(t), entries = await Promise.all(f.release.files.map(async file => [file.path, await readFile(join(f.output, file.path))]));
  const zip = zipFrom(entries), checked = { ...artifact, digest: 'sha256:' + digest(zip), size_in_bytes: zip.length };
  const calls = [], api = apiFetch({ artifacts: [checked] }, calls);
  const fetcher = async (url, options) => {
    if (url.endsWith('/artifacts/123/zip')) return new Response(null, { status: 302, headers: { location: 'https://storage.example/archive.zip' } });
    if (url === 'https://storage.example/archive.zip') { assert.equal(options.headers, undefined); return new Response(zip); }
    return api(url, options);
  };
  const directory = join(f.root, 'accepted');
  const recovered = await recoverPermawebRelease(env, { fetcher, directory, evidenceDirectory: join(f.root, 'evidence') });
  const provenance = JSON.parse(await readFile(join(directory, 'build-provenance.json'), 'utf8'));
  assert.equal(provenance.zipSha256, digest(zip)); assert.equal(provenance.sourceCommit, sha); assert.equal(provenance.attempt, 1);
  assert.equal(recovered.files.length, f.release.files.length + 1);
  assert.throws(() => extractAcceptedZip(zip, directory), /zip_rejected/);
  await writeFile(join(directory, 'assets/app.js'), 'changed after acceptance');
  await assert.rejects(() => verifyAcceptedRelease({ request, artifact: checked }, directory), /file_digest_mismatch/);
});

test('ZIP traversal, unlisted credentials, symlinks, duplicates and digest mismatch cannot publish', async t => {
  const f = await fixture(t);
  const cases = [zipFrom([['../outside.txt', 'x']]), zipFrom([['wallet.json', '{}']]),
    zipFrom([['assets/a.js', '../secret']], ['assets/a.js']), zipFrom([['index.html', 'one'], ['index.html', 'two']])];
  for (let index = 0; index < cases.length; index++) assert.throws(() => extractAcceptedZip(cases[index], join(f.root, `bad-${index}`)), /zip_rejected/);
  const api = apiFetch();
  const fetcher = async (url, options) => url.endsWith('/artifacts/123/zip')
    ? new Response(null, { status: 302, headers: { location: 'https://storage.example/bad.zip' } })
    : url === 'https://storage.example/bad.zip' ? new Response('not the accepted ZIP') : api(url, options);
  await assert.rejects(() => recoverPermawebRelease(env, { fetcher, directory: join(f.root, 'never'), evidenceDirectory: join(f.root, 'evidence') }), /zip_digest_mismatch/);
});

test('release verification binds all bytes, source SHA, fallback, file set and independent profile', async t => {
  const f = await fixture(t);
  await assert.rejects(() => verifyRelease(f.output, 'c'.repeat(40)), /manifest_mismatch/);
  await writeFile(join(f.output, 'unexpected.json'), '{}');
  await assert.rejects(() => verifyRelease(f.output, sha), /unlisted_release_file/);
  await rm(join(f.output, 'unexpected.json'));
  await symlink(join(f.source, 'index.html'), join(f.output, 'assets/link.js'));
  await assert.rejects(() => verifyRelease(f.output, sha), /unsafe_release/);
  await rm(join(f.output, 'assets/link.js'));
  const release = await withProvenance(f);
  assert.equal(release.manifest.sourceCommit, sha);
  const provenancePath = join(f.output, 'build-provenance.json');
  const altered = JSON.parse(await readFile(provenancePath, 'utf8')); altered.run = 43;
  await writeFile(provenancePath, JSON.stringify(altered));
  await assert.rejects(() => verifyAcceptedRelease({ request, artifact }, f.output), /provenance_mismatch/);
});

test('legacy funded profile remains verifiable but cannot become the independent release', async t => {
  const f = await fixture(t, FUNDED_PROFILE);
  assert.equal((await verifyRelease(f.output, sha)).manifest.profile, FUNDED_PROFILE);
  await assert.rejects(() => verifyRelease(f.output, sha, { expectedProfile: INDEPENDENT_PROFILE }), /release_profile_mismatch/);
  await assert.rejects(() => withProvenance(f), /release_profile_mismatch/);
});

test('a Worker endpoint or legacy lazy module cannot hide behind an independent manifest', async t => {
  const f = await fixture(t), auditPath = join(f.output, BOUNDARY_FILE);
  const report = JSON.parse(await readFile(auditPath, 'utf8'));
  report.chunks[0].modules.push('apps/web/src/lib/checkout/paidClient.ts');
  await writeFile(auditPath, JSON.stringify(report));
  await assert.rejects(() => verifyIndependentBuild(f.output), /backend_module_in_bundle/);
  report.chunks[0].modules.pop();
  const code = `export const executor=${JSON.stringify(FUND_ORIGIN)};`;
  report.chunks[0].sha256 = digest(code);
  await writeFile(auditPath, JSON.stringify(report));
  await writeFile(join(f.output, 'assets/app.js'), code);
  await assert.rejects(() => verifyIndependentBuild(f.output), /worker_endpoint_in_bundle/);
});

test('independent package requires offline recovery and exact evidence for every dynamic chunk', async t => {
  const f = await fixture(t), auditPath = join(f.output, BOUNDARY_FILE);
  await writeFile(join(f.output, 'assets/late.js'), 'export const late=true;');
  await assert.rejects(() => verifyIndependentBuild(f.output), /boundary_chunk_mismatch/);
  await rm(join(f.output, 'assets/late.js'));
  const report = JSON.parse(await readFile(auditPath, 'utf8'));
  report.chunks[0].dynamicImports.push('https://example.invalid/remote.js');
  await writeFile(auditPath, JSON.stringify(report));
  await assert.rejects(() => verifyIndependentBuild(f.output), /external_chunk_dependency/);
  report.chunks[0].dynamicImports = [];
  await writeFile(auditPath, JSON.stringify(report));
  await rm(join(f.output, 'recovery/recover.mjs'));
  await assert.rejects(() => verifyIndependentBuild(f.output), /required_file_missing/);
});

test('boundary hashes final emitted bytes after a late bundler transform while preserving the module map', async t => {
  const f = await fixture(t);
  const captured = JSON.parse(await readFile(join(f.output, BOUNDARY_FILE), 'utf8')).chunks;
  const finalCode = 'export const storage="arweave.N.1";/* final bundled output */';
  await writeFile(join(f.output, 'assets/app.js'), finalCode);
  await assert.rejects(() => verifyIndependentBuild(f.output), /boundary_digest_mismatch/);
  await finalizeIndependentBoundary(f.output, captured);
  const actual = JSON.parse(await readFile(join(f.output, BOUNDARY_FILE), 'utf8'));
  assert.equal(actual.chunks[0].sha256, digest(finalCode));
  assert.deepEqual(actual.chunks[0].modules, captured[0].modules);
  assert.equal((await verifyIndependentBuild(f.output)).profile, INDEPENDENT_PROFILE);
});

test('bounded reads reject overlong streams and dishonest Content-Length', async () => {
  await assert.rejects(() => boundedBytes(new Response('too long'), 3), /response_too_large/);
  await assert.rejects(() => boundedBytes(new Response('ok', { headers: { 'content-length': '99' } }), 3), /response_too_large/);
});

test('quote includes each file, signed-item overhead and fallback manifest; budget and own balance fail closed', async t => {
  const f = await fixture(t), plan = uploadPlan(await withProvenance(f));
  assert.equal(plan.quotedItemBytes.length, plan.files.length + 1);
  assert(plan.quotedItemBytes.every((bytes, index) => bytes > (plan.files[index]?.bytes ?? plan.manifestBytes)));
  const client = { getUploadCosts: async ({ bytes }) => bytes.map(() => ({ winc: '10' })) };
  const cost = String(plan.quotedItemBytes.length * 10), quote = await quoteUpload(client, plan, cost, () => 1000);
  assert.equal(quote.quotedWinc, cost); assert.equal(quote.providerHardCap, false); assert.equal(quote.autoTopUp, false);
  const overBudget = await quoteUpload(client, plan, String(Number(cost) - 1));
  assert.equal(overBudget.withinBudget, false); assert.equal(overBudget.quotedWinc, cost);
  assert.throws(() => checkFunding(overBudget, { winc: cost }, overBudget.quotedAt), /quote_exceeds_budget/);
  assert.deepEqual(checkFunding(quote, { winc: cost }, 1001), { availableOwnWinc: cost, quotedWinc: cost, maxQuoteWinc: cost });
  assert.throws(() => checkFunding(quote, { winc: '0', effectiveBalance: cost }, 1001), /insufficient_existing_credits/);
  assert.throws(() => checkFunding(quote, { winc: cost }, 61001), /quote_stale/);
  for (const value of ['1.5', '-1', '01', '', 100, '1e6']) assert.throws(() => winc(value), /invalid_winc/);
});

test('upload adapter pins existing-balance funding, own payer, one file at a time, and explicit fallback', async t => {
  const f = await fixture(t), release = await withProvenance(f), plan = uploadPlan(release);
  const quote = await quoteUpload({ getUploadCosts: async ({ bytes }) => bytes.map(() => ({ winc: '10' })) }, plan, '100000', () => 1000);
  class ExistingBalanceFunding {}
  const sdk = { ExistingBalanceFunding, createFileFolderIndex: () => ({ get() {}, set() {} }) };
  let uploads = 0;
  const paths = Object.fromEntries(release.files.map((file, index) => [file.path, { id: String.fromCharCode(65 + index).repeat(43) }]));
  const manifest = { manifest: 'arweave/paths', version: '0.2.0', index: { path: 'index.html' }, paths, fallback: { id: paths['404.html'].id } };
  const client = { getBalance: async () => ({ winc: '100000' }), uploadFolder: async options => {
    uploads++;
    assert(options.fundingMode instanceof ExistingBalanceFunding); assert.equal(options.maxConcurrentUploads, 1); assert.equal(options.throwOnFailure, true);
    assert.equal(options.dataItemOpts.paidBy, id); assert.equal(options.manifestDataItemOpts.paidBy, id);
    assert.deepEqual(options.manifestOptions, { indexFile: 'index.html', fallbackFile: '404.html', disableManifest: false });
    return { manifest, fileResponses: release.files.map(file => ({ id: paths[file.path].id, owner: id, winc: '1' })),
      manifestResponse: { id: 'Z'.repeat(43), owner: id, winc: '1' } };
  } };
  const evidenceDirectory = join(f.root, 'evidence');
  const result = await uploadAcceptedRelease({ client, sdk, release, quote, uploadAddress: id, evidenceDirectory, now: () => 1001 });
  assert.equal(result.arnsTargetChanged, false); assert.equal(result.settlementVerified, false); assert.equal(uploads, 1);
  await assert.rejects(() => uploadAcceptedRelease({ client, sdk, release, quote, uploadAddress: id, evidenceDirectory, now: () => 1001 }), /already_uploaded_verify_instead/);
  assert.equal(uploads, 1);
  await assert.rejects(() => uploadAcceptedRelease({ client: { ...client, getBalance: async () => ({ winc: '0' }) }, sdk,
    release, quote, uploadAddress: id, evidenceDirectory: join(f.root, 'insufficient'), now: () => 1001 }), /insufficient_existing_credits/);
  assert.equal(uploads, 1);
});

test('the installed pinned Turbo SDK actually constructs a v0.2 manifest with 404 fallback (mocked transport)', async t => {
  const f = await fixture(t), sdk = await loadTurboSdk();
  const service = new sdk.TurboAuthenticatedUploadService({ token: 'arweave', signer: {}, paymentService: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  // Exercise the actual folder implementation while preventing signatures and all transport.
  let calls = 0;
  service.uploadFile = async params => {
    calls++;
    const chunks = []; for await (const chunk of params.fileStreamFactory()) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, params.fileSizeFactory());
    return { id: Buffer.from(digest(bytes), 'hex').toString('base64url'), owner: id, winc: '0' };
  };
  const result = await service.uploadFolder({ folderPath: f.output, fundingMode: new sdk.ExistingBalanceFunding(),
    manifestOptions: { indexFile: 'index.html', fallbackFile: '404.html' }, maxConcurrentUploads: 1, throwOnFailure: true });
  verifyPathManifest(result.manifest, f.release.files);
  assert.equal(calls, f.release.files.length + 1);
  assert.equal(result.cryptoFundResult, undefined);
});

test('a lost upload ACK does not cause the pinned SDK to sign a second randomized item', async () => {
  const sdk = await loadTurboSdk(), logger = { debug() {}, info() {}, warn() {}, error() {} };
  // Ephemeral synthetic RSA key, never written or printed. All transport is replaced.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096, publicExponent: 0x10001 });
  const signer = new sdk.TurboNodeSigner({ signer: new sdk.ArweaveSigner(privateKey.export({ format: 'jwk' })), token: 'arweave', logger });
  const config = turboServiceConfig();
  const service = new sdk.TurboAuthenticatedUploadService({ ...config.uploadServiceConfig, token: config.token,
    signer, paymentService: {}, logger });
  const itemIds = [];
  service.uploadSignedDataItem = async ({ dataItemStreamFactory }) => {
    const chunks = []; for await (const chunk of dataItemStreamFactory()) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    itemIds.push(createHash('sha256').update(body.subarray(2, 514)).digest('base64url'));
    throw Error('synthetic lost ACK');
  };
  const payload = Buffer.from('synthetic static-site item');
  await assert.rejects(() => service.uploadFile({ fileStreamFactory: () => Readable.from(payload), fileSizeFactory: () => payload.length,
    fundingMode: new sdk.ExistingBalanceFunding(), dataItemOpts: { tags: [{ name: 'App-Name', value: 'SEJIRE' }] } }), /synthetic lost ACK/);
  assert.equal(itemIds.length, 1, 'the SDK must not sign/send a second item after an ambiguous acceptance');
});

test('the real SDK folder queue stops before signing later files after the first failed upload', async t => {
  const f = await fixture(t), sdk = await loadTurboSdk(), release = await withProvenance(f);
  const quote = await quoteUpload({ getUploadCosts: async ({ bytes }) => bytes.map(() => ({ winc: '1' })) }, uploadPlan(release), '100000', () => 1000);
  let signatures = 0, sends = 0;
  const signer = { signDataItem: async () => {
    signatures++;
    return { dataItemStreamFactory: () => Readable.from(Buffer.from('synthetic')), dataItemSizeFactory: () => 9 };
  } };
  const config = turboServiceConfig();
  const service = new sdk.TurboAuthenticatedUploadService({ ...config.uploadServiceConfig, token: config.token, signer, paymentService: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  service.uploadSignedDataItem = async () => { sends++; throw Error('synthetic first-file failure'); };
  const client = { getBalance: async () => ({ winc: '100000' }), uploadFolder: service.uploadFolder.bind(service) };
  await assert.rejects(() => uploadAcceptedRelease({ client, sdk, release, quote, uploadAddress: id,
    evidenceDirectory: join(f.root, 'failed-evidence'), now: () => 1001 }), /synthetic first-file failure/);
  // Allow the SDK's already queued promises to observe the abort, without network or a sleep.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signatures, 1); assert.equal(sends, 1);
});

test('public verification checks every byte and real fallback, rejects wrong bodies, HTTP errors and off-origin redirects', async t => {
  const f = await fixture(t), release = await withProvenance(f), base = `https://turbo-gateway.com/${id}/`;
  const fetcher = async url => {
    const path = url.slice(base.length);
    return new Response(await readFile(join(f.output, path === '__sejire_fallback_probe__' ? '404.html' : path)));
  };
  const report = await verifyPublishedRelease(release, base, { fetcher });
  assert.equal(report.status, 'PASS'); assert.equal(report.files.length, release.files.length); assert.equal(report.fallbackVerified, true);
  await assert.rejects(() => verifyPublishedRelease(release, base, { fetcher: async () => new Response('wrong') }), /digest_mismatch/);
  await assert.rejects(() => verifyPublishedRelease(release, base, { fetcher: async () => new Response(null, { status: 404 }) }), /public_http_failed/);
  await assert.rejects(() => verifyPublishedRelease(release, base, { fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://other.example/' } }) }), /public_redirect/);
  for (const url of ['http://sejire.ar.io/', 'https://sejire.ar.io/private/', 'https://user@sejire.ar.io/', 'https://other.example/']) assert.throws(() => publicBase(url), /public_base_invalid/);
});

test('plan mode cannot read an upload key and produces only public metadata', async t => {
  const f = await fixture(t), release = await withProvenance(f);
  const local = join(f.root, '.cache'); await mkdir(local);
  await cp(release.root, join(local, 'permaweb-accepted'), { recursive: true });
  const output = execFileSync(process.execPath, [resolve('scripts/upload-permaweb.mjs'), '--plan'], {
    cwd: f.root, env: { ...process.env, PERMAWEB_JWK: 'must-never-be-read' }, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(JSON.parse(output).sourceCommit, sha);
  assert(!output.includes('must-never-be-read'));
});

test('owner browser-upload verification fetches only a bounded public raw path manifest', async () => {
  const value = { manifest: 'arweave/paths', version: '0.2.0' };
  assert.deepEqual(await readPublicManifest(id, async (url, options) => {
    assert.equal(url, `https://turbo-gateway.com/raw/${id}`);
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers, undefined);
    return new Response(JSON.stringify(value));
  }), value);
  await assert.rejects(() => readPublicManifest('../private', () => { throw Error('must not fetch'); }), /invalid_manifest_id/);
  await assert.rejects(() => readPublicManifest(id, async () => new Response('<html>not a manifest</html>')), /path_manifest_invalid/);
});

test('ArNS readiness never passes a 503/disabled policy or a broken paid authorization preflight', () => {
  const origin = 'https://sejire.ar.io';
  const checks = [
    { path: '/api/fund/balance', method: 'GET', origin, status: 200, allowOrigin: origin, body: { treasuryAddress: id } },
    { path: '/api/checkout/policy', method: 'GET', origin, status: 200, allowOrigin: origin, body: { ready: true } },
    ...['/api/fund/balance', '/api/checkout/policy', '/api/checkout/orders'].map(path => ({ path, method: 'OPTIONS', origin,
      status: 204, allowOrigin: origin, allowMethods: 'GET, POST, OPTIONS', allowHeaders: 'Authorization, Content-Type, Idempotency-Key' })),
    ...['GET', 'OPTIONS'].map(method => ({ path: '/api/fund/balance', method, origin: 'https://evil.example', status: 403, allowOrigin: null })),
  ];
  assert.deepEqual(assessArnsLiveChecks(checks, origin), []);
  const unavailable = clone(checks); unavailable[1].status = 503;
  assert(assessArnsLiveChecks(unavailable, origin).includes('policy_response_or_cors'));
  const disabled = clone(checks); disabled[1].body.ready = false;
  assert(assessArnsLiveChecks(disabled, origin).includes('policy_not_ready'));
  const missingAuth = clone(checks); missingAuth[4].allowHeaders = 'Content-Type';
  assert(assessArnsLiveChecks(missingAuth, origin).includes('checkout_preflight_headers'));
  const reflected = clone(checks); reflected[5].status = 200; reflected[5].allowOrigin = 'https://evil.example';
  assert(assessArnsLiveChecks(reflected, origin).includes('denied_origin_not_rejected:GET'));
});
