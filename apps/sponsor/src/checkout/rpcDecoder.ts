import { assertBase58, assetFor, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../../../../packages/checkout/order';
import { assertUnits } from '../../../../packages/checkout/amounts';
import type { ChainPolicy, TransactionEvidence, Transfer } from './paymentValidator';
import { RpcEvidenceError } from './rpcErrors';

// Compiled instruction data, not parsed browser amounts or balance deltas.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
type Obj = Record<string, unknown>;
function fail(reason: ConstructorParameters<typeof RpcEvidenceError>[0] = 'rpc-malformed'): never { throw new RpcEvidenceError(reason); }
export function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Obj;
}
function list(value: unknown, limit = 256): unknown[] {
  if (!Array.isArray(value) || value.length > limit) fail();
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail();
  return value;
}
function address(value: unknown): string {
  if (typeof value !== 'string') fail();
  try { assertBase58(value, 32); } catch { fail(); }
  return value;
}
function dataBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > 32) fail('unsupported-transaction');
  let n = 0n;
  for (const char of value) { const d = ALPHABET.indexOf(char); if (d < 0) fail(); n = n * 58n + BigInt(d); }
  const tail: number[] = []; for (; n > 0n; n >>= 8n) tail.unshift(Number(n & 255n));
  return new Uint8Array([...new Array(value.match(/^1*/)?.[0].length ?? 0).fill(0), ...tail]);
}
function little(bytes: Uint8Array, start: number, count: number): bigint {
  let n = 0n; for (let i = start + count - 1; i >= start; i--) n = (n << 8n) + BigInt(bytes[i]); return n;
}

/** Supports encoding=json legacy/v0, direct System Transfer and classic SPL TransferChecked.
 * Pre-existing token accounts only. No ATA creation, token-2022, unchecked transfers, multisig,
 * delegate transfers, arbitrary CPI, memo, nonce, other programs or client normalized evidence.
 * Finality is supplied exclusively by the trusted transport's finalized RPC/status checks.
 */
export function decodeTransaction(result: unknown, signature: string, chain: ChainPolicy): TransactionEvidence {
  const tx = object(result);
  if (tx.version !== 'legacy' && tx.version !== 0) fail('unsupported-transaction');
  const meta = tx.meta === null || tx.meta === undefined ? fail('missing-metadata') : object(tx.meta);
  if (!Object.hasOwn(meta, 'err')) fail('missing-metadata');
  if (meta.err !== null) fail('transaction-failed');
  const inner = meta.innerInstructions === null || meta.innerInstructions === undefined ? fail('missing-metadata') : list(meta.innerInstructions);
  // Any recorded inner invocation is outside this checkout template, even an empty group.
  if (inner.length) fail('unsupported-transaction');
  const transaction = object(tx.transaction), message = object(transaction.message), header = object(message.header);
  const signatures = list(transaction.signatures, 1);
  if (signatures.length !== 1 || signatures[0] !== signature) fail('signature-mismatch');
  try { assertBase58(signature, 64); } catch { fail('signature-mismatch'); }
  const staticKeys = list(message.accountKeys).map(address);
  const required = integer(header.numRequiredSignatures, staticKeys.length);
  const readonlySigned = integer(header.numReadonlySignedAccounts, required);
  const readonlyUnsigned = integer(header.numReadonlyUnsignedAccounts, staticKeys.length - required);
  if (required !== 1 || readonlySigned !== 0 || staticKeys.length < 2) fail('unsupported-transaction');
  address(message.recentBlockhash);
  const loaded = tx.version === 0 ? object(meta.loadedAddresses ?? fail('missing-metadata')) : { writable: [], readonly: [] };
  if (tx.version === 'legacy' && meta.loadedAddresses !== undefined) {
    const legacyLoaded = object(meta.loadedAddresses);
    if (list(legacyLoaded.writable).length || list(legacyLoaded.readonly).length) fail('unsupported-transaction');
  }
  const writableLoaded = list(loaded.writable).map(address), readonlyLoaded = list(loaded.readonly).map(address);
  if (tx.version === 'legacy' && message.addressTableLookups !== undefined && list(message.addressTableLookups).length) fail();
  if (tx.version === 0) {
    const lookups = list(message.addressTableLookups);
    let writes = 0, reads = 0;
    for (const entry of lookups) {
      const lookup = object(entry); address(lookup.accountKey);
      const w = list(lookup.writableIndexes).map(v => integer(v, 255));
      const r = list(lookup.readonlyIndexes).map(v => integer(v, 255));
      if (new Set([...w, ...r]).size !== w.length + r.length) fail();
      writes += w.length; reads += r.length;
    }
    if (writes !== writableLoaded.length || reads !== readonlyLoaded.length) fail('missing-metadata');
  }
  const keys = [...staticKeys, ...writableLoaded, ...readonlyLoaded];
  if (keys.length > 256 || new Set(keys).size !== keys.length) fail();
  const writable = (index: number) => index < staticKeys.length ? index < staticKeys.length - readonlyUnsigned : index < staticKeys.length + writableLoaded.length;
  const keyIndex = (value: unknown) => integer(value, keys.length - 1);
  const preBalances = list(meta.preBalances), postBalances = list(meta.postBalances);
  if (preBalances.length !== keys.length || postBalances.length !== keys.length) fail('missing-metadata');
  // Monetary evidence comes from instruction u64 bytes. Never use potentially lossy JSON lamport balances.
  const payer = keys[0], tokenAsset = assetFor(chain.network, 'USDC');
  function tokenMetadata(value: unknown): Map<number, { owner: string; amount: string }> {
    const map = new Map<number, { owner: string; amount: string }>();
    for (const item of list(value ?? fail('missing-metadata'))) {
      const balance = object(item), index = keyIndex(balance.accountIndex), amount = object(balance.uiTokenAmount);
      if (map.has(index) || balance.mint !== tokenAsset.mint || balance.programId !== TOKEN_PROGRAM || amount.decimals !== 6) fail('unsupported-transaction');
      if (typeof amount.amount !== 'string') fail();
      try { assertUnits(amount.amount); } catch { fail(); }
      map.set(index, { owner: address(balance.owner), amount: amount.amount });
    }
    return map;
  }
  let tokenPre: ReturnType<typeof tokenMetadata> | undefined, tokenPost: ReturnType<typeof tokenMetadata> | undefined;
  const transfers: Transfer[] = [], computeSeen = new Set<number>();
  const instructions = list(message.instructions, 4);
  if (!instructions.length) fail('unsupported-transaction');
  for (let i = 0; i < instructions.length; i++) {
    const ix = object(instructions[i]), program = keys[keyIndex(ix.programIdIndex)];
    if (ix.stackHeight !== undefined && ix.stackHeight !== null && ix.stackHeight !== 1) fail('unsupported-transaction');
    const accounts = list(ix.accounts, 5).map(keyIndex), bytes = dataBytes(ix.data);
    if (program === COMPUTE_BUDGET) {
      const op = bytes[0];
      if (accounts.length || transfers.length || computeSeen.has(op)) fail('unsupported-transaction');
      if (op === 2 && bytes.length === 5 && little(bytes, 1, 4) > 0n && little(bytes, 1, 4) <= 1400000n) computeSeen.add(op);
      else if (op === 3 && bytes.length === 9) computeSeen.add(op);
      else fail('unsupported-transaction');
      continue;
    }
    let sender: string, recipient: string, amount: string, refs: number[];
    if (program === SYSTEM_PROGRAM) {
      if (bytes.length !== 12 || little(bytes, 0, 4) !== 2n || accounts.length !== 3 || accounts[0] !== 0 || !writable(accounts[1])) fail('unsupported-transaction');
      sender = payer; recipient = keys[accounts[1]]; amount = little(bytes, 4, 8).toString(); refs = accounts.slice(2);
    } else if (program === TOKEN_PROGRAM) {
      if (bytes.length !== 10 || bytes[0] !== 12 || bytes[9] !== 6 || accounts.length !== 5 || accounts[3] !== 0 || keys[accounts[1]] !== tokenAsset.mint || !writable(accounts[0]) || !writable(accounts[2])) fail('unsupported-transaction');
      tokenPre ??= tokenMetadata(meta.preTokenBalances); tokenPost ??= tokenMetadata(meta.postTokenBalances);
      const source = tokenPre.get(accounts[0]), destination = tokenPre.get(accounts[2]);
      if (!source || !destination || source.owner !== payer || tokenPost.get(accounts[0])?.owner !== source.owner || tokenPost.get(accounts[2])?.owner !== destination.owner) fail('missing-metadata');
      sender = source.owner; recipient = destination.owner; amount = little(bytes, 1, 8).toString(); refs = accounts.slice(4);
    } else fail('unsupported-transaction');
    if (refs.some(index => index === 0 || writable(index)) || new Set(accounts).size !== accounts.length || amount === '0') fail('unsupported-transaction');
    transfers.push({ instruction: String(i), sender, recipient, amount,
      asset: program === SYSTEM_PROGRAM ? assetFor(chain.network, 'SOL') : tokenAsset, references: refs.map(index => keys[index]) });
    if (transfers.length > 2) fail('unsupported-transaction');
  }
  if (!transfers.length) fail('unsupported-transaction');
  if (tx.blockTime === null || tx.blockTime === undefined) fail('missing-metadata');
  const blockTimeMs = integer(tx.blockTime) * 1000;
  if (!Number.isSafeInteger(blockTimeMs)) fail();
  const fee = integer(meta.fee);
  return { signature, network: chain.network, genesisHash: chain.genesisHash, commitment: 'finalized', error: null,
    slot: integer(tx.slot), blockTimeMs, feeLamports: String(fee), feePayer: payer, signers: [payer], transfers };
}
