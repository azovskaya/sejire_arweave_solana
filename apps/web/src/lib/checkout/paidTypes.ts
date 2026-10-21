import type { PaidOrder, PaidArchiveBinding } from '../../../../../packages/checkout/order';
import type { PaidPolicy, DurablePaymentPreparation, PaidReceipt } from '../../../../../packages/checkout/paid';
import type { EnvelopeV1 } from '../crypto/encrypt';

export type PaidPolicyResponse = { ready: boolean; reason?: string; policy?: PaidPolicy; policyHash?: string };
export type PaidCreationCancellation = { schema: 'sejire/paid-request-cancellation/v1'; status: 'cancelled'; key: string };
export type PaidSnapshot = {
  record: {
    order: PaidOrder;
    pendingSignature?: string;
    payment?: { signature: string; feeLamports: string };
    states: { payment: string; contribution: string; preservation: string };
  };
  policy: PaidPolicy;
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
  serialized: string;
  archive: PaidArchiveBinding;
  policy: PaidPolicy;
  policyHash: string;
  intent: { kind: 'preservation'; payer: string; contribution: string };
  createAttempted: boolean;
  order?: PaidOrder;
  snapshot?: PaidSnapshot;
  preparation?: DurablePaymentPreparation;
  signingStarted: boolean;
  signature?: string;
  signedTransaction?: string;
  cancellationRequested?: boolean;
  creationCancelled?: boolean;
  localCompletion: 'pending' | 'done' | 'released';
};

export type PaidInput =
  | { mode: 'create'; envelope: EnvelopeV1; treeId: string | null; parentTxId: string | null }
  | { mode: 'resume'; operationId: string };

export type PaidCompletion = {
  operationId: string;
  order: PaidOrder;
  serialized: string;
  envelope: EnvelopeV1;
  treeId: string | null;
  txId: string;
  paymentSignature: string;
  receipt: PaidReceipt;
};
