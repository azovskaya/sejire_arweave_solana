// Local synthetic fixtures only. Product entrypoints never import this file.
import bs58 from 'bs58';
import { Keypair, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import { fixture } from './browser-fixture';
import { createPaidOrderFromPolicy, createPaymentPreparation, paidPolicyHash, SOLANA_GENESIS, type ContributionPolicy, type PaidPolicy } from '../../../packages/checkout/paid';
import { parseAmount } from '../../../packages/checkout/amounts';
import type { PaidArchiveBinding } from '../../../packages/checkout/order';
import type { PaidSnapshot } from '../src/lib/checkout/paidTypes';
import { readPaidOperation } from '../src/lib/checkout/paidJournal';

const address = (value: number) => bs58.encode(new Uint8Array(32).fill(value));
export const arOwner = btoa(String.fromCharCode(...new Uint8Array(512).fill(19))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function offeredPolicy() {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(512).fill(19)));
  const treasuryAddress = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const policy: PaidPolicy = { schema: 'sejire/checkout-policy/v1', version: 'synthetic-browser-v1', network: 'devnet', genesisHash: SOLANA_GENESIS.devnet,
    serviceLamports: '30000000', serviceRecipient: address(2), fundRecipient: address(3),
    storage: { kind: 'arweave-direct', network: 'arweave.N.1', treasuryAddress, budgetId: 'synthetic-browser', maxBytes: 524288, maxRewardWinston: '10000000000' } };
  const contributionPolicy: ContributionPolicy = { schema: 'sejire/contribution-policy/v1', version: policy.version,
    network: policy.network, genesisHash: policy.genesisHash, serviceLamports: '0', serviceRecipient: policy.serviceRecipient, fundRecipient: policy.fundRecipient };
  return { ready: true, policy, policyHash: await paidPolicyHash(policy), contributionReady: true,
    contributionPolicy, contributionPolicyHash: await paidPolicyHash(contributionPolicy) };
}
export async function initialSnapshot(body: { kind?: 'preservation' | 'contribution'; payer: string; contribution: string; archive?: PaidArchiveBinding }, index: number): Promise<PaidSnapshot> {
  const offered = await offeredPolicy(), kind = body.kind ?? 'preservation';
  const policy = kind === 'contribution' ? offered.contributionPolicy : offered.policy;
  const order = await createPaidOrderFromPolicy(policy, { id: index.toString(16).padStart(32, '0'), payer: body.payer, reference: address(4 + index),
    createdAt: Date.now() - 1, expiresAt: Date.now() + 300000, kind, ...(body.archive ? { archive: body.archive } : {}), contribution: parseAmount(body.contribution, 9) });
  return { record: { order, states: { payment: 'awaiting-payment', preservation: kind === 'contribution' ? 'not-applicable' : 'awaiting-payment', contribution: order.fundContribution.amount === '0' ? 'not-requested' : 'awaiting-payment' } },
    policy, preparation: null, execution: null, verification: null, expired: false, cancelled: false };
}
export const preparation = (snapshot: PaidSnapshot) => createPaymentPreparation(snapshot.record.order, { blockhash: address(8), lastValidBlockHeight: 100, feeLamports: '5000', createdAt: Date.now() });
export function completedSnapshot(snapshot: PaidSnapshot): PaidSnapshot {
  const s = structuredClone(snapshot), order = s.record.order, payment = s.record.payment;
  if (!payment || order.kind !== 'preservation') throw Error('Synthetic preservation payment missing');
  s.record.states.preservation = 'completed';
  s.execution = { kind: 'arweave-direct', txId: 'A'.repeat(43), status: 'completed',
    verification: { transactionConfirmed: true, archiveVerified: true, owner: order.storage.treasuryAddress, rewardWinston: '100', archive: order.archive },
    receipt: { schema: 'sejire/preservation-receipt/v2', status: 'confirmed-and-verified', orderId: order.id, policyHash: order.policyHash,
      paymentNetwork: order.network, paymentSignature: payment.signature, arweaveNetwork: 'arweave.N.1', txId: 'A'.repeat(43),
      archive: order.archive, treasuryAddress: order.storage.treasuryAddress, rewardWinston: '100', verifiedAt: Date.now() } };
  return s;
}
export async function family() { return fixture(); }
export function transfers(serialized: string) {
  return Transaction.from(Uint8Array.from(atob(serialized), char => char.charCodeAt(0))).instructions
    .filter(instruction => instruction.programId.equals(SystemProgram.programId))
    .map(instruction => { const transfer = SystemInstruction.decodeTransfer(instruction); return { recipient: transfer.toPubkey.toBase58(), lamports: transfer.lamports.toString() }; });
}
export function installWallet() {
  const key = Keypair.fromSeed(new Uint8Array(32).fill(17));
  const state = { signCount: 0, connects: 0, reject: false, unknown: false, changeMessage: false, account: key.publicKey,
    signature: '', key: '', closedDuringSign: false, hold: false, release: (() => {}) as () => void };
  const page = window as unknown as { paidWallet: typeof state; phantom: unknown; solflare: unknown; arweaveWallet: unknown };
  page.paidWallet = state;
  page.arweaveWallet = { connect() { throw Error('Unexpected treasury wallet'); }, sign() { throw Error('Unexpected AR signature'); } };
  const provider = {
    get publicKey() { return state.account; }, connect: async () => { state.connects++; },
    signMessage: async () => { throw Error('General paid flow must not sign messages'); },
    signAndSendTransaction: async () => { throw Error('General paid flow must reserve before broadcasting'); },
    signTransaction: async (transaction: Transaction) => {
      state.signCount++;
      const op = await readPaidOperation(state.key);
      if (!op?.signingStarted || op.signedTransaction) throw Error('Synthetic durable-before-wallet assertion failed');
      if (state.reject) throw Object.assign(Error('Synthetic rejection'), { code: 4001 });
      if (state.hold) await new Promise<void>(resolve => { state.release = resolve; });
      if (state.changeMessage) transaction.recentBlockhash = address(12);
      transaction.partialSign(key); state.signature = bs58.encode(transaction.signatures[0].signature!);
      if (state.unknown) throw Error('Synthetic unknown wallet response');
      return transaction;
    },
  };
  page.phantom = { solana: provider }; page.solflare = provider;
}
