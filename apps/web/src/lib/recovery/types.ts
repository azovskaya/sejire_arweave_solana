import type { VaultV1 } from '../crypto/vault';

export type RecoveryErrorCode = 'INVALID_WORDS'|'NO_CANDIDATES'|'DISCOVERY_UNAVAILABLE'|'DATA_UNAVAILABLE'|'METADATA_MISMATCH'|'RAW_HASH_MISMATCH'|'VAULT_ID_MISMATCH'|'DECRYPT_FAILED'|'INVALID_VAULT'|'MULTIPLE_VERIFIED_HEADS'|'UNKNOWN_ERROR';
export type RecoveryStage = 'discover'|'found'|'download'|'verify'|'decrypt'|'open';
export type HeadCandidate = {txId:string;source:string;blockHeight?:number;blockTimestamp?:number;parentTxId?:string|null;archiveBytes?:number;archiveSha256?:string;legacy?:boolean};
export type DiscoveryResult = {status:'responded'|'unavailable';candidates:HeadCandidate[]};
export type RecoveryContext = {vaultId:string;signal:AbortSignal;fetcher:typeof fetch};
export interface HeadDiscoveryProvider {id:string;discover(ctx:RecoveryContext):Promise<DiscoveryResult>}
export type GatewayTarget = {url:string;source:string};
export interface GatewayPool {candidates(ctx:RecoveryContext):Promise<GatewayTarget[]>;markSuccess(url:string,ms:number):void;markFailure(url:string):void}
export type VerifiedVersion = {txId:string;vault:VaultV1;parentTxId:string|null;blockHeight:number|null;blockTimestamp:number|null;sources:string[]};
export type SafeRecoveryDiagnostics = {providers:{id:string;status:'responded'|'unavailable';count:number}[];gateways:{host:string;operation:'metadata'|'raw';status:string}[];candidateCount:number;verifiedCount:number;stage:RecoveryStage;code?:RecoveryErrorCode};
export type RecoveryResult =
  | {ok:true;vault:VaultV1;headTxId:string;versions:VerifiedVersion[];forks:VerifiedVersion[];code?:'MULTIPLE_VERIFIED_HEADS';diagnostics:SafeRecoveryDiagnostics}
  | {ok:false;code:RecoveryErrorCode;diagnostics:SafeRecoveryDiagnostics};
