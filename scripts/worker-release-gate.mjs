/** Read-only release gate. Never deploys, signs, sends funds, or reads secrets beyond GH_TOKEN. */
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'azovskaya/sejire_arweave_solana';
export const BRANCH = 'feat/promo-funded-preservation';
export const WORKFLOW_PATH = '.github/workflows/checks.yml';

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

export function releaseRequest(env) {
  requireCondition(env.GITHUB_REPOSITORY === REPOSITORY, 'release_repository_mismatch');
  requireCondition(env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'release_manual_only');
  requireCondition(env.GITHUB_REF === `refs/heads/${BRANCH}`, 'release_branch_mismatch');
  requireCondition(env.RELEASE_CONFIRM === 'DEPLOY', 'release_confirmation_required');
  requireCondition(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''), 'release_invalid_sha');
  for (const name of ['RELEASE_CI_RUN_ID', 'RELEASE_CI_ATTEMPT']) {
    requireCondition(/^[1-9][0-9]*$/.test(env[name] ?? '') &&
      Number.isSafeInteger(Number(env[name])), 'release_invalid_run');
  }
  return { sha: env.GITHUB_SHA, runId: Number(env.RELEASE_CI_RUN_ID), attempt: Number(env.RELEASE_CI_ATTEMPT) };
}

export function validateReleaseEvidence(request, run, ref, jobs) {
  requireCondition(run?.id === request.runId, 'release_run_mismatch');
  requireCondition(run?.repository?.full_name === REPOSITORY &&
    run?.head_repository?.full_name === REPOSITORY, 'release_repository_mismatch');
  requireCondition(run.path === WORKFLOW_PATH && run.name === 'SEJIRE checks', 'release_workflow_mismatch');
  requireCondition(['push', 'workflow_dispatch'].includes(run.event), 'release_ci_event_mismatch');
  requireCondition(run.head_branch === BRANCH && run.head_sha === request.sha, 'release_ci_sha_mismatch');
  requireCondition(run.run_attempt === request.attempt, 'release_attempt_changed');
  requireCondition(run.status === 'completed' && run.conclusion === 'success', 'release_ci_not_successful');
  requireCondition(ref?.ref === `refs/heads/${BRANCH}` && ref?.object?.type === 'commit' &&
    ref.object.sha === request.sha, 'release_head_changed');
  requireCondition(Array.isArray(jobs) && jobs.length > 0, 'release_jobs_missing');
  const verify = jobs.filter(job => job.name === 'verify');
  requireCondition(verify.length === 1, 'release_verify_job_missing');
  for (const job of jobs) {
    requireCondition(job.run_id === request.runId && job.run_attempt === request.attempt &&
      job.head_sha === request.sha, 'release_job_mismatch');
    requireCondition(job.status === 'completed' && job.conclusion === 'success', 'release_job_not_successful');
  }
  requireCondition(Array.isArray(verify[0].steps) && verify[0].steps.length > 0, 'release_steps_missing');
  // Mandatory fresh production dependency audits also run in the deploy job.
  // The only skipped step permitted here is the failure-only artifact upload.
  for (const step of verify[0].steps) {
    if (step.name === 'Preserve checkout failure diagnostics' && step.status === 'completed' && step.conclusion === 'skipped') continue;
    requireCondition(step.status === 'completed' && step.conclusion === 'success', 'release_step_not_successful');
  }
  return { schema: 'sejire/worker-release-gate/v1', sourceCommit: request.sha,
    ciRunId: request.runId, ciAttempt: request.attempt, repository: REPOSITORY, branch: BRANCH };
}

export async function checkWorkerRelease(env, fetcher = fetch) {
  const request = releaseRequest(env);
  requireCondition(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'release_token_missing');
  async function read(path) {
    let response;
    try {
      response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      requireCondition(response.ok, 'release_evidence_unavailable');
      return await response.json();
    } catch { throw new Error('release_evidence_unavailable'); }
  }
  const run = await read(`actions/runs/${request.runId}`);
  const ref = await read(`git/ref/heads/${BRANCH}`);
  const jobs = [];
  let total;
  for (let page = 1; page <= 10; page += 1) {
    const result = await read(`actions/runs/${request.runId}/attempts/${request.attempt}/jobs?per_page=100&page=${page}`);
    requireCondition(Number.isSafeInteger(result.total_count) && result.total_count > 0 &&
      Array.isArray(result.jobs) && result.jobs.length <= 100, 'release_jobs_missing');
    total ??= result.total_count;
    requireCondition(result.total_count === total, 'release_jobs_changed');
    jobs.push(...result.jobs);
    if (jobs.length >= total) break;
    requireCondition(result.jobs.length > 0, 'release_jobs_incomplete');
  }
  requireCondition(jobs.length === total && new Set(jobs.map(job => job.id)).size === total, 'release_jobs_incomplete');
  return validateReleaseEvidence(request, run, ref, jobs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkWorkerRelease(process.env))); }
  catch (error) {
    // Do not print API response bodies, credentials, or request headers.
    console.error(error instanceof Error ? error.message : 'release_gate_failed');
    process.exitCode = 1;
  }
}
