import { DirectError, directErrorCode, requireDirect } from './errors';
import { sha256, verifyArchiveBinding, winston } from './format';
import { requireOperation, withDirectLock, withPreservationGuard, writeDirectOperation } from './journal';
import { active, assertDirectNetwork, directNodes, fetchArchiveBytes, fetchDirectQuote, nodeRequest, scoped } from './network';
import { matchesPublicHeader, prepareDirectTransaction, verifyDirectSigned } from './transaction';
import type { DirectOperation, DirectOptions, DirectWallet } from './types';

async function walletRead<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  active(signal);
  let rejectAborted: (error: DirectError) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const abort = () => rejectAborted(new DirectError('operation_cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([Promise.resolve().then(() => { active(signal); return action(); }), aborted]); }
  finally { signal?.removeEventListener('abort', abort); }
}
export function directWallet(): DirectWallet {
  const wallet = typeof window !== 'undefined' ? (window as Window & { arweaveWallet?: DirectWallet }).arweaveWallet : undefined;
  requireDirect(wallet && typeof wallet.connect === 'function' && typeof wallet.getActiveAddress === 'function' &&
    typeof wallet.getActivePublicKey === 'function' && typeof wallet.sign === 'function', 'wallet_unavailable');
  return wallet;
}
export async function quoteDirectOperation(id: string, address: string, options: DirectOptions = {}): Promise<DirectOperation> {
  return withPreservationGuard(() => withDirectLock(id, () => scoped(options, async signalOptions => {
    const operation = await requireOperation(id); await verifyArchiveBinding(operation);
    requireDirect(operation.state === 'prepared' && !operation.signingIntent && !operation.signedTx, 'signature_pending');
    const quote = await fetchDirectQuote(address, operation.archiveBytes, signalOptions);
    return writeDirectOperation(operation, { ...operation, ownerAddress: address, quote,
      lastError: winston(quote.balanceWinston) < winston(quote.rewardWinston) ? 'insufficient_ar' : null });
  })));
}
export async function signDirectOperation(id: string, wallet: DirectWallet, expectedRewardWinston: string, options: DirectOptions = {}): Promise<DirectOperation> {
  const prepared = await withPreservationGuard(() => withDirectLock(id, () => scoped(options, async signalOptions => {
    let operation = await requireOperation(id); await verifyArchiveBinding(operation);
    requireDirect(operation.state === 'prepared' && !operation.signingIntent && !operation.signedTx, 'signature_pending');
    const quote = operation.quote; requireDirect(quote && operation.ownerAddress, 'quote_required');
    requireDirect(winston(expectedRewardWinston) === winston(quote.rewardWinston), 'quote_changed');
    requireDirect(Date.now() >= quote.quotedAt && Date.now() - quote.quotedAt <= 60_000, 'quote_expired');
    await walletRead(() => wallet.connect(['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION'], { name: 'SEJIRE' }), signalOptions.signal);
    requireDirect(await walletRead(() => wallet.getActiveAddress(), signalOptions.signal) === operation.ownerAddress, 'wallet_changed');
    const current = await fetchDirectQuote(operation.ownerAddress, operation.archiveBytes, signalOptions);
    requireDirect(current.rewardWinston === expectedRewardWinston, 'quote_changed');
    requireDirect(winston(current.balanceWinston) >= winston(current.rewardWinston), 'insufficient_ar');
    const tx = await prepareDirectTransaction(operation, current, await walletRead(() => wallet.getActivePublicKey(), signalOptions.signal), signalOptions.signal);
    requireDirect(await walletRead(() => wallet.getActiveAddress(), signalOptions.signal) === operation.ownerAddress, 'wallet_changed'); active(signalOptions.signal);
    const intent = { id: await sha256(crypto.getRandomValues(new Uint8Array(32))), startedAt: Date.now(), unsignedTx: tx.toJSON() };
    operation = await writeDirectOperation(operation, { ...operation, quote: current, signingIntent: intent, state: 'signing', lastError: null });
    if (signalOptions.signal?.aborted) {
      // The wallet method has not been invoked: this boundary is known, not an
      // uncertain signature. Restore a cancellable preparation under both locks.
      await writeDirectOperation(operation, { ...operation, state: 'prepared', signingIntent: null, lastError: 'operation_cancelled' },
        { unrequestedSignatureReset: true });
      throw new DirectError('operation_cancelled');
    }
    // The returned promise is a field, so locks release before the late-result writer runs.
    // No dispatch() or upload occurs in this call.
    let signing: Promise<unknown>;
    try { signing = Promise.resolve(wallet.sign(tx)); } catch (error) { signing = Promise.reject(error); }
    return { operation, intent, signing };
  })));
  const completion = prepared.signing.then(async result => {
    const tx = await verifyDirectSigned(prepared.operation, result);
    const totalChunks = tx.chunks?.chunks.length;
    requireDirect(totalChunks && totalChunks <= 41, 'signature_invalid');
    return withDirectLock(id, async () => {
      const latest = await requireOperation(id);
      requireDirect(latest.signingIntent?.id === prepared.intent.id && !latest.signedTx && latest.state === 'signing', 'storage_conflict');
      return writeDirectOperation(latest, { ...latest, signedTx: tx.toJSON(), txId: tx.id, state: 'signed', lastError: null,
        uploadProgress: { node: null, headerAccepted: false, uploadedChunks: 0, totalChunks } });
    });
  }).catch(async error => withDirectLock(id, async () => {
    const latest = await requireOperation(id);
    if (latest.signingIntent?.id !== prepared.intent.id || latest.signedTx) return latest;
    const rejected = typeof error === 'object' && error !== null && 'code' in error && error.code === 4001;
    const code = directErrorCode(error, 'signature_pending');
    if (code === 'storage_unavailable' || code === 'storage_conflict') throw error;
    return writeDirectOperation(latest, { ...latest,
      state: rejected ? 'prepared' : code === 'signature_invalid' || code === 'invalid_operation' ? 'blocked' : 'signing',
      signingIntent: rejected ? null : latest.signingIntent,
      lastError: rejected ? 'wallet_rejected' : code === 'signature_invalid' || code === 'invalid_operation' ? 'signature_invalid' : 'signature_pending' });
  }));
  // A timeout returns control to the UI but does not discard a later wallet result.
  // Its validated signed bytes are still durably journaled, without uploading.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<DirectOperation>((resolve, reject) => {
    timer = setTimeout(() => {
      void withDirectLock(id, async () => {
        const latest = await requireOperation(id);
        return latest.state === 'signing' ? writeDirectOperation(latest, { ...latest, lastError: 'signature_pending' }) : latest;
      }).then(resolve, reject);
    }, 60_000);
  });
  try { return await Promise.race([completion, pending]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function checkUnlocked(operation: DirectOperation, options: DirectOptions): Promise<DirectOperation> {
  if (!operation.signedTx || !operation.txId) return operation;
  await verifyDirectSigned(operation);
  let confirmed = false, confirmations: number | null = null, statusNode: string | null = null;
  let last: DirectError = new DirectError('confirmation_pending');
  for (const node of directNodes(options)) {
    active(options.signal);
    try {
      await assertDirectNetwork(node, options.signal);
      const [status, header] = await Promise.all([
        nodeRequest(node, `/tx/${operation.txId}/status`, { signal: options.signal }),
        nodeRequest(node, `/tx/${operation.txId}`, { signal: options.signal, maxBytes: 32_768 + Math.ceil(operation.archiveBytes * 4 / 3) }),
      ]);
      if (status.status !== 200 || header.status !== 200) continue;
      requireDirect(matchesPublicHeader(JSON.parse(header.text), operation.signedTx), 'archive_integrity_failed');
      const proof = JSON.parse(status.text) as { number_of_confirmations?: number; block_height?: number; block_indep_hash?: string };
      requireDirect(Number.isSafeInteger(proof.number_of_confirmations) && proof.number_of_confirmations! >= 1 &&
        Number.isSafeInteger(proof.block_height) && proof.block_height! >= 0 && typeof proof.block_indep_hash === 'string' &&
        /^[A-Za-z0-9_-]{43,64}$/.test(proof.block_indep_hash), 'confirmation_pending');
      confirmed = true; confirmations = proof.number_of_confirmations!; statusNode = node; break;
    } catch (error) { last = new DirectError(directErrorCode(error)); }
  }
  let bytesVerified = false;
  if (confirmed) {
    try { await fetchArchiveBytes(operation.txId, { bytes: operation.archiveBytes, sha256: operation.archiveDigest }, options); bytesVerified = true; }
    catch (error) { last = new DirectError(directErrorCode(error, 'archive_unavailable')); }
  }
  active(options.signal);
  const complete = confirmed && bytesVerified;
  return writeDirectOperation(operation, { ...operation, state: complete ? 'complete' : operation.state,
    verification: !complete && operation.state === 'complete' ? operation.verification :
      { checkedAt: Date.now(), confirmed, confirmations, bytesVerified, node: statusNode },
    lastError: complete ? null : confirmed && last.code === 'confirmation_pending' ? 'archive_unavailable' : last.code });
}
export async function checkDirectOperation(id: string, options: DirectOptions = {}): Promise<DirectOperation> {
  return withDirectLock(id, () => scoped(options, async signalOptions => checkUnlocked(await requireOperation(id), signalOptions)));
}
export async function resumeDirectOperation(id: string, options: DirectOptions = {}): Promise<DirectOperation> {
  return withDirectLock(id, () => scoped(options, async signalOptions => {
    let operation = await requireOperation(id);
    requireDirect(operation.signedTx && operation.txId && ['signed', 'uploading', 'confirming', 'complete'].includes(operation.state), 'signature_pending');
    const tx = await verifyDirectSigned(operation);
    const totalChunks = tx.chunks?.chunks.length;
    requireDirect(totalChunks && totalChunks <= 41, 'signature_invalid');
    let replay = false;
    const historicallyComplete = operation.state === 'complete';
    if (operation.state === 'confirming' || historicallyComplete) {
      operation = await checkUnlocked(operation, signalOptions);
      // Explicit resume may repair missing bytes of this already paid native tx.
      // A mere read/check never writes chunks. Require a fresh exact-header proof.
      replay = operation.lastError === 'archive_unavailable' && operation.verification?.confirmed === true;
      if (!replay) return operation;
      operation = await writeDirectOperation(operation, { ...operation,
        uploadProgress: { node: null, headerAccepted: true, uploadedChunks: 0, totalChunks } });
    }
    const nodes = directNodes(signalOptions), previousNode = operation.uploadProgress.node;
    const ordered = previousNode && nodes.includes(previousNode) ? [previousNode, ...nodes.filter(node => node !== previousNode)] : nodes;
    let last: DirectError = new DirectError('upload_pending');
    for (const node of ordered) {
      active(signalOptions.signal);
      try {
        await assertDirectNetwork(node, signalOptions.signal);
        if (operation.uploadProgress.node !== node) {
          operation = await writeDirectOperation(operation, { ...operation, state: historicallyComplete ? 'complete' : replay ? 'confirming' : 'uploading',
            lastError: historicallyComplete ? operation.lastError ?? 'archive_unavailable' : null,
            uploadProgress: { node, headerAccepted: replay, uploadedChunks: 0, totalChunks } });
        }
        if (!operation.uploadProgress.headerAccepted) {
          // Never take arweave-js's one-chunk inline shortcut: header acceptance is not data acceptance.
          const response = await nodeRequest(node, '/tx', { signal: signalOptions.signal, body: JSON.stringify({ ...operation.signedTx, data: '' }) });
          requireDirect([200, 202, 208].includes(response.status), 'upload_pending');
          operation = await writeDirectOperation(operation, { ...operation,
            uploadProgress: { ...operation.uploadProgress, headerAccepted: true } });
        }
        for (let index = operation.uploadProgress.uploadedChunks; index < totalChunks; index++) {
          active(signalOptions.signal);
          const response = await nodeRequest(node, '/chunk', { signal: signalOptions.signal, body: JSON.stringify(tx.getChunk(index, tx.data)) });
          requireDirect([200, 202, 208].includes(response.status), 'upload_pending');
          operation = await writeDirectOperation(operation, { ...operation,
            uploadProgress: { ...operation.uploadProgress, uploadedChunks: index + 1 } });
        }
        operation = await writeDirectOperation(operation, { ...operation, state: historicallyComplete ? 'complete' : 'confirming',
          lastError: historicallyComplete ? operation.lastError ?? 'archive_unavailable' : null });
        return checkUnlocked(operation, signalOptions);
      } catch (error) {
        const code = directErrorCode(error, 'upload_pending');
        if (code === 'storage_unavailable' || code === 'storage_conflict' || code === 'signature_invalid' || code === 'invalid_operation') throw error;
        last = new DirectError(code);
        active(signalOptions.signal);
      }
    }
    return writeDirectOperation(operation, { ...operation, lastError: last.code });
  }));
}
