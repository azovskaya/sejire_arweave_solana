import type Transaction from 'arweave/web/lib/transaction';
import { directCrypto, requireDirectTags } from '../directArweave/transaction';
import { active, assertDirectNetwork, nodeRequest } from '../directArweave/network';
import type { DirectRawTransaction, DirectWallet } from '../directArweave/types';
import type { TreasuryTopup } from './adminClient';
import { readTransferAttempt, withTransferLock, writeTransferAttempt, type TransferAttempt, type TransferWire } from './treasuryTransferStore';

export type TransferQuote = { ownerAddress: string; rewardWinston: string; balanceWinston: string; node: string; quotedAt: number };
export type TransferAuthority = {
  read(signal?: AbortSignal): Promise<TransferWire | null>;
  claim(input: { claimId: string; unsignedTx: string }, signal?: AbortSignal): Promise<{ transfer: TransferWire; reused: boolean }>;
  signed(input: { claimId: string; signedTx: string }, signal?: AbortSignal): Promise<{ transfer: TransferWire; reused: boolean }>;
};
export type TransferOptions = { signal?: AbortSignal; nodes?: readonly string[]; walletTimeoutMs?: number };
const NODES = ['https://arweave.net', 'https://g8way.io'] as const;
const money = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
function assertIntent(intent: TreasuryTopup) {
  if (!/^[a-f0-9]{32}$/.test(intent.id) || !id(intent.address) || !money(intent.amountWinston) || intent.amountWinston === '0' ||
      intent.status !== 'prepared' || intent.transferTag?.name !== 'SEJIRE-Topup-Intent' || !/^[a-f0-9]{64}$/.test(intent.transferTag.value)) throw Error('topup_transfer_invalid');
}
/** Only called following the owner's explicit connect action; merely viewing admin never probes a wallet. */
export function topupWallet(): DirectWallet {
  const wallet = (window as unknown as { arweaveWallet?: DirectWallet }).arweaveWallet;
  if (!wallet || !['connect', 'getActiveAddress', 'getActivePublicKey', 'sign'].every(key => typeof wallet[key as keyof DirectWallet] === 'function')) throw Error('wallet_unavailable');
  return wallet;
}
async function walletCall<T>(action: () => Promise<T>, signal?: AbortSignal, timeoutMs = 60000): Promise<T> {
  active(signal);
  let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(Error('operation_cancelled')); timer = setTimeout(() => reject(Error('topup_signature_pending')), timeoutMs); });
  signal?.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([Promise.resolve().then(() => { active(signal); return action(); }), stopped]); }
  finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
async function quoteAt(intent: TreasuryTopup, ownerAddress: string, options: TransferOptions): Promise<TransferQuote> {
  if (!id(ownerAddress) || ownerAddress === intent.address) throw Error('wallet_changed');
  let failure: unknown = Error('network_unavailable');
  for (const node of options.nodes ?? NODES) {
    active(options.signal);
    try {
      await assertDirectNetwork(node, options.signal);
      const [fee, balance] = await Promise.all([
        nodeRequest(node, `/price/0/${intent.address}`, { signal: options.signal, maxBytes: 128 }),
        nodeRequest(node, `/wallet/${ownerAddress}/balance`, { signal: options.signal, maxBytes: 128 }),
      ]);
      if (fee.status !== 200 || balance.status !== 200 || !money(fee.text.trim()) || fee.text.trim() === '0' || !money(balance.text.trim())) throw Error('network_unavailable');
      const rewardWinston = fee.text.trim(), balanceWinston = balance.text.trim();
      if (BigInt(balanceWinston) < BigInt(rewardWinston) + BigInt(intent.amountWinston)) throw Error('insufficient_ar');
      return { ownerAddress, rewardWinston, balanceWinston, node, quotedAt: Date.now() };
    } catch (error) { failure = error; }
  }
  active(options.signal); throw failure;
}
export async function quoteTreasuryTransfer(intent: TreasuryTopup, wallet: DirectWallet, options: TransferOptions = {}): Promise<TransferQuote> {
  assertIntent(intent);
  await walletCall(() => wallet.connect(['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION'], { name: 'SEJIRE — пополнение фонда AR' }), options.signal);
  const address = await walletCall(() => wallet.getActiveAddress(), options.signal);
  return quoteAt(intent, address, options);
}
function rawTransaction(value: unknown): DirectRawTransaction {
  const candidate = value as { toJSON?: () => DirectRawTransaction };
  const raw = typeof value === 'string' ? JSON.parse(value) : candidate && typeof candidate.toJSON === 'function' ? candidate.toJSON() : value;
  const fields = ['format', 'id', 'last_tx', 'owner', 'tags', 'target', 'quantity', 'data', 'data_size', 'data_root', 'reward', 'signature'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => ![...fields, 'data_tree'].includes(key)) ||
      !fields.every(key => Object.hasOwn(raw, key)) || raw.format !== 2 || typeof raw.id !== 'string' || typeof raw.signature !== 'string' ||
      typeof raw.owner !== 'string' || !/^[A-Za-z0-9_-]{683}$/.test(raw.owner) || typeof raw.last_tx !== 'string' ||
      !/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})$/.test(raw.last_tx) || !id(raw.target) || !money(raw.quantity) || raw.quantity === '0' ||
      !money(raw.reward) || raw.reward === '0' || raw.data !== '' || raw.data_size !== '0' || raw.data_root !== '' ||
      !Array.isArray(raw.tags) || raw.tags.length > 3 || raw.tags.some((tag: { name?: unknown; value?: unknown }) =>
        !tag || typeof tag.name !== 'string' || typeof tag.value !== 'string' || tag.name.length > 128 || tag.value.length > 512) ||
      raw.data_tree !== undefined && (!Array.isArray(raw.data_tree) || raw.data_tree.length !== 0)) throw Error('topup_transfer_invalid');
  return Object.fromEntries(fields.map(key => [key, raw[key]])) as DirectRawTransaction;
}
export async function verifyTreasuryTransaction(intent: TreasuryTopup, value: unknown, unsigned?: string): Promise<Transaction> {
  const raw = rawTransaction(value), ar = directCrypto(), tx = ar.transactions.fromRaw(raw);
  if (tx.target !== intent.address || tx.quantity !== intent.amountWinston || !intent.transferTag) throw Error('topup_transfer_invalid');
  const sender = await ar.wallets.ownerToAddress(tx.owner);
  if (!id(sender) || sender === intent.address) throw Error('topup_transfer_invalid');
  requireDirectTags(tx.tags.map(tag => ({ name: tag.get('name', { decode: true, string: true }), value: tag.get('value', { decode: true, string: true }) })), [intent.transferTag]);
  if (unsigned !== undefined) {
    const original = rawTransaction(unsigned);
    if (['format', 'last_tx', 'owner', 'target', 'quantity', 'reward', 'data_size', 'data_root', 'data'].some(key => raw[key as keyof DirectRawTransaction] !== original[key as keyof DirectRawTransaction]) ||
        !id(tx.id) || !/^[A-Za-z0-9_-]{683}$/.test(tx.signature) || !await ar.transactions.verify(tx)) throw Error('topup_transfer_invalid');
  } else if (tx.id !== '' || tx.signature !== '') throw Error('topup_transfer_invalid');
  return tx;
}
function sameWire(a: TransferWire, b: TransferWire, signed = false) {
  return a.claimId === b.claimId && a.unsignedTx === b.unsignedTx && (!signed || a.signedTx === b.signedTx && a.txId === b.txId);
}
export async function recoverTreasuryTransfer(intent: TreasuryTopup, authority: TransferAuthority, signal?: AbortSignal): Promise<{ local: TransferAttempt | null; remote: TransferWire | null }> {
  const remote = await authority.read(signal); active(signal);
  return withTransferLock(intent.id, async () => {
    let local = await readTransferAttempt(intent.id);
    if (local) {
      await verifyTreasuryTransaction(intent, local.unsignedTx);
      if (local.signedTx) { const tx = await verifyTreasuryTransaction(intent, local.signedTx, local.unsignedTx); if (tx.id !== local.txId) throw Error('topup_transfer_invalid'); }
    }
    if (remote) {
      await verifyTreasuryTransaction(intent, remote.unsignedTx);
      if (remote.signedTx) { const tx = await verifyTreasuryTransaction(intent, remote.signedTx, remote.unsignedTx); if (tx.id !== remote.txId) throw Error('topup_transfer_invalid'); }
      if (local && !sameWire(local, remote) || local?.signedTx && remote.signedTx && !sameWire(local, remote, true)) throw Error('topup_transfer_conflict');
      if (remote.signedTx && !local?.signedTx) local = await writeTransferAttempt(local, { ...(local ?? { schema: 'sejire/treasury-transfer/v1', id: intent.id,
        revision: 0, createdAt: Date.now(), submissionStarted: false, acknowledged: false }), ...remote, walletInvoked: true });
    } else if (local) throw Error('topup_transfer_conflict');
    return { local, remote };
  });
}
/** Server claim and local intent commit before the extension is invoked. It NEVER broadcasts. */
export async function signTreasuryTransfer(intent: TreasuryTopup, quote: TransferQuote, wallet: DirectWallet, authority: TransferAuthority, options: TransferOptions = {}): Promise<TransferAttempt> {
  assertIntent(intent);
  const prepared = await withTransferLock(intent.id, async () => {
    if (await readTransferAttempt(intent.id) || await authority.read(options.signal)) throw Error('topup_signature_pending');
    active(options.signal);
    if (Date.now() < quote.quotedAt || Date.now() - quote.quotedAt > 60000) throw Error('quote_expired');
    if (await walletCall(() => wallet.getActiveAddress(), options.signal) !== quote.ownerAddress) throw Error('wallet_changed');
    const fresh = await quoteAt(intent, quote.ownerAddress, options);
    if (fresh.rewardWinston !== quote.rewardWinston) throw Error('quote_changed');
    const owner = await walletCall(() => wallet.getActivePublicKey(), options.signal), ar = directCrypto();
    if (await ar.wallets.ownerToAddress(owner) !== quote.ownerAddress) throw Error('wallet_changed');
    const anchor = await nodeRequest(fresh.node, '/tx_anchor', { signal: options.signal, maxBytes: 128 });
    if (anchor.status !== 200 || !/^(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{64})$/.test(anchor.text.trim())) throw Error('network_unavailable');
    const tx = await ar.createTransaction({ target: intent.address, quantity: intent.amountWinston, owner, reward: fresh.rewardWinston, last_tx: anchor.text.trim() });
    tx.addTag(intent.transferTag!.name, intent.transferTag!.value);
    const unsignedTx = JSON.stringify(rawTransaction(tx)); await verifyTreasuryTransaction(intent, unsignedTx);
    const candidate: TransferAttempt = { schema: 'sejire/treasury-transfer/v1', id: intent.id, claimId: randomId(), unsignedTx,
      signedTx: null, txId: null, walletInvoked: false, submissionStarted: false, acknowledged: false, revision: 0, createdAt: Date.now() };
    let local = await writeTransferAttempt(null, candidate); active(options.signal);
    const claimed = await authority.claim({ claimId: local.claimId, unsignedTx }, options.signal); active(options.signal);
    if (claimed.reused || !sameWire(local, claimed.transfer)) throw Error('topup_signature_pending');
    const readback = await authority.read(options.signal); active(options.signal);
    if (!readback || !sameWire(local, readback) || readback.signedTx) throw Error('topup_transfer_conflict');
    if (await walletCall(() => wallet.getActiveAddress(), options.signal) !== quote.ownerAddress) throw Error('wallet_changed');
    local = await writeTransferAttempt(local, { ...local, walletInvoked: true }); active(options.signal);
    let signing: Promise<unknown>; try { signing = Promise.resolve(wallet.sign(tx)); } catch (error) { signing = Promise.reject(error); }
    return { local, signing };
  });
  // Even after unmount/timeout, a returned valid signature is saved locally. No
  // credential is retained by this callback and no network write follows it.
  const completed = prepared.signing.then(async result => {
    const tx = await verifyTreasuryTransaction(intent, result, prepared.local.unsignedTx);
    return withTransferLock(intent.id, async () => {
      const latest = await readTransferAttempt(intent.id);
      if (!latest || !sameWire(prepared.local, latest) || latest.signedTx) throw Error('topup_transfer_conflict');
      return writeTransferAttempt(latest, { ...latest, signedTx: JSON.stringify(rawTransaction(tx)), txId: tx.id });
    });
  }).catch(() => { throw Error('topup_signature_pending'); });
  void completed.catch(() => {});
  // Attach the completion before racing cancellation, so late signatures always
  // have a storage handler and no unhandled wallet rejection can leak details.
  return walletCall(() => completed, options.signal, options.walletTimeoutMs ?? 60000);
}
/** A signed attempt is durable on the operator before any network submission. */
export async function syncTreasuryTransfer(intent: TreasuryTopup, authority: TransferAuthority, signal?: AbortSignal): Promise<TransferAttempt> {
  return withTransferLock(intent.id, async () => {
    const local = await readTransferAttempt(intent.id);
    if (!local?.signedTx || !local.txId) throw Error('topup_signature_pending');
    await verifyTreasuryTransaction(intent, local.signedTx, local.unsignedTx); active(signal);
    const saved = await authority.signed({ claimId: local.claimId, signedTx: local.signedTx }, signal); active(signal);
    if (!sameWire(local, saved.transfer, true)) throw Error('topup_transfer_conflict');
    const readback = await authority.read(signal); active(signal);
    if (!readback || !sameWire(local, readback, true)) throw Error('admin_readback_mismatch');
    return local;
  });
}
/** Repeated calls only submit these immutable signed bytes; never request a signature. */
export async function submitTreasuryTransfer(intent: TreasuryTopup, authority: TransferAuthority, options: TransferOptions = {}): Promise<TransferAttempt> {
  assertIntent(intent);
  await syncTreasuryTransfer(intent, authority, options.signal);
  return withTransferLock(intent.id, async () => {
    let local = await readTransferAttempt(intent.id);
    if (!local?.signedTx || !local.txId) throw Error('topup_signature_pending');
    await verifyTreasuryTransaction(intent, local.signedTx, local.unsignedTx); active(options.signal);
    const signedBytes = local.signedTx;
    local = await writeTransferAttempt(local, { ...local, submissionStarted: true });
    let last: unknown = Error('topup_submission_unknown');
    for (const node of options.nodes ?? NODES) {
      active(options.signal);
      try {
        await assertDirectNetwork(node, options.signal);
        const response = await nodeRequest(node, '/tx', { signal: options.signal, body: signedBytes });
        if (![200, 202, 208].includes(response.status)) throw Error('topup_submission_unknown');
        active(options.signal); return writeTransferAttempt(local, { ...local, acknowledged: true });
      } catch (error) { last = error; }
    }
    active(options.signal); throw last;
  });
}
