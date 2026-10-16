import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const frontend=['apps/web/src/lib/fund/client.ts','apps/web/src/components/PromoFundedFlow.tsx','apps/web/src/components/FundAdmin.tsx'];
const files=[...frontend];
async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await walk(file);else if(/\.js$/.test(entry.name))files.push(file.slice(root.length+1));}}
await walk(join(root,'apps/web/dist/assets'));
const patterns=[['fund server secret name',/ARWEAVE_TREASURY_JWK|PROMO_CODE_SECRET/g],
  ['PEM private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['inline private RSA JWK',/"kty"\s*:\s*"RSA"[\s\S]{0,8000}"(?:d|p|q|dp|dq|qi)"\s*:\s*"[A-Za-z0-9_-]{16,}"/g],
  ['fixture recovery phrase',/(?:abandon\s+){11}about/g],
  ['mnemonic or seed value',/[\"'](?:mnemonic|seedPhrase|recoveryWords|recoveryPhrase)[\"']\s*:\s*[\"'][a-z]+(?:\s+[a-z]+){11,}[\"']/gi]];
let problems=0;
for(const name of files){const value=await readFile(join(root,name),'utf8');for(const [label,pattern] of patterns){pattern.lastIndex=0;if(pattern.test(value)){console.error(`FAIL ${label}: ${name}`);problems++;}}}
for(const name of frontend){const value=await readFile(join(root,name),'utf8');if(/\b(?:mnemonic|recoveryWords|privateKey|jwk|plaintextTree)\b/i.test(value)){console.error(`FAIL forbidden Fund payload field: ${name}`);problems++;}}
if(problems)process.exitCode=1;else console.log(`fund security scan: PASS (${files.length} frontend source and built JS files; no private RSA JWK/PEM, fund secret names or recovery payload fields)`);
