import type { NativeJob } from './jobs';
import { exactKeys } from './config';
import { retrieveNative } from './arweave';
import { parseEnvelope, MAX_BACKUP_BYTES } from '../crypto/envelope';
export type NativeReceipt={schema:'sejire/native-receipt/v1';protocol:'sejire/v0.3';encryption:'sejire/envelope/v1';arweaveNetwork:'arweave.N.1';transactionId:string;digest:string;bytes:number;orderId:string;paymentSignature:string;rewardWinston:string;createdAt:string};
export function nativeReceipt(job:NativeJob):NativeReceipt {
 const signature=job.paymentSignature??job.reconciledSignature;
 if(!job.arPlan||!job.order.archive||!signature)throw Error('no_native_receipt');
 return {schema:'sejire/native-receipt/v1',protocol:'sejire/v0.3',encryption:'sejire/envelope/v1',arweaveNetwork:'arweave.N.1',transactionId:job.arPlan.id,digest:job.order.archive.digest,bytes:job.order.archive.bytes,orderId:job.order.id,paymentSignature:signature,rewardWinston:job.arPlan.rewardWinston,createdAt:new Date().toISOString()};
}
export function parseNativeReceipt(value:unknown):NativeReceipt {
 const r=value as NativeReceipt;exactKeys(r,['schema','protocol','encryption','arweaveNetwork','transactionId','digest','bytes','orderId','paymentSignature','rewardWinston','createdAt']);
 if(r.schema!=='sejire/native-receipt/v1'||r.protocol!=='sejire/v0.3'||r.encryption!=='sejire/envelope/v1'||r.arweaveNetwork!=='arweave.N.1'||!/^[A-Za-z0-9_-]{43}$/.test(r.transactionId)||!/^[a-f0-9]{64}$/.test(r.digest)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>MAX_BACKUP_BYTES||!/^[a-f0-9]{32}$/.test(r.orderId)||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.paymentSignature)||!/^(0|[1-9]\d{0,29})$/.test(r.rewardWinston)||!Number.isFinite(Date.parse(r.createdAt)))throw Error('invalid_native_receipt');
 return r;
}
export async function retrieveNativeReceipt(r:NativeReceipt,nodes:string[]) {parseNativeReceipt(r);const data=await retrieveNative(nodes,r.transactionId,r.digest,r.bytes);return parseEnvelope(JSON.parse(data.text));}
