import {BlockList,isIP} from 'node:net';

/** Forwarded addresses are only meaningful when the socket peer and each hop
 * to its right is an explicitly trusted ingress. No wildcard/header default. */
export function trustedIngress(value=''){
  if(typeof value!=='string'||value.length>4096)throw Error('invalid_trusted_proxy_cidrs');
  const list=new BlockList(),rules=value.split(',').map(x=>x.trim()).filter(Boolean);
  if(rules.length>64)throw Error('invalid_trusted_proxy_cidrs');
  for(const rule of rules){
    const parts=rule.split('/'),version=isIP(parts[0]);
    if(parts.length!==2||!version||!/^(0|[1-9][0-9]{0,2})$/.test(parts[1]))throw Error('invalid_trusted_proxy_cidrs');
    const prefix=Number(parts[1]);if(prefix<1||prefix>(version===4?32:128))throw Error('invalid_trusted_proxy_cidrs');
    try{list.addSubnet(parts[0],prefix,version===4?'ipv4':'ipv6');}catch{throw Error('invalid_trusted_proxy_cidrs');}
  }
  const normalize=value=>typeof value==='string'&&value.startsWith('::ffff:')&&isIP(value.slice(7))===4?value.slice(7):value;
  const trusted=value=>{const v=isIP(value);return Boolean(v&&list.check(value,v===4?'ipv4':'ipv6'));};
  return (socketAddress,forwarded)=>{
    const peer=normalize(socketAddress??'unknown');
    if(!rules.length||!trusted(peer)||typeof forwarded!=='string'||forwarded.length>4096)return peer;
    const chain=forwarded.split(',').map(x=>normalize(x.trim()));
    if(!chain.length||chain.length>32||chain.some(ip=>!isIP(ip)))return peer;
    let current=peer;
    for(let i=chain.length-1;i>=0&&trusted(current);i--)current=chain[i];
    return current;
  };
}
