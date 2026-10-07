import type { SerializedUploader } from 'arweave/web/lib/transaction-uploader';
import type Transaction from 'arweave/web/lib/transaction';

export type SaveState = 'READY' | 'SOLANA_PREPARED' | 'SOLANA_PENDING' | 'SOLANA_PAID' |
  'AR_READY' | 'AR_SIGNED' | 'AR_UPLOADING' | 'AR_PENDING_CONFIRMATION' | 'COMPLETE' | 'BLOCKED';

export type SaveSession = {
  schema: 'sejire/preservation-v2/v1';
  saveId: string; vaultId: string; archiveDigest: string; archiveBytes: number;
  archiveText: string; payer: string; solanaReference: string;
  solanaSignature?: string; solanaBlockhash?: string; solanaLastValidBlockHeight?: number;
  solanaFailedSignatures?: string[];
  solanaPreparedSlot?: number;
  solanaAttempted?: boolean; solanaRejected?: boolean;
  arTransactionId?: string; arSignedTransaction?: ReturnType<Transaction['toJSON']>;
  arRewardWinston?: string; arUploadProgress?: SerializedUploader;
  arSigningStarted?: boolean;
  state: SaveState; lastError?: string; createdAt: number; updatedAt: number; revision: number;
};

export type SolanaResult = { signature: string; finalized: boolean };
