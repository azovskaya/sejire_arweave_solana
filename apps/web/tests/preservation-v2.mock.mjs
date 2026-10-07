/** Runs before the application bundle. All counters and controls survive page reload. */
export function installV2Mock() {
  const payer='F8XB2iSMf8mB6fPhtwGRDjuT8wTypfARN5pscu3fjqKN';
  const reserve='qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI';
  const signature='1'.repeat(88), arId='A'.repeat(43);
  const get=(key)=>localStorage.getItem(`v2mock:${key}`);
  const set=(key,value)=>localStorage.setItem(`v2mock:${key}`,String(value));
  const add=(key)=>{const value=Number(get(key)??0)+1;set(key,value);return value;};
  const reader={
    getGenesisHash:async()=> 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getLatestBlockhash:async()=>({blockhash:'synthetic-blockhash',lastValidBlockHeight:100}),
    getSlot:async()=>50,getBlockHeight:async()=>101,getMinimumLedgerSlot:async()=>0,
    getSignaturesForAddress:async()=>[],getParsedTransaction:async()=>null,
  };
  window.__SEJIRE_V2_TEST_DRIVER__={
    walletTimeoutMs:Number(get('walletTimeoutMs')??60_000),
    rpc:()=>reader,readers:()=>[reader,reader],devnet:async()=>{},
    phantom:()=>({isPhantom:true,publicKey:{toBase58:()=>payer},
      connect:async()=>({publicKey:{toBase58:()=>payer}}),
      signAndSendTransaction:async()=>{add('phantomCalls');set('sent','1');
        if(get('phantomLost')==='1')return new Promise(()=>{});
        return {signature};}}),
    discover:async()=>({signature:get('sent')==='1'?signature:undefined,failedSignatures:[],absent:false}),
    verifySolana:async(_session,sig)=>{
      if(sig!==signature||get('sent')!=='1'||get('finalized')==='0')throw Error('payment_not_finalized');
    },
    quoteAr:async()=>{add('quoteCalls');return {reward:'1000',balance:'2000'};},
    wander:()=>({connect:async()=>{add('wanderConnects');},getActiveAddress:async()=>reserve,
      getActivePublicKey:async()=> 'synthetic-public-key',sign:async()=>{throw Error('unexpected direct sign');}}),
    signAr:async(_session,_wallet,reward,beforeSign,timeoutMs)=>{
      await beforeSign?.();add('wanderSigns');
      if(get('wanderLost')==='1')return new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('wander_response_timeout')),timeoutMs));
      return {id:arId,reward,signed:{format:2,id:arId,synthetic:true}};
    },
    validateAr:async(session)=>{if(session.arTransactionId!==arId||!session.arSignedTransaction)throw Error('unsigned_ar_transaction');return {};},
    uploadAr:async(session,persist)=>{
      add('uploads');
      if(get('uploadMode')==='pause-before')return new Promise(()=>{});
      if(get('uploadedId') && get('uploadedId')!==session.arTransactionId)throw Error('duplicate_ar_transaction');
      set('uploadedId',session.arTransactionId);
      set('gatewayPayload',session.archiveText);
      await persist({chunkIndex:1,synthetic:true});
      if(get('uploadMode')==='pause-mid')return new Promise(()=>{});
    },
    verifyAr:async(session)=>{
      add('verifyCalls');
      if(get('confirmed')==='0')throw Error('ar_confirmation_pending');
      if(get('retrievalFailed')==='1')throw Error('ar_retrieval_failed');
      if(get('uploadedId')!==session.arTransactionId)throw Error('ar_retrieval_pending');
      const bytes=new TextEncoder().encode(get('gatewayPayload')??'');
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
        .map(x=>x.toString(16).padStart(2,'0')).join('');
      if(bytes.length!==session.archiveBytes||digest!==session.archiveDigest||
        JSON.parse(new TextDecoder().decode(bytes)).vault_id!==session.vaultId)throw Error('retrieved_archive_mismatch');
    },
  };
}
