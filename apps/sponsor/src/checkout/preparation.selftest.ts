import assert from 'node:assert/strict';
import { RpcPaymentPreparer } from './paymentPreparation';
import { SolanaRpcReader, DEVNET_GENESIS } from './rpcReader';
import { fixtureOrder, addr } from './rpcFixtures';
import { SYSTEM_PROGRAM } from '../../../../packages/checkout/order';
import { rpcU64 } from '../../../../packages/checkout/rpcJson';

// Raw JSON is essential here: constructing these values as JS Numbers would
// round odd u64 amounts before the RPC reader gets a chance to preserve them.
const balances: Record<string, string> = {
  balance: '35004999',
  'large-balance': '9007199254740992',
  'max-u64-balance': '18446744073709551615',
  'large-exact-balance': '9007199254745993',
  'large-short-balance': '9007199254745992',
  'overflow-balance': '18446744073709551616',
  'fractional-balance': '1000000000.5',
  'exponential-balance': '1e9',
  'negative-balance': '-1',
  'negative-zero-balance': '-0',
  'null-balance': 'null',
};
const accepted = new Set(['success', 'empty-recipient', 'large-balance', 'max-u64-balance', 'large-exact-balance']);
let passed = 0;
for (const mode of ['success', 'empty-recipient', 'program', 'executable', ...Object.keys(balances), 'network', 'blockhash', 'height', 'token']) {
  const largePayment = mode === 'large-exact-balance' || mode === 'large-short-balance';
  const service = largePayment ? (9007199254740993n - 5000000n).toString() : '30000000';
  const order = fixtureOrder({ asset: mode === 'token' ? 'USDC' : 'SOL', servicePayment: {amount:service,recipient:addr(2)},fundContribution:{amount:'5000000',recipient:addr(3)} });
  const reader = new SolanaRpcReader({network:'devnet'},async (_url,init)=>{
    const p=JSON.parse(init!.body as string);let result: unknown;
    if(p.method==='getGenesisHash')result=mode==='network'?addr(90):DEVNET_GENESIS;
    else if(p.method==='getAccountInfo')result={value:mode==='empty-recipient'?null:{owner:mode==='program'?addr(90):SYSTEM_PROGRAM,executable:mode==='executable'}};
    else if(p.method==='getLatestBlockhash')result={value:{blockhash:mode==='blockhash'?'bad':addr(8),lastValidBlockHeight:mode==='height'?null:1000}};
    else if(p.method==='getBalance')return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(p.id)},"result":{"value":${balances[mode] ?? '1000000000'}}}`, { headers: { 'Content-Type': 'application/json' } });
    else throw new Error('unexpected_method');
    return Response.json({jsonrpc:'2.0',id:p.id,result});
  });
  if(accepted.has(mode)) assert.equal((await new RpcPaymentPreparer(reader).prepare(order)).feeLamports,'5000');
  else if(Object.hasOwn(balances, mode)) await assert.rejects(new RpcPaymentPreparer(reader).prepare(order), /^Error: payment_balance_not_ready$/);
  else await assert.rejects(new RpcPaymentPreparer(reader).prepare(order));
  passed++;console.log(`PASS SOL preparation: ${mode}`);
}
// Unlike exact numeric tokens received over JSON, an already-rounded Number
// is still rejected at the integer-validation boundary.
assert.throws(() => rpcU64(Number.MAX_SAFE_INTEGER + 1), /invalid_rpc_integer/);
passed++;console.log('PASS SOL preparation: unsafe-JavaScript-number');
console.log(`preparation.selftest: ${passed} synthetic native SOL scenarios PASS; no wallet/network`);
