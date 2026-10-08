import type {HeadDiscoveryProvider,RecoveryContext,DiscoveryResult,HeadCandidate} from '../types';
import {timedFetch} from '../gateways';

type Edge={node:{id:string;block?:{height?:number;timestamp?:number}|null;tags?:{name:string;value:string}[]}};
export class GraphqlVaultProvider implements HeadDiscoveryProvider {
  readonly id:string;
  readonly endpoint:string;
  constructor(endpoint:string){this.endpoint=endpoint;this.id=`graphql:${new URL(endpoint).host}`;}
  async discover(ctx:RecoveryContext):Promise<DiscoveryResult>{
    const query=`query ($vaultId:String!,$after:String){transactions(first:100,after:$after,sort:HEIGHT_DESC,tags:[{name:"App-Name",values:["SEJIRE"]},{name:"Type",values:["vault-envelope"]},{name:"Vault-Id",values:[$vaultId]}]){pageInfo{hasNextPage}edges{cursor node{id block{height timestamp} tags{name value}}}}}`;
    const candidates:HeadCandidate[]=[];let after:string|null=null;
    try {
      for(let page=0;page<3;page++){
        const response=await timedFetch(ctx.fetcher,this.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({query,variables:{vaultId:ctx.vaultId,after}})},4500,ctx.signal);
        if(!response.ok)throw Error('index_unavailable');
        const result=await response.json() as {data?:{transactions?:{pageInfo?:{hasNextPage:boolean};edges?:Array<Edge&{cursor?:string}>}};errors?:unknown};
        const connection=result.data?.transactions;if(result.errors||!Array.isArray(connection?.edges))throw Error('index_invalid');
        for(const edge of connection.edges){if(!/^[A-Za-z0-9_-]{43}$/.test(edge.node.id))continue;
          candidates.push({txId:edge.node.id,source:this.id,blockHeight:edge.node.block?.height,blockTimestamp:edge.node.block?.timestamp});}
        if(!connection.pageInfo?.hasNextPage||!connection.edges.length)break;
        after=connection.edges[connection.edges.length-1].cursor??null;if(!after)break;
      }
      return {status:'responded',candidates};
    } catch{return {status:'unavailable',candidates};}
  }
}
