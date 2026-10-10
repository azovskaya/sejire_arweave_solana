import assert from 'node:assert/strict';
import { RpcPaymentPreparer } from './paymentPreparation';
import { SolanaRpcReader, DEVNET_GENESIS } from './rpcReader';
import { fixtureOrder, addr } from './rpcFixtures';
import { SYSTEM_PROGRAM } from '../../../../packages/checkout/order';
let passed = 0;
for (const mode of ['success', 'empty-recipient', 'program', 'executable', 'balance', 'unsafe-balance', 'network', 'blockhash', 'height', 'token']) {
  const order = fixtureOrder({ asset: mode === 'token' ? 'USDC' : 'SOL', servicePayment: {amount:'30000000',recipient:addr(2)},fundContribution:{amount:'5000000',recipient:addr(3)} });
  const reader = new SolanaRpcReader({network:'devnet'},async (_url,init)=>{
    const p=JSON.parse(init!.body as string);let result: unknown;
    if(p.method==='getGenesisHash')result=mode==='network'?addr(90):DEVNET_GENESIS;
    else if(p.method==='getAccountInfo')result={value:mode==='empty-recipient'?null:{owner:mode==='program'?addr(90):SYSTEM_PROGRAM,executable:mode==='executable'}};
    else if(p.method==='getLatestBlockhash')result={value:{blockhash:mode==='blockhash'?'bad':addr(8),lastValidBlockHeight:mode==='height'?null:1000}};
    else if(p.method==='getBalance')result={value:mode==='balance'?35004999:mode==='unsafe-balance'?Number.MAX_SAFE_INTEGER+1:1000000000};
    else throw new Error('unexpected_method');
    return Response.json({jsonrpc:'2.0',id:p.id,result});
  });
  if(mode==='success'||mode==='empty-recipient') assert.equal((await new RpcPaymentPreparer(reader).prepare(order)).feeLamports,'5000');
  else await assert.rejects(new RpcPaymentPreparer(reader).prepare(order));
  passed++;console.log(`PASS SOL preparation: ${mode}`);
}
console.log(`preparation.selftest: ${passed} synthetic native SOL scenarios PASS; no wallet/network`);
