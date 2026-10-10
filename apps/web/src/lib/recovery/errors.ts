import type {RecoveryErrorCode} from './types';
export class RecoveryFailure extends Error {
  readonly code:RecoveryErrorCode;
  constructor(code:RecoveryErrorCode){super(code);this.name='RecoveryFailure';this.code=code;}
}
