/** Offline replay needs independently pinned creation hash and checkpoint. */
import {readFile,open} from 'node:fs/promises';
import {replay,verifiedKeys} from '../apps/sponsor/src/protocol/journal';
try{
 const [input,trust,output]=process.argv.slice(2);if(!input||!trust||!output)throw Error('usage');
 const saved=JSON.parse(await readFile(input,'utf8')),pinned=JSON.parse(await readFile(trust,'utf8'));
 const state=await replay(saved.genesis,pinned.creationHash,saved.entries,pinned.checkpoint);
 const keys=verifiedKeys(pinned.checkpoint,saved.signatures);
 if(keys.filter(k=>state.policy.managers.includes(k)).length<state.policy.threshold)throw Error('threshold');
 const f=await open(output,'wx',0o600);try{await f.writeFile(JSON.stringify(state));}finally{await f.close();}
 console.log('Signed local journal replay verified. NOT proof of AO scheduling or Arweave availability.');
}catch{console.error('Replay failed: journal, independent trust file and new output path required.');process.exitCode=1;}
