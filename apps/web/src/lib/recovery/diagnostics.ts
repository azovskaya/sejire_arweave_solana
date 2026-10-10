import type {SafeRecoveryDiagnostics} from './types';
export function newDiagnostics():SafeRecoveryDiagnostics {return {providers:[],gateways:[],candidateCount:0,verifiedCount:0,stage:'discover'};}
export function gatewayHost(url:string):string {try{return new URL(url).host;}catch{return 'invalid-host';}}
