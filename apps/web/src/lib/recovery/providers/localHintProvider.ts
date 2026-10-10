import type {HeadDiscoveryProvider,RecoveryContext,DiscoveryResult} from '../types';
/** Optional TX IDs supplied by a receipt, deep link, or local version list. */
export class LocalHintProvider implements HeadDiscoveryProvider {
  id='local-hints';
  private readonly txIds:string[];
  constructor(txIds:string[]){this.txIds=txIds;}
  async discover(_ctx:RecoveryContext):Promise<DiscoveryResult>{
    return {status:'responded',candidates:this.txIds.filter(id=>/^[A-Za-z0-9_-]{43}$/.test(id)).map(txId=>({txId,source:this.id}))};
  }
}
