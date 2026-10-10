import {parseEnvelope} from '../crypto/envelope';
import {openEnvelope} from '../crypto/vault';
import type {SejireKeys} from '../crypto/keys';
import {coerceTreeStore} from '../treeJson';
import {RecoveryFailure} from './errors';
import {tagValue,type TxMetadata} from './retrieve';
import type {HeadCandidate,VerifiedVersion} from './types';

export async function verifyCandidate(bytes:Uint8Array,meta:TxMetadata,candidate:HeadCandidate,keys:SejireKeys):Promise<VerifiedVersion>{
  let envelope;
  try {envelope=parseEnvelope(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
  catch{throw new RecoveryFailure('RAW_HASH_MISMATCH');}
  if(envelope.vault_id!==keys.vaultId)throw new RecoveryFailure('VAULT_ID_MISMATCH');
  let vault;
  try {vault=await openEnvelope(keys,envelope);}catch{throw new RecoveryFailure('DECRYPT_FAILED');}
  if(vault.schema!=='sejire/vault/v1'||vault.vault_id!==keys.vaultId||!vault.trees||typeof vault.trees!=='object'||Array.isArray(vault.trees))throw new RecoveryFailure('INVALID_VAULT');
  const trees=Object.entries(vault.trees);if(!trees.length)throw new RecoveryFailure('INVALID_VAULT');
  for(const [id,tree] of trees)if(!coerceTreeStore(tree)||id==='__proto__'||id==='constructor')throw new RecoveryFailure('INVALID_VAULT');
  if(vault.active_tree_id!==null&&!Object.hasOwn(vault.trees,vault.active_tree_id))throw new RecoveryFailure('INVALID_VAULT');
  if(vault.active_tree_id===null)vault={...vault,active_tree_id:trees[0][0]};
  return {txId:candidate.txId,vault,parentTxId:tagValue(meta,'Parent-Tx'),blockHeight:meta.blockHeight??candidate.blockHeight??null,
    blockTimestamp:meta.blockTimestamp??candidate.blockTimestamp??null,sources:candidate.source.split(',')};
}
