#!/usr/bin/env node
import { verifyIndependentBuild } from './static-release-profile.mjs';

try {
  console.log(JSON.stringify({ status: 'PASS', ...await verifyIndependentBuild(process.argv[2] ?? 'apps/web/dist') }, null, 2));
} catch (error) {
  console.error(error instanceof Error && /^independent_/.test(error.message) ? error.message : 'independent_build_verification_failed');
  process.exitCode = 1;
}
