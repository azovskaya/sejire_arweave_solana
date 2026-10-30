/** Standalone read-only recovery: words stay on stdin and never enter a URL. */
import {open} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {recoverVaultFromWords} from '../apps/web/src/lib/recovery/recover';

Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
try {
  const [output,...txHints]=process.argv.slice(2);
  if(!output||process.stdin.isTTY||txHints.some(id=>!/^[A-Za-z0-9_-]{43}$/.test(id)))throw Error('usage');
  let words='';for await(const chunk of process.stdin){words+=chunk.toString();if(words.length>2048)throw Error('input');}
  const result=await recoverVaultFromWords(words.trim(),{txHints});
  words='';
  if(!result.ok)throw Error('recovery_failed');
  const payload={schema:'sejire/independent-recovery/v1',headTxId:result.headTxId,
    historyComplete:!result.incomplete,verifiedVersions:result.versions.map(version=>({
      txId:version.txId,parentTxId:version.parentTxId,blockHeight:version.blockHeight,
      blockTimestamp:version.blockTimestamp,envelope:version.envelope,vault:version.vault}))};
  const file=await open(output,'wx',0o600);
  try{await file.writeFile(JSON.stringify(payload));}finally{await file.close();}
  console.log(`Recovered ${result.versions.length} verified version(s) locally. Output contains private family data; mode 600.`);
  if(result.incomplete)console.log('Some discovered versions could not be verified; history may be incomplete.');
}catch{
  console.error('Recovery failed. Use: node recover-network.mjs new-private-output.json [known-tx-id ...] < private-words-file');
  process.exitCode=1;
}
