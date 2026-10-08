import type {GatewayPool,GatewayTarget,RecoveryContext} from './types';

const EMERGENCY=['https://arweave.net','https://ar-io.net','https://g8way.io','https://turbo-gateway.com'];
const PEER_SEEDS=['https://turbo-gateway.com','https://ar-io.net'];
const health=new Map<string,{success:number;failure:number;latency:number}>();
function safeUrl(value:string):string|null {
  try {const url=new URL(value);const host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||url.port && url.port!=='443'||!host.includes('.')||
      host==='localhost'||host.endsWith('.local')||host.endsWith('.internal')||/^\d+\.\d+\.\d+\.\d+$/.test(host)||host.startsWith('['))return null;
    return url.origin;}
  catch{return null;}
}
export async function timedFetch(fetcher:typeof fetch,url:string,init:RequestInit={},timeout=4500,signal?:AbortSignal):Promise<Response>{
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout);
  const abort=()=>ctrl.abort();signal?.addEventListener('abort',abort,{once:true});
  try{return await fetcher(url,{...init,signal:ctrl.signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'follow'});}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export class WayfinderGatewayPool implements GatewayPool {
  private dynamic:string[]=[];
  private discovered=false;
  private readonly preferred:string[];
  constructor(preferred:string[]=[]){this.preferred=preferred;}
  async candidates(ctx:RecoveryContext):Promise<GatewayTarget[]>{
    // Thin adapter for Wayfinder TrustedPeersGatewaysProvider. A peer list is a hint,
    // never a trust root. Limit peers and keep independent emergency gateways.
    if(!this.discovered){
      const peers=await Promise.allSettled(PEER_SEEDS.map(async base=>{
        const response=await timedFetch(ctx.fetcher,`${base}/ar-io/peers`,{},3500,ctx.signal);
        if(!response.ok)throw Error('peers_unavailable');
        const body=await response.json() as {gateways?:Record<string,{url?:string}>};
        return Object.values(body.gateways??{}).map(peer=>safeUrl(peer.url??'')).filter((url):url is string=>url!==null).slice(0,15);
      }));
      this.dynamic=peers.flatMap(item=>item.status==='fulfilled'?item.value:[]);
      this.discovered=true;
    }
    const ranked=[...new Set([...this.preferred,...health.keys(),...this.dynamic,...EMERGENCY].map(safeUrl).filter((url):url is string=>url!==null))];
    ranked.sort((a,b)=>{
      const ah=health.get(a),bh=health.get(b);
      return ((bh?.success??0)*4-(bh?.failure??0)-(bh?.latency??5000)/10000)-((ah?.success??0)*4-(ah?.failure??0)-(ah?.latency??5000)/10000);
    });
    // Reserve emergency slots even if a peer source returns many entries.
    return [...new Set([...ranked.slice(0,6),...EMERGENCY.map(safeUrl).filter((url):url is string=>url!==null)])].slice(0,10).map(url=>({url,source:this.dynamic.includes(url)?'ario-peers':'fallback'}));
  }
  markSuccess(url:string,ms:number){const old=health.get(url)??{success:0,failure:0,latency:ms};health.set(url,{...old,success:old.success+1,latency:ms});}
  markFailure(url:string){const old=health.get(url)??{success:0,failure:0,latency:5000};health.set(url,{...old,failure:old.failure+1});}
}

export async function firstUsable<T>(targets:readonly GatewayTarget[],work:(target:GatewayTarget,signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>{
  const controllers=new Set<AbortController>();let index=0;let active=0;let finished=false;
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{for(const ctrl of controllers)ctrl.abort();reject(Error('aborted'));};
    signal.addEventListener('abort',abort,{once:true});
    const launch=()=>{
      if(finished)return;
      while(active<3&&index<targets.length){
        const target=targets[index++];const ctrl=new AbortController();controllers.add(ctrl);active++;
        void work(target,ctrl.signal).then(value=>{
          if(finished)return;finished=true;signal.removeEventListener('abort',abort);
          for(const other of controllers)if(other!==ctrl)other.abort();resolve(value);
        }).catch(()=>{}).finally(()=>{
          controllers.delete(ctrl);active--;
          if(!finished){if(index===targets.length&&active===0){finished=true;signal.removeEventListener('abort',abort);reject(Error('all_gateways_failed'));}else launch();}
        });
      }
      if(!finished&&active===0&&index===targets.length){finished=true;signal.removeEventListener('abort',abort);reject(Error('no_gateways'));}
    };launch();
  });
}
