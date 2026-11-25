import {TreasuryGuard,winston} from './treasuryGuard';
import type {TreasuryTopup,TreasurySnapshot,TreasuryTransferAttempt} from './adminTypes';
import {TREASURY_ADDRESS} from '../fund/ledger';
import {TOPUP_CONFIRMATIONS,checkedNativeTransfer,assertSameNativeTransfer,type TreasuryBaseline,type TreasuryTransferProof} from '../fund/treasuryProof';
type TopupRow={id:string;address:string;amount:string;baseline_height:number;prior_ceiling:string;prepared_revision:number;created_at:number;
  tx_id:string|null;proof_json:string|null;credited_revision:number|null;confirmed_at:number|null;intent_nonce:string|null};
const id=/^[a-f0-9]{32}$/,address=/^[A-Za-z0-9_-]{43}$/;
export class TreasuryTopupLedger{
  constructor(private readonly storage:DurableObjectStorage,private readonly guard:TreasuryGuard){
    storage.transactionSync(()=>{storage.sql.exec(`CREATE TABLE IF NOT EXISTS treasury_topups(
      id TEXT PRIMARY KEY,address TEXT NOT NULL,amount TEXT NOT NULL,baseline_height INTEGER NOT NULL,prior_ceiling TEXT NOT NULL,
      prepared_revision INTEGER NOT NULL,created_at INTEGER NOT NULL,tx_id TEXT UNIQUE,proof_json TEXT,credited_revision INTEGER,confirmed_at INTEGER,intent_nonce TEXT);
      CREATE TABLE IF NOT EXISTS treasury_topup_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,intent_id TEXT NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL,at INTEGER NOT NULL);`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS treasury_topup_transfers(intent_id TEXT PRIMARY KEY REFERENCES treasury_topups(id),claim_id TEXT NOT NULL,
        unsigned_tx TEXT NOT NULL,signed_tx TEXT,tx_id TEXT UNIQUE,created_at INTEGER NOT NULL,signed_at INTEGER);`);
      if(!storage.sql.exec<{name:string}>('PRAGMA table_info(treasury_topups)').toArray().some(column=>column.name==='intent_nonce'))
        storage.sql.exec('ALTER TABLE treasury_topups ADD COLUMN intent_nonce TEXT');
    });
  }
  private public(row:TopupRow):TreasuryTopup{return {id:row.id,address:row.address,amountWinston:row.amount,status:row.tx_id?'credited':'prepared',
    baselineHeight:row.baseline_height,priorCeilingWinston:row.prior_ceiling,preparedRevision:row.prepared_revision,createdAt:row.created_at,
    txId:row.tx_id,creditedWinston:row.tx_id?row.amount:null,creditedRevision:row.credited_revision,confirmedAt:row.confirmed_at,
    transferTag:row.intent_nonce?{name:'SEJIRE-Topup-Intent',value:row.intent_nonce}:null};}
  get(intentId:string):TreasuryTopup|null{const row=this.storage.sql.exec<TopupRow>('SELECT * FROM treasury_topups WHERE id=?',intentId).toArray()[0];return row?this.public(row):null;}
  list(limit=100,cursor:string|null=null){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||cursor!==null&&!/^[1-9][0-9]{0,14}$/.test(cursor))throw Error('invalid_topup_request');
    const rows=this.storage.sql.exec<TopupRow&{rowid:number}>('SELECT rowid,* FROM treasury_topups WHERE (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?',cursor,cursor===null?null:Number(cursor),limit+1).toArray();
    return {intents:rows.slice(0,limit).map(r=>this.public(r)),hasMore:rows.length>limit,cursor:rows.length>limit?String(rows[limit-1].rowid):null};
  }
  snapshot(value:string):TreasurySnapshot{const ceiling=this.guard.ceiling(value);return {address:value,revision:this.guard.revision(value),
    ceilingWinston:ceiling.balance,unobservedDebitWinston:ceiling.unobservedDebit,heldWinston:this.guard.held(value,TREASURY_ADDRESS)};}
  transfer(intentId:string):TreasuryTransferAttempt|null{
    if(!this.get(intentId))throw Error('topup_not_found');
    const row=this.storage.sql.exec<{claim_id:string;unsigned_tx:string;signed_tx:string|null;tx_id:string|null}>('SELECT claim_id,unsigned_tx,signed_tx,tx_id FROM treasury_topup_transfers WHERE intent_id=?',intentId).toArray()[0];
    return row?{claimId:row.claim_id,unsignedTx:row.unsigned_tx,signedTx:row.signed_tx,txId:row.tx_id}:null;
  }
  async claimTransfer(input:{id:string;claimId:string;unsignedTx:string},now=Date.now()){
    if(!id.test(input.id)||!id.test(input.claimId))throw Error('invalid_topup_request');
    const value=await checkedNativeTransfer(input.unsignedTx,false);
    const result=this.storage.transactionSync(()=>{
      const intent=this.get(input.id);if(!intent)throw Error('topup_not_found');
      if(!intent.transferTag)throw Error('topup_legacy_intent_requires_review');
      if(value.address!==intent.address||value.amountWinston!==intent.amountWinston||value.intentNonce!==intent.transferTag.value)throw Error('topup_transfer_conflict');
      const old=this.transfer(input.id);if(old){if(old.claimId!==input.claimId||old.unsignedTx!==input.unsignedTx)throw Error('topup_transfer_conflict');return {transfer:old,reused:true};}
      if(intent.txId)throw Error('topup_already_credited');
      this.storage.sql.exec('INSERT INTO treasury_topup_transfers(intent_id,claim_id,unsigned_tx,created_at) VALUES(?,?,?,?)',input.id,input.claimId,input.unsignedTx,now);
      this.storage.sql.exec('INSERT INTO treasury_topup_audit(intent_id,action,details,at) VALUES(?,?,?,?)',input.id,'TRANSFER_CLAIMED',JSON.stringify({claimId:input.claimId}),now);
      return {transfer:this.transfer(input.id)!,reused:false};
    });await this.storage.sync();return result;
  }
  async signTransfer(input:{id:string;claimId:string;signedTx:string},now=Date.now()){
    if(!id.test(input.id)||!id.test(input.claimId))throw Error('invalid_topup_request');
    const old=this.transfer(input.id);if(!old||old.claimId!==input.claimId)throw Error('topup_transfer_conflict');
    const [unsigned,signed]=await Promise.all([checkedNativeTransfer(old.unsignedTx,false),checkedNativeTransfer(input.signedTx,true)]);
    assertSameNativeTransfer(unsigned,signed);
    const result=this.storage.transactionSync(()=>{
      const intent=this.get(input.id)!;
      const current=this.transfer(input.id)!;
      if(current.signedTx){if(current.txId!==signed.txId)throw Error('topup_transfer_conflict');return {transfer:current,reused:true};}
      if(intent.txId)throw Error('topup_already_credited');
      this.storage.sql.exec('UPDATE treasury_topup_transfers SET signed_tx=?,tx_id=?,signed_at=? WHERE intent_id=?',input.signedTx,signed.txId,now,input.id);
      this.storage.sql.exec('INSERT INTO treasury_topup_audit(intent_id,action,details,at) VALUES(?,?,?,?)',input.id,'TRANSFER_SIGNED',JSON.stringify({claimId:input.claimId,txId:signed.txId}),now);
      return {transfer:this.transfer(input.id)!,reused:false};
    });await this.storage.sync();return result;
  }
  async prepare(input:{requestId:string;address:string;amountWinston:string;expectedRevision:number;baseline:TreasuryBaseline},now=Date.now()){
    if(!id.test(input.requestId)||!address.test(input.address)||winston(input.amountWinston)<=0n||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||
      !Number.isSafeInteger(input.baseline.height)||input.baseline.height<0)throw Error('invalid_topup_request');
    const result=this.storage.transactionSync(()=>{
      const prior=this.get(input.requestId);
      if(prior){if(prior.address!==input.address||prior.amountWinston!==input.amountWinston)throw Error('topup_idempotency_conflict');return prior;}
      if(this.guard.revision(input.address)!==input.expectedRevision)throw Error('treasury_revision_conflict');
      const balance=this.guard.pinBalance(input.address,input.baseline.balanceWinston);
      // Unknown until this pinned baseline is durable and returned to the
      // operator. Neither requestId nor a caller-selected memo provides this
      // freshness: a historical transfer cannot contain this future nonce.
      const nonce=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
      this.storage.sql.exec('INSERT INTO treasury_topups(id,address,amount,baseline_height,prior_ceiling,prepared_revision,created_at,intent_nonce) VALUES(?,?,?,?,?,?,?,?)',
        input.requestId,input.address,input.amountWinston,input.baseline.height,balance,input.expectedRevision,now,nonce);
      this.storage.sql.exec('INSERT INTO treasury_topup_audit(intent_id,action,details,at) VALUES(?,?,?,?)',input.requestId,'PREPARED',JSON.stringify({address:input.address,amountWinston:input.amountWinston,baselineHeight:input.baseline.height,ceilingWinston:balance,revision:input.expectedRevision,nonce}),now);
      return this.get(input.requestId)!;
    });await this.storage.sync();return {intent:result,treasury:this.snapshot(result.address)};
  }
  async confirm(input:{id:string;txId:string;expectedRevision:number;proof:TreasuryTransferProof},now=Date.now()){
    if(!id.test(input.id)||!address.test(input.txId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Error('invalid_topup_request');
    const result=this.storage.transactionSync(()=>{
      const prior=this.get(input.id);if(!prior)throw Error('topup_not_found');
      if(prior.txId){if(prior.txId!==input.txId)throw Error('topup_idempotency_conflict');return {intent:prior,reused:true};}
      if(!prior.transferTag)throw Error('topup_legacy_intent_requires_review');
      const transfer=this.transfer(input.id);
      if(transfer&&!transfer.signedTx)throw Error('topup_transfer_unresolved');
      if(transfer?.txId&&transfer.txId!==input.txId)throw Error('topup_transfer_conflict');
      if(this.guard.revision(prior.address)!==input.expectedRevision)throw Error('treasury_revision_conflict');
      const p=input.proof;
      if(p.txId!==input.txId||p.address!==prior.address||p.amountWinston!==prior.amountWinston||p.sender===p.address||!address.test(p.sender))throw Error('topup_transaction_mismatch');
      if(!Number.isSafeInteger(p.confirmations)||p.confirmations<TOPUP_CONFIRMATIONS)throw Error('topup_not_confirmed');
      if(!Number.isSafeInteger(p.blockHeight)||p.blockHeight<=prior.baselineHeight)throw Error('topup_precedes_intent');
      if(this.storage.sql.exec('SELECT id FROM treasury_topups WHERE tx_id=?',input.txId).toArray().length)throw Error('topup_transaction_used');
      if(p.intentNonce!==prior.transferTag.value)throw Error('topup_intent_mismatch');
      const before=this.guard.ceiling(prior.address).balance,revision=this.guard.creditProvedTransfer(prior.address,prior.amountWinston);
      this.storage.sql.exec('UPDATE treasury_topups SET tx_id=?,proof_json=?,credited_revision=?,confirmed_at=? WHERE id=?',input.txId,JSON.stringify(p),revision,now,input.id);
      this.storage.sql.exec('INSERT INTO treasury_topup_audit(intent_id,action,details,at) VALUES(?,?,?,?)',input.id,'CREDITED',JSON.stringify({proof:p,ceilingBefore:before,ceilingAfter:this.guard.ceiling(prior.address).balance,revision}),now);
      return {intent:this.get(input.id)!,reused:false};
    });await this.storage.sync();return {...result,treasury:this.snapshot(result.intent.address)};
  }
}
