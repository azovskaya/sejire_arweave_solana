import { PRESERVATION_V2_PILOT_POLICY as P, saveId } from './policy';
import { readSession, startSession, updateSession, withSessionLock } from './store';
import { assertDevnet, buildPayment, discoverPayment, isUserRejection, phantom, solanaReader, SOLANA_RPC_URLS } from './solana';
import { verifyPayment } from './verify';
import { quoteArchive, signArchive, uploadSigned, verifyArweave, wander } from './arweave';
import type { SaveSession } from './types';

const readers = () => SOLANA_RPC_URLS.map(solanaReader);
const errorCode = (error: unknown) => error instanceof Error ? error.message : 'unknown_error';

export async function currentSession(): Promise<SaveSession | undefined> { return readSession(await saveId()); }
export async function beginSave(text: string): Promise<SaveSession> { return startSession(text); }

async function checkSolana(session: SaveSession): Promise<SaveSession> {
  if (session.state !== 'SOLANA_PENDING') return session;
  const sources = readers();
  const discovered = session.solanaSignature ? undefined : await discoverPayment(session, sources);
  const signature = session.solanaSignature ?? discovered?.signature;
  if (signature) {
    await verifyPayment(session, signature, sources[0]);
    return updateSession(session.saveId, old => ({...old, solanaSignature:signature, state:'SOLANA_PAID', lastError:undefined}));
  }
  if (discovered?.absent) {
    return updateSession(session.saveId, old => ({...old, state:'SOLANA_PREPARED', solanaAttempted:false,
      lastError:'Previous blockhash expired; no finalized transaction found on both RPC readers.'}));
  }
  return session;
}

export async function reconcileSave(): Promise<SaveSession | undefined> {
  const id = await saveId();
  return withSessionLock(id, async () => {
    let session = await readSession(id);
    if (!session) return undefined;
    if (session.state === 'SOLANA_PENDING') session = await checkSolana(session);
    if (session.state === 'AR_READY' && session.arSigningStarted && !session.arSignedTransaction)
      session = await updateSession(id, old => ({...old, state:'BLOCKED', lastError:'wander_response_lost'}));
    if (session.state === 'AR_SIGNED' || session.state === 'AR_UPLOADING') {
      session = await continueUpload(session);
    }
    if (session.state === 'AR_PENDING_CONFIRMATION') {
      try { await verifyArweave(session);
        session = await updateSession(id, old => ({...old, state:'COMPLETE', lastError:undefined}));
      } catch (error) {
        session = await updateSession(id, old => ({...old, lastError:errorCode(error)}));
      }
    }
    return session;
  });
}

export async function pay(): Promise<SaveSession> {
  const id = await saveId();
  return withSessionLock(id, async () => {
    let session = await readSession(id);
    if (!session) throw Error('archive_required');
    if (session.state === 'SOLANA_PENDING') return checkSolana(session);
    if (!['READY', 'SOLANA_PREPARED'].includes(session.state)) return session;
    if (session.solanaAttempted) throw Error('payment_requires_reconciliation');
    const wallet = phantom();
    await wallet.connect();
    if (wallet.publicKey?.toBase58() !== P.payer) throw Error('wrong_phantom_account');
    const rpc = solanaReader(); await assertDevnet(rpc);
    const [latest, slot] = await Promise.all([rpc.getLatestBlockhash('finalized'), rpc.getSlot('finalized')]);
    const tx = buildPayment(session, latest.blockhash);
    session = await updateSession(id, old => ({...old, state:'SOLANA_PREPARED', solanaBlockhash:latest.blockhash,
      solanaLastValidBlockHeight:latest.lastValidBlockHeight, solanaPreparedSlot:slot, lastError:undefined}));
    session = await updateSession(id, old => ({...old, state:'SOLANA_PENDING', solanaAttempted:true}));
    try {
      const response = await wallet.signAndSendTransaction(tx);
      const signature = typeof response === 'string' ? response : response.signature;
      if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) throw Error('invalid_phantom_signature');
      session = await updateSession(id, old => ({...old, solanaSignature:signature}));
      if (wallet.publicKey?.toBase58() !== P.payer) {
        return updateSession(id, old => ({...old, state:'BLOCKED', lastError:'phantom_account_changed'}));
      }
    } catch (error) {
      if (isUserRejection(error)) {
        // Explicit wallet rejection before broadcast can be retried with the same session/reference.
        return updateSession(id, old => ({...old, state:'READY', solanaAttempted:false,
          solanaRejected:true, lastError:'phantom_rejected'}));
      }
      await updateSession(id, old => ({...old, lastError:errorCode(error)}));
      return (await readSession(id))!;
    }
    try { return await checkSolana(session); }
    catch (error) { return updateSession(id, old => ({...old, lastError:errorCode(error)})); }
  });
}

export async function prepareArweave(): Promise<{session: SaveSession; reward: string}> {
  const id = await saveId();
  return withSessionLock(id, async () => {
    let session = await readSession(id);
    if (!session || !['SOLANA_PAID', 'AR_READY'].includes(session.state)) throw Error('solana_payment_required');
    const wallet = wander();
    await wallet.connect(['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION']);
    const address = await wallet.getActiveAddress();
    const quote = await quoteArchive(address, session.archiveBytes);
    if (session.state === 'SOLANA_PAID') session = await updateSession(id, old => ({...old, state:'AR_READY'}));
    if (session.arSigningStarted) throw Error('ar_signature_requires_reconciliation');
    return {session, reward:quote.reward};
  });
}

async function continueUpload(session: SaveSession): Promise<SaveSession> {
  const id = session.saveId;
  if (session.state === 'AR_SIGNED') session = await updateSession(id, old => ({...old, state:'AR_UPLOADING'}));
  try {
    await uploadSigned(session, async progress => {
      session = await updateSession(id, old => ({...old, arUploadProgress:progress}));
    });
    return updateSession(id, old => ({...old, state:'AR_PENDING_CONFIRMATION', lastError:undefined}));
  } catch (error) {
    return updateSession(id, old => ({...old, lastError:errorCode(error)}));
  }
}

export async function saveToArweave(expectedReward: string): Promise<SaveSession> {
  const id = await saveId();
  return withSessionLock(id, async () => {
    let session = await readSession(id);
    if (!session || session.state !== 'AR_READY' || session.arSigningStarted) throw Error('ar_not_ready');
    const wallet = wander();
    if (await wallet.getActiveAddress() !== P.arReserve) throw Error('wrong_wander_address');
    // This durable flag prevents a second signature if the browser loses the wallet response.
    session = await updateSession(id, old => ({...old, arSigningStarted:true}));
    try {
      const signed = await signArchive(session, wallet, expectedReward);
      session = await updateSession(id, old => ({...old, state:'AR_SIGNED',
        arTransactionId:signed.id, arSignedTransaction:signed.signed, arRewardWinston:signed.reward}));
    } catch (error) {
      if (isUserRejection(error)) return updateSession(id, old => ({...old, arSigningStarted:false, lastError:'wander_rejected'}));
      return updateSession(id, old => ({...old, state:'BLOCKED', lastError:errorCode(error)}));
    }
    return continueUpload(session);
  });
}
