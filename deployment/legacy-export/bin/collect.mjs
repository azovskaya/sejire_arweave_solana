#!/usr/bin/env node
import {collect} from '../collect.mjs';
const args=process.argv.slice(2);
if(args.length!==8||args[0]!=='--origin'||args[2]!=='--config'||args[4]!=='--token-file'||args[6]!=='--output-new-directory'){
  console.error('Usage: node --import tsx bin/collect.mjs --origin VERIFIED_HTTPS_ORIGIN --config PRIVATE_CONFIG.json --token-file PRIVATE_EXPORT_TOKEN_FILE --output-new-directory NEW_DIRECTORY');process.exitCode=2;
}else try{console.log(JSON.stringify(await collect({origin:args[1],configFile:args[3],tokenFile:args[5],outputDirectory:args[7]})));}
catch(error){console.error(error instanceof Error&&/^export_[a-z_]+$/.test(error.message)?error.message:'export_collection_failed');process.exitCode=1;}
