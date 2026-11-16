/** Pure evaluation of read-only CORS/readiness probes; never makes a request. */
export function assessArnsLiveChecks(checks, origin) {
  const failures = [], find = (path, method, target = origin) => checks.find(check => check.path === path && check.method === method && check.origin === target);
  const balance = find('/api/fund/balance', 'GET'), policy = find('/api/checkout/policy', 'GET');
  if (balance?.status !== 200 || balance.allowOrigin !== origin) failures.push('balance_cors_or_status');
  if (typeof balance?.body?.treasuryAddress !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(balance.body.treasuryAddress)) failures.push('balance_missing_treasury');
  if (policy?.status !== 200 || policy.allowOrigin !== origin || typeof policy.body?.ready !== 'boolean') failures.push('policy_response_or_cors');
  else if (!policy.body.ready) failures.push('policy_not_ready');
  for (const path of ['/api/fund/balance', '/api/checkout/policy', '/api/checkout/orders']) {
    const check = find(path, 'OPTIONS');
    if (check?.status !== 204 || check.allowOrigin !== origin) failures.push(`options_failed:${path}`);
  }
  const checkout = find('/api/checkout/orders', 'OPTIONS');
  const headers = new Set((checkout?.allowHeaders ?? '').toLowerCase().split(',').map(header => header.trim()));
  if (!['authorization', 'content-type', 'idempotency-key'].every(header => headers.has(header)) ||
      !(checkout?.allowMethods ?? '').split(',').map(method => method.trim()).includes('POST')) failures.push('checkout_preflight_headers');
  for (const method of ['GET', 'OPTIONS']) {
    const check = find('/api/fund/balance', method, 'https://evil.example');
    if (check?.status !== 403 || check.allowOrigin === 'https://evil.example') failures.push(`denied_origin_not_rejected:${method}`);
  }
  return failures;
}
