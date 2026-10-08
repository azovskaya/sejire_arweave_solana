import type {HeadDiscoveryProvider,RecoveryContext,HeadCandidate,SafeRecoveryDiagnostics,GatewayPool} from './types';
import {GraphqlVaultProvider} from './providers/graphqlVaultProvider';
import {LegacyLocatorProvider} from './providers/legacyLocatorProvider';
import {LocalHintProvider} from './providers/localHintProvider';

const PRIMARY=['https://arweave.net/graphql','https://arweave-search.goldsky.com/graphql','https://turbo-gateway.com/graphql'];
export async function discoverCandidates(ctx:RecoveryContext,pool:GatewayPool,diagnostics:SafeRecoveryDiagnostics,hints:string[]=[],providers?:HeadDiscoveryProvider[]):Promise<{candidates:HeadCandidate[];responded:boolean}>{
  const fixture=import.meta.env.VITE_RECOVERY_TEST==='1'&&typeof window!=='undefined'
    ?(window as Window & {__SEJIRE_RECOVERY_TEST_LOCATORS__?:ConstructorParameters<typeof LegacyLocatorProvider>[0]}).__SEJIRE_RECOVERY_TEST_LOCATORS__
    :undefined;
  const primary=providers??[...PRIMARY.map(url=>new GraphqlVaultProvider(url)),new LegacyLocatorProvider(fixture),new LocalHintProvider(hints)];
  const dynamic=providers?[]:(await pool.candidates(ctx)).slice(0,6).map(target=>new GraphqlVaultProvider(`${target.url}/graphql`));
  const all=[...primary,...dynamic.filter(provider=>!primary.some(old=>old.id===provider.id))];
  const results=await Promise.allSettled(all.map(async provider=>({provider,result:await provider.discover(ctx)})));
  const found=new Map<string,HeadCandidate>();let responded=false;
  for(let i=0;i<results.length;i++){
    const outcome=results[i];const result=outcome.status==='fulfilled'?outcome.value.result:{status:'unavailable' as const,candidates:[]};
    diagnostics.providers.push({id:all[i].id,status:result.status,count:result.candidates.length});
    if(result.status==='responded'&&all[i] instanceof GraphqlVaultProvider)responded=true;
    for(const candidate of result.candidates){
      if(!/^[A-Za-z0-9_-]{43}$/.test(candidate.txId))continue;
      const previous=found.get(candidate.txId);
      found.set(candidate.txId,previous?{...previous,...candidate,legacy:previous.legacy||candidate.legacy,archiveBytes:previous.archiveBytes??candidate.archiveBytes,archiveSha256:previous.archiveSha256??candidate.archiveSha256,source:`${previous.source},${candidate.source}`} : candidate);
    }
  }
  diagnostics.candidateCount=found.size;
  return {candidates:[...found.values()].slice(0,300),responded};
}
