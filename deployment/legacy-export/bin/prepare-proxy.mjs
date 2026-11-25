#!/usr/bin/env node
import {prepareProxy} from '../prepare-proxy.mjs';
const args=process.argv.slice(2);
if(args.length!==8||args[0]!=='--prepared-export-directory'||args[2]!=='--private-sidecar'||args[4]!=='--cutover-evidence'||args[6]!=='--output-new-directory'){
  console.error('Usage: node --import tsx bin/prepare-proxy.mjs --prepared-export-directory PRIVATE_DIRECTORY --private-sidecar PRIVATE_SIDECAR.json --cutover-evidence PRIVATE_CUTOVER.json --output-new-directory NEW_DIRECTORY');process.exitCode=2;
}else try{const result=await prepareProxy(args[1],args[3],args[5],args[7]);console.log(JSON.stringify({prepared:true,deployed:false,moduleSha256:result.moduleSha256}));}
catch(error){console.error(error instanceof Error&&/^compatibility_[a-z_]+$/.test(error.message)?error.message:'compatibility_preparation_failed');process.exitCode=1;}
