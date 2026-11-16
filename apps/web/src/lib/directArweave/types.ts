import type Transaction from 'arweave/web/lib/transaction';
import type { EnvelopeV1 } from '../crypto/encrypt';

export type DirectState = 'prepared' | 'signing' | 'signed' | 'uploading' | 'confirming' | 'complete' | 'blocked' | 'cancelled';
export type DirectErrorCode =
  | 'invalid_archive' | 'archive_too_large' | 'invalid_operation' | 'operation_missing'
  | 'storage_unavailable' | 'storage_conflict' | 'browser_locks_required' | 'pending_direct_operation'
  | 'invalid_node' | 'network_unavailable' | 'network_rate_limited' | 'wrong_network' | 'operation_cancelled'
  | 'wallet_unavailable' | 'wallet_changed' | 'wallet_rejected' | 'signature_pending' | 'signature_invalid'
  | 'quote_required' | 'quote_changed' | 'quote_expired' | 'insufficient_ar' | 'invalid_reward'
  | 'upload_pending' | 'confirmation_pending' | 'archive_unavailable' | 'archive_integrity_failed'
  | 'receipt_invalid' | 'not_complete';

/** Any compatible injected Arweave wallet. No private key or dispatch permission. */
export type DirectWallet = {
  connect(permissions: string[], appInfo?: { name: string }): Promise<void>;
  getActiveAddress(): Promise<string>;
  getActivePublicKey(): Promise<string>;
  sign(transaction: unknown): Promise<unknown>;
};
export type DirectQuote = {
  ownerAddress: string;
  rewardWinston: string;
  balanceWinston: string;
  bytes: number;
  node: string;
  quotedAt: number;
};
export type DirectVerification = {
  checkedAt: number;
  confirmed: boolean;
  confirmations: number | null;
  bytesVerified: boolean;
  node: string | null;
};
export type DirectRawTransaction = ReturnType<Transaction['toJSON']>;
export type DirectOperation = {
  schema: 'sejire/direct-arweave-operation/v1';
  id: string;
  vaultId: string;
  treeId: string | null;
  parentTxId: string | null;
  archiveText: string;
  archiveDigest: string;
  archiveBytes: number;
  state: DirectState;
  ownerAddress: string | null;
  quote: DirectQuote | null;
  /** Committed before the wallet prompt. A missing response never permits a fresh signature. */
  signingIntent: { id: string; startedAt: number; unsignedTx: DirectRawTransaction } | null;
  signedTx: DirectRawTransaction | null;
  txId: string | null;
  uploadProgress: { node: string | null; headerAccepted: boolean; uploadedChunks: number; totalChunks: number };
  verification: DirectVerification | null;
  lastError: DirectErrorCode | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
};
export type DirectArchiveInput = { envelope: EnvelopeV1; treeId?: string | null; parentTxId?: string | null };
export type DirectOptions = {
  /** Optional credential-free HTTPS node origins, in priority order. */
  nodes?: readonly string[];
  signal?: AbortSignal;
};
export type DirectReceipt = {
  schema: 'sejire/direct-arweave-receipt/v1';
  protocol: 'sejire/v0.3';
  encryption: 'sejire/envelope/v1';
  network: 'arweave.N.1';
  transactionId: string;
  vaultId: string;
  parentTxId: string | null;
  archiveDigest: string;
  archiveBytes: number;
  ownerAddress: string;
  rewardWinston: string;
  createdAt: string;
};
/** Ciphertext and signed native transaction only. No mnemonic or wallet private key. */
export type DirectOperationPackage = { schema: 'sejire/direct-arweave-package/v1'; operation: DirectOperation };
