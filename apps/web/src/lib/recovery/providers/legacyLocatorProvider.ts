import manifest from '../legacy-locators.v1.json';
import type {HeadDiscoveryProvider,RecoveryContext,DiscoveryResult,HeadCandidate} from '../types';
type Entry={vaultId:string;txIds:string[];reason:string;archiveBytes?:number;archiveSha256?:string};
export class LegacyLocatorProvider implements HeadDiscoveryProvider {
  id='legacy-locators';
  private readonly entries:Entry[];
  constructor(entries:Entry[]=manifest.entries){this.entries=entries;}
  async discover(ctx:RecoveryContext):Promise<DiscoveryResult>{
    const candidates:HeadCandidate[]=this.entries.filter(entry=>entry.vaultId===ctx.vaultId)
      .flatMap(entry=>entry.txIds.map(txId=>({txId,source:this.id,legacy:true,archiveBytes:entry.archiveBytes,archiveSha256:entry.archiveSha256})));
    return {status:'responded',candidates};
  }
}
