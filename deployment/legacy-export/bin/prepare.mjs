#!/usr/bin/env node
import {prepare} from '../prepare.mjs';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--source-evidence'||args[2]!=='--output-new-directory'){
  console.error('Usage: node --import tsx bin/prepare.mjs --source-evidence PRIVATE_EVIDENCE.json --output-new-directory NEW_DIRECTORY');process.exitCode=2;
}else try{
  const review=await prepare(args[1],args[3]);
  // Only hashes and the operation result, no credentials or source rows.
  console.log(JSON.stringify({prepared:true,deployed:false,moduleSha256:review.moduleSha256,metadataSha256:review.metadataSha256}));
}catch(error){console.error(error instanceof Error&&/^export_[a-z_]+$/.test(error.message)?error.message:'export_preparation_failed');process.exitCode=1;}
