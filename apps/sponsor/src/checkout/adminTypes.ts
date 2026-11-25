/** Public admin projections only; never import server runtime from the browser. */
export type AdminPaidOrder={id:string;kind:'preservation'|'contribution';network:'devnet'|'mainnet-beta';createdAt:number;updatedAt:number;
  paymentStatus:string;storageStatus:string;serviceLamports:string;contributionLamports:string;
  signature?:string;arweaveTxId?:string;archiveBytes?:number;rewardWinston?:string};
export type AdminPaidTotal={network:'devnet'|'mainnet-beta';totalOrders:number;paymentConfirmed:number;storageCompleted:number;pending:number;failed:number;serviceLamports:string;contributionLamports:string};
export type AdminPaidOverview={schema:'sejire/admin-paid-orders/v1';checkedAt:number;configuredNetwork:'devnet'|'mainnet-beta'|null;
  policy:{serviceLamports:string;serviceRecipient:string|null;fundRecipient:string|null;paymentEnabled:boolean;executionEnabled:boolean;maxArchiveBytes:number|null};
  totals:AdminPaidTotal[];orders:AdminPaidOrder[];hasMore:boolean;cursor:string|null};
export type TreasurySnapshot={address:string;revision:number;ceilingWinston:string|null;heldWinston:string;unobservedDebitWinston:string};
export type TreasuryTransferAttempt={claimId:string;unsignedTx:string;signedTx:string|null;txId:string|null};
export type TreasuryTopup={id:string;address:string;amountWinston:string;status:'prepared'|'credited';baselineHeight:number;
  priorCeilingWinston:string;preparedRevision:number;createdAt:number;txId:string|null;creditedWinston:string|null;
  creditedRevision:number|null;confirmedAt:number|null;transferTag:{name:'SEJIRE-Topup-Intent';value:string}|null};
export type TreasuryTopups={schema:'sejire/treasury-topups/v1';checkedAt:number;minimumConfirmations:number;treasuries:TreasurySnapshot[];intents:TreasuryTopup[];hasMore:boolean;cursor:string|null};
