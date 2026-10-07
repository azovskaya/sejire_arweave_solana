import { PRESERVATION_V2_PILOT_POLICY as P, assertArchive, saveId } from './policy';
import { readSession, startSession, updateSession, withSessionLock } from './store';
import { assertDevnet, buildPayment, discoverPayment, isUserRejection, phantom, solanaReader, SOLANA_RPC_URLS } from './solana';
import { verifyPayment } from './verify';
import { quoteArchive, signArchive, uploadSigned, validateSigned, verifyArweave, wander } from './arweave';
import { withTimeout } from './timeout';
import type { SaveSession } from './types';

/** Narrow drivers let tests exercise the real state machine without network or wallets. */
export type MachineServices = {
  id: typeof saveId; read: typeof readSession; update: typeof updateSession; lock: typeof withSessionLock;
  archive: typeof assertArchive; rpc: typeof solanaReader; readers: () => ReturnType<typeof solanaReader>[];
  devnet: typeof assertDevnet; build: typeof buildPayment; discover: typeof discoverPayment;
  verifySolana: typeof verifyPayment; phantom: typeof phantom;
  wander: typeof wander; quoteAr: typeof quoteArchive; signAr: typeof signArchive;
  validateAr: typeof validateSigned; uploadAr: typeof uploadSigned; verifyAr: typeof verifyArweave;
  walletTimeoutMs: number;
};
export const productionServices: MachineServices = {
  id:saveId, read:readSession, update:updateSession, lock:withSessionLock, archive:assertArchive,
  rpc:solanaReader, readers:()=>SOLANA_RPC_URLS.map(solanaReader), devnet:assertDevnet,
  build:buildPayment, discover:discoverPayment, verifySolana:verifyPayment, phantom,
  wander, quoteAr:quoteArchive, signAr:signArchive, validateAr:validateSigned,
  uploadAr:uploadSigned, verifyAr:verifyArweave,
  walletTimeoutMs:60_000,
};
// Browser fixture hook is compiled out of the owner build (native:build forces TEST=0).
if(import.meta.env?.VITE_PRESERVATION_V2_TEST==='1' && typeof window!=='undefined')
  Object.assign(productionServices,(window as Window & {__SEJIRE_V2_TEST_DRIVER__?:Partial<MachineServices>}).__SEJIRE_V2_TEST_DRIVER__);

const safeErrors = new Set(['ar_confirmation_pending','ar_retrieval_pending','retrieved_archive_mismatch',
  'payment_not_finalized','payment_transaction_failed','wrong_solana_network','reference_history_not_complete','wrong_arweave_network',
  'unexpected_value_transfer','missing_or_duplicate_service_transfer','signed_ar_transaction_mismatch',
  'phantom_response_timeout','wander_response_timeout','solana_reader_timeout','insufficient_solana_readers']);
const errorCode = (error: unknown) => error instanceof Error && safeErrors.has(error.message) ? error.message : 'operation_pending';
const invalidPayment = new Set(['payment_identity_mismatch','unexpected_value_transfer',
  'unexpected_inner_instructions','unexpected_payment_instruction','unrecognized_compute_budget',
  'invalid_compute_budget','compute_limit_too_high','priority_fee_too_high',
  'unsupported_compute_budget','missing_or_duplicate_service_transfer']);

export async function currentSession(d: MachineServices = productionServices): Promise<SaveSession | undefined> { return d.read(await d.id()); }
export async function beginSave(text: string): Promise<SaveSession> { return startSession(text); }

async function checkSolana(session: SaveSession, d: MachineServices): Promise<SaveSession> {
  if (session.state !== 'SOLANA_PENDING') return session;
  const sources = d.readers();
  const verify = async(signature:string) => {
    let last:unknown=Error('payment_not_finalized');
    for(const rpc of sources)try{await withTimeout(d.verifySolana(session,signature,rpc),15_000,'solana_reader_timeout');return true;}
    catch(error){last=error;if(error instanceof Error&&invalidPayment.has(error.message))throw error;
      if(error instanceof Error&&error.message==='payment_transaction_failed')throw error;}
    throw last;
  };
  let knownFailed=false;
  if(session.solanaSignature)try{
    await verify(session.solanaSignature);
    return d.update(session.saveId,old=>({...old,state:'SOLANA_PAID',lastError:undefined}));
  }catch(error){
    if(error instanceof Error&&invalidPayment.has(error.message))
      return d.update(session.saveId,old=>({...old,state:'BLOCKED',lastError:'payment_invalid'}));
    knownFailed=error instanceof Error&&error.message==='payment_transaction_failed';
    if(!knownFailed&&!(error instanceof Error&&error.message==='payment_not_finalized'))throw error;
  }
  const discovered=await d.discover(session,sources);
  if(discovered.signature){
    try{await verify(discovered.signature);}
    catch(error){if(error instanceof Error&&invalidPayment.has(error.message))
      return d.update(session.saveId,old=>({...old,state:'BLOCKED',lastError:'payment_invalid'}));throw error;}
    return d.update(session.saveId,old=>({...old,solanaSignature:discovered.signature,state:'SOLANA_PAID',lastError:undefined}));
  }
  if(discovered.absent&&(!knownFailed||discovered.failedSignatures.includes(session.solanaSignature!)))
    return d.update(session.saveId,old=>({...old,state:'SOLANA_PREPARED',solanaAttempted:false,
      solanaSignature:undefined,solanaFailedSignatures:[...new Set([...(old.solanaFailedSignatures??[]),...discovered.failedSignatures])],
      lastError:discovered.failedSignatures.length?'payment_transaction_failed':'payment_not_sent'}));
  return session;
}

export async function reconcileSave(d: MachineServices = productionServices): Promise<SaveSession | undefined> {
  const id = await d.id();
  return d.lock(id, async () => {
    let session = await d.read(id);
    if (!session) return undefined;
    await d.archive(session.archiveText);
    if (session.state === 'SOLANA_PENDING') session = await checkSolana(session,d);
    if (session.state === 'AR_READY' && session.arSigningStarted && !session.arSignedTransaction)
      session = await d.update(id, old => ({...old, arSigningStarted:false, lastError:'wander_response_lost_before_upload'}));
    if (session.state === 'AR_SIGNED' || session.state === 'AR_UPLOADING') {
      session = await continueUpload(session,d);
    }
    if (session.state === 'AR_PENDING_CONFIRMATION') {
      try { await d.verifyAr(session);
        session = await d.update(id, old => ({...old, state:'COMPLETE', lastError:undefined}));
      } catch (error) {
        session = await d.update(id, old => ({...old, lastError:errorCode(error)}));
      }
    }
    return session;
  });
}

export async function pay(d: MachineServices = productionServices): Promise<SaveSession> {
  const id = await d.id();
  return d.lock(id, async () => {
    let session = await d.read(id);
    if (!session) throw Error('archive_required');
    await d.archive(session.archiveText);
    if (session.state === 'SOLANA_PENDING') return checkSolana(session,d);
    if (!['READY', 'SOLANA_PREPARED'].includes(session.state)) return session;
    if (session.solanaAttempted) throw Error('payment_requires_reconciliation');
    const wallet = d.phantom();
    await wallet.connect();
    if (wallet.publicKey?.toBase58() !== P.payer) throw Error('wrong_phantom_account');
    const rpc = d.rpc(); await d.devnet(rpc);
    const [latest, slot] = await Promise.all([rpc.getLatestBlockhash('finalized'), rpc.getSlot('finalized')]);
    const tx = d.build(session, latest.blockhash);
    session = await d.update(id, old => ({...old, state:'SOLANA_PREPARED', solanaBlockhash:latest.blockhash,
      solanaLastValidBlockHeight:latest.lastValidBlockHeight, solanaPreparedSlot:slot, lastError:undefined}));
    session = await d.update(id, old => ({...old, state:'SOLANA_PENDING', solanaAttempted:true}));
    try {
      const response = await withTimeout(wallet.signAndSendTransaction(tx),d.walletTimeoutMs,'phantom_response_timeout');
      const signature = typeof response === 'string' ? response : response.signature;
      if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) throw Error('invalid_phantom_signature');
      session = await d.update(id, old => ({...old, solanaSignature:signature}));
      if (wallet.publicKey?.toBase58() !== P.payer)
        session = await d.update(id, old => ({...old, lastError:'phantom_account_changed'}));
    } catch (error) {
      if (isUserRejection(error)) {
        // Explicit wallet rejection before broadcast can be retried with the same session/reference.
        return d.update(id, old => ({...old, state:'READY', solanaAttempted:false,
          solanaRejected:true, lastError:'phantom_rejected'}));
      }
      await d.update(id, old => ({...old, lastError:errorCode(error)}));
      return (await d.read(id))!;
    }
    try { return await checkSolana(session,d); }
    catch (error) { return d.update(id, old => ({...old, lastError:errorCode(error)})); }
  });
}

export async function prepareArweave(d: MachineServices = productionServices): Promise<{session: SaveSession; reward: string}> {
  const id = await d.id();
  return d.lock(id, async () => {
    let session = await d.read(id);
    if (!session || !['SOLANA_PAID', 'AR_READY'].includes(session.state)) throw Error('solana_payment_required');
    await d.archive(session.archiveText);
    const quote = await d.quoteAr(P.arReserve, session.archiveBytes);
    if (session.state === 'SOLANA_PAID') session = await d.update(id, old => ({...old, state:'AR_READY'}));
    if (session.arSigningStarted) throw Error('ar_signature_requires_reconciliation');
    return {session, reward:quote.reward};
  });
}

async function continueUpload(session: SaveSession,d:MachineServices): Promise<SaveSession> {
  const id = session.saveId;
  try { await d.validateAr(session); }
  catch { return d.update(id, old => ({...old, state:'BLOCKED', lastError:'signed_ar_transaction_mismatch'})); }
  if (session.state === 'AR_SIGNED') session = await d.update(id, old => ({...old, state:'AR_UPLOADING'}));
  try {
    await d.uploadAr(session, async progress => {
      session = await d.update(id, old => ({...old, arUploadProgress:progress}));
    });
    return d.update(id, old => ({...old, state:'AR_PENDING_CONFIRMATION', lastError:undefined}));
  } catch (error) {
    return d.update(id, old => ({...old, lastError:errorCode(error)}));
  }
}

export async function saveToArweave(expectedReward: string,d: MachineServices = productionServices): Promise<SaveSession> {
  const id = await d.id();
  return d.lock(id, async () => {
    let session = await d.read(id);
    if (!session || session.state !== 'AR_READY' || session.arSigningStarted) throw Error('ar_not_ready');
    await d.archive(session.archiveText);
    const wallet = d.wander();
    await wallet.connect(['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION']);
    if (await wallet.getActiveAddress() !== P.arReserve) throw Error('wrong_wander_address');
    try {
      const signed = await d.signAr(session, wallet, expectedReward, async()=>{
        // Durably mark the precise signing boundary after all quote/preflight checks.
        session = await d.update(id, old => ({...old, arSigningStarted:true}));
      },d.walletTimeoutMs);
      session = await d.update(id, old => ({...old, state:'AR_SIGNED',
        arTransactionId:signed.id, arSignedTransaction:signed.signed, arRewardWinston:signed.reward}));
    } catch (error) {
      const latest=await d.read(id);
      if(latest?.arSignedTransaction)return continueUpload(latest,d);
      return d.update(id, old => ({...old, arSigningStarted:false,
        lastError:isUserRejection(error)?'wander_rejected':errorCode(error)}));
    }
    try { await d.validateAr(session); }
    catch { return d.update(id, old => ({...old, state:'BLOCKED', lastError:'signed_ar_transaction_mismatch'})); }
    return continueUpload(session,d);
  });
}
