import type {VerifiedVersion} from './types';
export function resolveHead(versions:VerifiedVersion[]):{head:VerifiedVersion;forks:VerifiedVersion[]}{
  if(!versions.length)throw Error('no_verified_versions');
  const parentIds=new Set(versions.map(version=>version.parentTxId).filter((id):id is string=>Boolean(id)));
  const tips=versions.filter(version=>!parentIds.has(version.txId));
  const ranked=(tips.length?tips:versions).sort((a,b)=>(b.blockHeight??-1)-(a.blockHeight??-1)||(b.blockTimestamp??-1)-(a.blockTimestamp??-1)||a.txId.localeCompare(b.txId));
  return {head:ranked[0],forks:ranked.slice(1)};
}
