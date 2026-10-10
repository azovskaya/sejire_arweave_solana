export type RpcFailure = 'rpc-timeout' | 'rpc-rate-limited' | 'rpc-server-error' | 'rpc-unavailable' |
  'rpc-malformed' | 'rpc-response-too-large' | 'wrong-network' | 'signature-mismatch' |
  'missing-metadata' | 'unsupported-transaction' | 'transaction-failed' | 'not-finalized';
type RpcDetails={httpStatus?:number;rpcCode?:number;retryAfterMs?:number};
export class RpcEvidenceError extends Error {
  readonly details?:RpcDetails;
  readonly reason: RpcFailure;
  constructor(reason: RpcFailure, details?:RpcDetails) { super(reason); this.reason = reason; this.details=details; this.name = 'RpcEvidenceError'; }
}
