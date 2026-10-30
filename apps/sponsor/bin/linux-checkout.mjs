import {startLinuxCheckout} from '../linux-server.mjs';

const dbPath=process.env.SEJIRE_LINUX_DB;
if(!dbPath){console.error('Set SEJIRE_LINUX_DB to a dedicated SQLite file. No production data is migrated automatically.');process.exit(2);}
const port=Number(process.env.SEJIRE_LINUX_PORT??8787),host=process.env.SEJIRE_LINUX_HOST??'127.0.0.1';
const backend=await startLinuxCheckout({dbPath,host,port,bindings:process.env});
console.log(`SEJIRE Linux checkout listening on ${host}:${backend.address.port}; one SQLite writer.`);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void backend.close().then(()=>process.exit(0));});
