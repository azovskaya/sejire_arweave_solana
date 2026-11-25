import { verifyPortableFundedBuild } from './portable-funded-profile.mjs';
console.log(JSON.stringify({ status: 'PASS', ...await verifyPortableFundedBuild(process.argv[2] ?? 'apps/web/dist', process.env.SEJIRE_FUNDED_API_ORIGIN) }, null, 2));
