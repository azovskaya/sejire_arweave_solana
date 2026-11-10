import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { releaseRequest, validateReleaseEvidence, checkWorkerRelease, REPOSITORY, BRANCH, WORKFLOW_PATH } from './worker-release-gate.mjs';

const sha = 'a'.repeat(40);
function fixtures() {
  const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: `refs/heads/${BRANCH}`, GITHUB_SHA: sha, RELEASE_CONFIRM: 'DEPLOY',
    RELEASE_CI_RUN_ID: '42', RELEASE_CI_ATTEMPT: '2', GH_TOKEN: 'synthetic-no-network' };
  const run = { id: 42, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
    path: WORKFLOW_PATH, name: 'SEJIRE checks', event: 'push', head_branch: BRANCH, head_sha: sha,
    status: 'completed', conclusion: 'success', run_attempt: 2 };
  const ref = { ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha } };
  const jobs = [{ id: 7, name: 'verify', run_id: 42, run_attempt: 2, head_sha: sha,
    status: 'completed', conclusion: 'success', steps: [
      { name: 'Run npm test', status: 'completed', conclusion: 'success' },
      { name: 'Preserve checkout failure diagnostics', status: 'completed', conclusion: 'skipped' },
    ] }];
  return { env, run, ref, jobs };
}
function validate(f) { return validateReleaseEvidence(releaseRequest(f.env), f.run, f.ref, f.jobs); }

test('exact production SHA, completed CI and deliberate confirmation are accepted', () => {
  const f = fixtures();
  assert.deepEqual(validate(f), { schema: 'sejire/worker-release-gate/v1', sourceCommit: sha,
    ciRunId: 42, ciAttempt: 2, repository: REPOSITORY, branch: BRANCH });
});
const invalidEnvs = [
  ['push cannot deploy', 'GITHUB_EVENT_NAME', 'push'],
  ['PR cannot deploy', 'GITHUB_EVENT_NAME', 'pull_request'],
  ['other repository', 'GITHUB_REPOSITORY', 'somewhere/else'],
  ['main branch', 'GITHUB_REF', 'refs/heads/main'],
  ['test branch', 'GITHUB_REF', 'refs/heads/fix/example'],
  ['tag', 'GITHUB_REF', 'refs/tags/v1'],
  ['missing confirmation', 'RELEASE_CONFIRM', 'NO'],
  ['partial SHA', 'GITHUB_SHA', 'aaaaaaa'],
  ['missing SHA', 'GITHUB_SHA', ''],
  ['non numeric run', 'RELEASE_CI_RUN_ID', '42; deploy'],
  ['non positive run', 'RELEASE_CI_RUN_ID', '0'],
  ['unsafe run number', 'RELEASE_CI_RUN_ID', '9007199254740992'],
  ['non positive attempt', 'RELEASE_CI_ATTEMPT', '0'],
];
for (const [name, key, value] of invalidEnvs) test(name, () => {
  const f = fixtures(); f.env[key] = value;
  assert.throws(() => validate(f));
});
const invalidEvidence = [
  ['different run id', f => { f.run.id = 43; }],
  ['run from another repository', f => { f.run.repository.full_name = 'other/repo'; }],
  ['fork run', f => { f.run.head_repository.full_name = 'fork/repo'; }],
  ['wrong workflow', f => { f.run.path = '.github/workflows/preview.yml'; }],
  ['wrong workflow name', f => { f.run.name = 'preview'; }],
  ['PR merge evidence', f => { f.run.event = 'pull_request'; }],
  ['untrusted event', f => { f.run.event = 'workflow_run'; }],
  ['other source branch', f => { f.run.head_branch = 'main'; }],
  ['older successful SHA', f => { f.run.head_sha = 'b'.repeat(40); }],
  ['CI still running', f => { f.run.status = 'in_progress'; }],
  ['CI cancelled', f => { f.run.conclusion = 'cancelled'; }],
  ['CI failed', f => { f.run.conclusion = 'failure'; }],
  ['rerun changed attempt', f => { f.run.run_attempt = 3; }],
  ['production head moved', f => { f.ref.object.sha = 'b'.repeat(40); }],
  ['wrong branch ref', f => { f.ref.ref = 'refs/heads/main'; }],
  ['missing jobs', f => { f.jobs = []; }],
  ['missing verify job', f => { f.jobs[0].name = 'other'; }],
  ['duplicate verify job', f => { f.jobs.push({ ...f.jobs[0], id: 8 }); }],
  ['wrong job SHA', f => { f.jobs[0].head_sha = 'b'.repeat(40); }],
  ['wrong job run', f => { f.jobs[0].run_id = 99; }],
  ['wrong job attempt', f => { f.jobs[0].run_attempt = 1; }],
  ['verify skipped', f => { f.jobs[0].conclusion = 'skipped'; }],
  ['verify still running', f => { f.jobs[0].status = 'in_progress'; }],
  ['missing step evidence', f => { f.jobs[0].steps = []; }],
  ['skipped required step', f => { f.jobs[0].steps[0].conclusion = 'skipped'; }],
  ['failed nonblocking step', f => { f.jobs[0].steps[0].conclusion = 'failure'; }],
];
for (const [name, mutate] of invalidEvidence) test(name, () => {
  const f = fixtures(); mutate(f); assert.throws(() => validate(f));
});

test('successful workflow_dispatch CI is accepted', () => {
  const f = fixtures(); f.run.event = 'workflow_dispatch'; assert.equal(validate(f).sourceCommit, sha);
});
test('network adapter reads only fixed GitHub GET evidence and binds run attempt', async () => {
  const f = fixtures(), paths = [];
  const result = await checkWorkerRelease(f.env, async (url, options) => {
    assert.equal(options.method ?? 'GET', 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-no-network');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    paths.push(url);
    const body = url.endsWith('/actions/runs/42') ? f.run : url.includes('/git/ref/') ? f.ref :
      { total_count: 1, jobs: f.jobs };
    return { ok: true, json: async () => body };
  });
  assert.equal(result.sourceCommit, sha);
  assert.equal(paths.length, 3);
  assert.ok(paths.every(url => url.startsWith(`https://api.github.com/repos/${REPOSITORY}/`)));
  assert.match(paths[2], /\/attempts\/2\/jobs\?per_page=100&page=1$/);
});
test('missing token and invalid request make zero network requests', async () => {
  const f = fixtures(); let calls = 0;
  const fetcher = async () => { calls++; throw Error('unexpected'); };
  delete f.env.GH_TOKEN; await assert.rejects(checkWorkerRelease(f.env, fetcher));
  f.env = fixtures().env; f.env.GITHUB_EVENT_NAME = 'push';
  await assert.rejects(checkWorkerRelease(f.env, fetcher)); assert.equal(calls, 0);
});
for (const status of [401, 403, 404, 429, 500]) test(`HTTP ${status} fails closed without body leak`, async () => {
  const f = fixtures();
  await assert.rejects(checkWorkerRelease(f.env, async () => ({ ok: false, status,
    json: async () => { throw Error('must not read error body'); } })), /^Error: release_evidence_unavailable$/);
});
test('transport failure does not expose its error details', async () => {
  await assert.rejects(checkWorkerRelease(fixtures().env, async () => { throw Error('private upstream details'); }),
    /^Error: release_evidence_unavailable$/);
});
test('malformed JSON fails closed', async () => {
  await assert.rejects(checkWorkerRelease(fixtures().env, async () => ({ ok: true, json: async () => { throw Error('bad'); } })),
    /^Error: release_evidence_unavailable$/);
});
test('incomplete job pagination is rejected', async () => {
  const f = fixtures();
  await assert.rejects(checkWorkerRelease(f.env, async url => ({ ok: true,
    json: async () => url.endsWith('/actions/runs/42') ? f.run : url.includes('/git/ref/') ? f.ref :
      { total_count: 2, jobs: url.endsWith('page=1') ? f.jobs : [] } })), /release_jobs_incomplete/);
});
test('duplicate job pages are rejected', async () => {
  const f = fixtures();
  await assert.rejects(checkWorkerRelease(f.env, async url => ({ ok: true,
    json: async () => url.endsWith('/actions/runs/42') ? f.run : url.includes('/git/ref/') ? f.ref :
      { total_count: 2, jobs: f.jobs } })), /release_jobs_incomplete/);
});
test('workflow keeps deployment manual, rechecks gate, and audits without continue-on-error', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy-promo-fund-worker.yml', import.meta.url), 'utf8');
  const triggers = workflow.split('\npermissions:')[0];
  assert.match(triggers, /\n  workflow_dispatch:/);
  assert.doesNotMatch(triggers, /\n  (push|pull_request|workflow_run|schedule):/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.equal((workflow.match(/run: node scripts\/worker-release-gate\.mjs/g) ?? []).length, 2);
  assert.match(workflow, /npm audit --prefix apps\/web --omit=dev --audit-level=high/);
  assert.match(workflow, /npm audit --prefix apps\/sponsor --omit=dev --audit-level=high/);
  assert.doesNotMatch(workflow, /continue-on-error|\|\| true/);
  assert.ok(workflow.lastIndexOf('run: node scripts/worker-release-gate.mjs') < workflow.indexOf('name: Deploy sejire-sponsor'));
  const checks = await readFile(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  assert.match(checks, /node --test scripts\/worker-release-gate\.test\.mjs/);
});
