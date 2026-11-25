// TEST ONLY. This module is never an input of prepare.mjs / export-only.mjs.
import fixture from './schema-fixture.json';
import {OBJECT_NAME} from '../src/config';
export class CheckoutLedger {
  constructor(private readonly ctx:DurableObjectState){}
  async fetch(request:Request):Promise<Response>{
    if(request.headers.get('X-Synthetic')!=='fixture-only')return new Response('',{status:403});
    const input=await request.json() as {action:string;alarmAt:number|null;leaseTable?:string;unknown?:boolean;incomplete?:boolean};
    if(input.action==='seed'){
      this.ctx.storage.transactionSync(()=>{
        for(const sql of fixture.schema)this.ctx.storage.sql.exec(sql);
        this.ctx.storage.sql.exec('INSERT INTO schema_version VALUES(1)');
        this.ctx.storage.sql.exec('INSERT INTO fund_settings VALUES(1,1,?,?,?,?,?,?)','b'.repeat(64),'synthetic promo',1,10,20,'1000');
      });
    }
    if(input.action==='seed-data'){
      this.ctx.storage.transactionSync(()=>{
        const sql=this.ctx.storage.sql;
        sql.exec("INSERT INTO orders(id,network,reference,order_json,states_json,pending_signature) VALUES(?,?,?,?,?,?)",'o'.repeat(32),'mainnet-beta','reference-synthetic','{"fixture":"order"}','{"payment":"confirmed"}','synthetic-payment-signature');
        sql.exec('INSERT INTO api_sessions(hash,expires_at) VALUES(?,?)','c'.repeat(64),9999999999999);
        sql.exec('INSERT INTO api_orders(order_id,owner,idem_key,intent) VALUES(?,?,?,?)','o'.repeat(32),'c'.repeat(64),'synthetic-idempotency-key','synthetic-immutable-intent');
        sql.exec('INSERT INTO paid_orders(order_id,policy_json,status,next_at,paid) VALUES(?,?,?,?,?)','o'.repeat(32),'{}','submitted',1,1);
        sql.exec('INSERT INTO paid_payloads(order_id,kind,payload) VALUES(?,?,?)','o'.repeat(32),'signed','{"synthetic":"exact signed bytes \\n Қазақ шежіресі"}');
        sql.exec('INSERT INTO api_execution(order_id,plan_json,lease_until) VALUES(?,?,?)','o'.repeat(32),'synthetic-legacy-upload-plan',0);
        sql.exec('INSERT INTO paid_holds(order_id,budget_id,treasury,reward,actual,released) VALUES(?,?,?,?,?,?)','o'.repeat(32),'historical-budget','T'.repeat(43),'100','70',0);
        sql.exec('INSERT INTO treasury_balance_ceiling(address,balance) VALUES(?,?)','T'.repeat(43),'930');
        sql.exec('INSERT INTO treasury_revision(address,revision) VALUES(?,?)','T'.repeat(43),3);
        sql.exec('INSERT INTO fund_meta(id,reconciled_at) VALUES(1,?)',100);
        sql.exec('INSERT INTO fund_audit(action,details,at) VALUES(?,?,?)','PROMO_CHANGED','{"revision":1}',20);
        sql.exec('INSERT INTO fund_orders(order_id,preservation_id,revision,archive_bytes,digest,vault_id,estimate,reserved,created_at,prepared_json) VALUES(?,?,?,?,?,?,?,?,?,?)',
          'f'.repeat(32),'e'.repeat(32),1,256,'d'.repeat(64),'a'.repeat(32),'15','20',10,'{"fixture":"immutable encrypted promo preparation"}');
        sql.exec('INSERT INTO fund_jobs(order_id,next_at,updated_at) VALUES(?,?,?)','f'.repeat(32),1,10);
        sql.exec('INSERT INTO fund_events(order_id,status,tx_id,signed_json,at) VALUES(?,?,?,?,?)','f'.repeat(32),'SIGNED','S'.repeat(43),'{"fixture":"same immutable signed promo bytes"}',11);
        if(input.leaseTable){
          if(!['fund_jobs','paid_orders','api_execution'].includes(input.leaseTable))throw Error('fixture_bad_lease_table');
          sql.exec(`UPDATE ${input.leaseTable} SET lease_until=?`,Date.now()+600000);
        }
        if(input.unknown)sql.exec('CREATE TABLE unexpected_private_obligation(id TEXT)');
        if(input.incomplete)sql.exec('DROP TABLE paid_payment_recoveries');
      });
      if(input.alarmAt!==null)await this.ctx.storage.setAlarm(input.alarmAt);
      await this.ctx.storage.put('synthetic-unrelated-private-kv','must-not-enter-sql-snapshot');
      return Response.json({objectId:this.ctx.id.toString(),alarmAt:await this.ctx.storage.getAlarm()});
    }
    if(input.action==='inspect')return Response.json({alarmAt:await this.ctx.storage.getAlarm(),freeze:await this.ctx.storage.get('sejire:legacy-export:freeze:v1'),
      unrelated:await this.ctx.storage.get('synthetic-unrelated-private-kv'),executions:await this.ctx.storage.get('fixture-old-executions')??0});
    if(input.action==='alarm-now'){await this.ctx.storage.setAlarm(Date.now()+10);return Response.json({ok:true});}
    return Response.json({ok:true});
  }
  async alarm(){await this.ctx.storage.put('fixture-old-executions',1);}
}
export default {async fetch(request:Request,env:{CHECKOUT_LEDGER:DurableObjectNamespace}){
  return env.CHECKOUT_LEDGER.get(env.CHECKOUT_LEDGER.idFromName(OBJECT_NAME)).fetch(request);
}};
