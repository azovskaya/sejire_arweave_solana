import {importLedgerSnapshotFile} from '../ledger-snapshot.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){
  if(!['--snapshot','--output','--expected-sha256'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('usage: import-ledger --snapshot PRIVATE.json --output NEW.sqlite --expected-sha256 SOURCE_DIGEST');
  options[args[i]]=args[i+1];
}
if(!options['--snapshot']||!options['--output']||!options['--expected-sha256'])throw Error('usage: import-ledger --snapshot PRIVATE.json --output NEW.sqlite --expected-sha256 SOURCE_DIGEST');
try{console.log(JSON.stringify(await importLedgerSnapshotFile(options['--snapshot'],options['--output'],options['--expected-sha256']),null,2));}
catch(error){console.error(error instanceof Error?error.message:'ledger_import_failed');process.exitCode=1;}
