import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { PRESERVATION_V2_PILOT_POLICY as P } from './policy';
import type { SaveSession } from './types';
import { withTimeout } from './timeout';

export type PhantomProvider = {
  isPhantom?: boolean; publicKey?: PublicKey;
  connect(): Promise<{publicKey: PublicKey}>;
  signAndSendTransaction(tx: Transaction): Promise<{signature: string} | string>;
};
export function phantom(): PhantomProvider {
  const provider = (window as Window & {solana?: PhantomProvider; phantom?: {solana?: PhantomProvider}}).phantom?.solana ??
    (window as Window & {solana?: PhantomProvider}).solana;
  if (!provider?.isPhantom || !provider.signAndSendTransaction) throw Error('phantom_unavailable');
  return provider;
}

export const SOLANA_RPC_URLS = [
  'https://api.devnet.solana.com',
  'https://solana-devnet.api.onfinality.io/public',
  'https://solana-devnet.drpc.org',
];
export type SolanaReader = {
  getGenesisHash(): Promise<string>;
  getLatestBlockhash(commitment?: 'finalized'): Promise<{blockhash: string; lastValidBlockHeight: number}>;
  getBlockHeight(commitment?: 'finalized'): Promise<number>;
  getSlot(commitment?: 'finalized'): Promise<number>;
  getMinimumLedgerSlot(): Promise<number>;
  getSignaturesForAddress(address: PublicKey, options?: {limit?: number}, commitment?: 'finalized'): Promise<Array<{signature: string; err: unknown}>>;
  getParsedTransaction(signature: string, options: {commitment: 'finalized'; maxSupportedTransactionVersion: 0}): Promise<Awaited<ReturnType<Connection['getParsedTransaction']>>>;
};
export function solanaReader(url = SOLANA_RPC_URLS[0]): SolanaReader { return new Connection(url, 'finalized'); }
export async function assertDevnet(rpc: SolanaReader): Promise<void> {
  if (await rpc.getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw Error('wrong_solana_network');
}

export function buildPayment(session: SaveSession, blockhash: string): Transaction {
  if (session.payer !== P.payer || session.archiveDigest !== P.archiveDigest) throw Error('payment_policy_mismatch');
  const payer = new PublicKey(P.payer);
  const transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(P.service), lamports: P.serviceLamports });
  transfer.keys.push({pubkey: new PublicKey(session.solanaReference), isSigner: false, isWritable: false});
  return new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({units: 200_000}),
    transfer,
  );
}

export type PaymentDiscovery = {signature?: string; failedSignatures: string[]; absent: boolean};
export async function discoverPayment(session: SaveSession, readers: SolanaReader[], readerTimeoutMs=15_000): Promise<PaymentDiscovery> {
  if (!session.solanaBlockhash || session.solanaLastValidBlockHeight === undefined)
    return {failedSignatures:[],absent:false};
  const results = await Promise.allSettled(readers.map(rpc=>withTimeout((async()=>{
    await assertDevnet(rpc);
    const [history, height, oldest] = await Promise.all([
      rpc.getSignaturesForAddress(new PublicKey(session.solanaReference), {limit: 1000}, 'finalized'),
      rpc.getBlockHeight('finalized'),
      rpc.getMinimumLedgerSlot(),
    ]);
    if (session.solanaPreparedSlot === undefined || oldest > session.solanaPreparedSlot || history.length >= 1000 ||
        (session.solanaFailedSignatures??[]).some(sig=>!history.some(x=>x.signature===sig&&x.err)))
      throw Error('reference_history_not_complete');
    return {history,height};
  })(),readerTimeoutMs,'solana_reader_timeout')));
  const valid = results.filter((r):r is PromiseFulfilledResult<{history:{signature:string;err:unknown}[];height:number}>=>r.status==='fulfilled').map(r=>r.value);
  if (valid.length < 2) throw Error('insufficient_solana_readers');
  const successful = [...new Set(valid.flatMap(r=>r.history).filter(x=>!x.err).map(x=>x.signature))];
  if (successful.length > 1) throw Error('conflicting_reference_history');
  const expired = valid.filter(r=>r.height > session.solanaLastValidBlockHeight!);
  const failedSets = expired.map(r=>r.history.filter(x=>x.err).map(x=>x.signature).sort());
  const agreed = failedSets.find(set=>failedSets.filter(other=>JSON.stringify(other)===JSON.stringify(set)).length>=2);
  return {signature:successful[0],failedSignatures:agreed??[],absent:!successful[0] && Boolean(agreed)};
}

export function isUserRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 4001;
}
