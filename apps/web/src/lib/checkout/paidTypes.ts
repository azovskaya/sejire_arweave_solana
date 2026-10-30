import type { PaidOrder, PaidPreservationOrder, PaidArchiveBinding } from '../../../../../packages/checkout/order';
import type { CheckoutPolicy, ContributionPolicy, PaidPolicy, DurablePaymentPreparation, PaidReceipt } from '../../../../../packages/checkout/paid';
import type { EnvelopeV1 } from '../crypto/encrypt';

export type PaidPolicyResponse = {
  ready: boolean;
  reason?: string;
  policy?: PaidPolicy;
  policyHash?: string;
  contributionReady?: boolean;
  contributionReason?: string;
  contributionPolicy?: ContributionPolicy;
  contributionPolicyHash?: string;
};
export type PaidCreationCancellation = { schema: 'sejire/paid-request-cancellation/v1'; status: 'cancelled'; key: string };
export type PaidSnapshot = {
  record: {
    order: PaidOrder;
    pendingSignature?: string;
    payment?: { signature: string; feeLamports: string };
    states: { payment: string; contribution: string; preservation: string };
  };
  policy: CheckoutPolicy;
  verification?: { status: string; reason?: string } | null;
  preparation?: DurablePaymentPreparation | null;
  expired?: boolean;
  cancelled?: boolean;
  execution: null | {
    kind: 'arweave-direct';
    txId: string | null;
    status: 'queued' | 'signed' | 'submitted' | 'confirming' | 'completed' | 'requires-reconciliation';
    reason?: string;
    verification: null | {
      transactionConfirmed: boolean;
      archiveVerified: boolean;
      owner: string;
      rewardWinston: string;
      archive: PaidArchiveBinding;
    };
    receipt?: PaidReceipt;
  };
};

/** One immutable archive, policy, payer and idempotency key per paid attempt. */
export type PaidOperation = {
  version: 2;
  id: string;
  revision: number;
  token: string;
  createdAt: number;
  treeId: string | null;
  serialized: string | null;
  archive: PaidArchiveBinding | null;
  policy: CheckoutPolicy;
  policyHash: string;
  intent: { kind: 'preservation' | 'contribution'; payer: string; contribution: string };
  createAttempted: boolean;
  order?: PaidOrder;
  snapshot?: PaidSnapshot;
  preparation?: DurablePaymentPreparation;
  /** Explicit owner request, persisted before a server-fenced preparation renewal. */
  recoveryRequestedFor?: string;
  signingStarted: boolean;
  signature?: string;
  signedTransaction?: string;
  cancellationRequested?: boolean;
  creationCancelled?: boolean;
  localCompletion: 'pending' | 'done' | 'released';
};

export type PaidInput =
  | { mode: 'create'; envelope: EnvelopeV1; treeId: string | null; parentTxId: string | null }
  | { mode: 'contribution' }
  | { mode: 'resume'; operationId: string };

export type PaidCompletion = {
  operationId: string;
  order: PaidPreservationOrder;
  serialized: string;
  envelope: EnvelopeV1;
  treeId: string | null;
  txId: string;
  paymentSignature: string;
  receipt: PaidReceipt;
};

/** Standalone SOL acknowledgement. It contains no vault/archive information. */
export type ContributionReceipt = {
  schema: 'sejire/contribution-receipt/v1';
  status: 'verified';
  orderId: string;
  network: CheckoutPolicy['network'];
  policyHash: string;
  paymentSignature: string;
  payer: string;
  fundRecipient: string;
  contributionLamports: string;
  serviceLamports: '0';
  feeLamports: string;
};
