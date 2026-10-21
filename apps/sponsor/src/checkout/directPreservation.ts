import { MAX_BACKUP_BYTES, parseEnvelope, serializeEnvelope } from '../../../web/src/lib/crypto/envelope';
import {
  createArweaveWebClient, FUND_CHECK_TIMEOUT_MS, readArweaveArchive, readArweaveTransaction,
} from '../fund/provider';

export type DirectArchive = { digest: string; bytes: number; vaultId: string; parentTxId: string | null };
export type DirectInput = { orderId: string; serialized: string; archive: DirectArchive };
export type DirectPolicy = {
  treasuryAddress: string;
  network: 'arweave.N.1';
  maxArchiveBytes: number;
  maxRewardWinston: string;
};
type PlanBinding = {
  orderId: string;
  archive: DirectArchive;
  network: 'arweave.N.1';
  treasuryAddress: string;
  rewardWinston: string;
  raw: string;
};
export type PreparedDirectPlan = PlanBinding & { schema: 'sejire/arweave-direct/prepared/v1' };
export type SignedDirectPlan = PlanBinding & { schema: 'sejire/arweave-direct/signed/v1'; id: string };
export type DirectCheck = {
  txId: string;
  state: 'not_found' | 'pending' | 'confirmed' | 'unavailable';
  onchainConfirmed: boolean;
  archiveVerified: boolean;
  rewardWinston: string | null;
  confirmations: number | null;
  reason: 'network_pending' | 'network_unavailable' | 'transaction_mismatch' | 'archive_unavailable' | 'archive_verification_failed' | null;
  checkedAt: number;
};
export type DirectOptions = { deadline?: number; signal?: AbortSignal };
type Operation = { deadline: number; signal: AbortSignal; close: () => void };
type Tag = { name: string; value: string };

const hosts = ['https://arweave.net', 'https://g8way.io'] as const;
const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const requestTimeout = 8_000;
const transactionKeys = ['format', 'id', 'last_tx', 'owner', 'tags', 'target', 'quantity', 'data', 'data_size', 'data_root', 'reward', 'signature'];

function encode64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode64(value: unknown, bytes?: number): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw Error('direct_invalid_encoding');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const result = Uint8Array.from(raw, char => char.charCodeAt(0));
  if (bytes !== undefined && result.length !== bytes || encode64(result) !== value) throw Error('direct_invalid_encoding');
  return result;
}

function isId(value: unknown): value is string {
  try { return typeof value === 'string' && decode64(value, 32).length === 32; } catch { return false; }
}

function amount(value: unknown, allowZero = false): bigint {
  if (typeof value !== 'string' || !(allowZero ? /^(0|[1-9][0-9]{0,29})$/ : /^[1-9][0-9]{0,29}$/).test(value)) throw Error('direct_invalid_amount');
  return BigInt(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function address(owner: string): Promise<string> {
  return encode64(new Uint8Array(await crypto.subtle.digest('SHA-256', decode64(owner, 512))));
}

function sameArchive(a: DirectArchive, b: DirectArchive): boolean {
  return Boolean(a && a.digest === b.digest && a.bytes === b.bytes && a.vaultId === b.vaultId && a.parentTxId === b.parentTxId);
}

function operation(options: DirectOptions = {}): Operation {
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + FUND_CHECK_TIMEOUT_MS);
  if (!Number.isFinite(deadline) || deadline <= Date.now() || options.signal?.aborted) throw Error('direct_operation_cancelled');
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, deadline - Date.now());
  return {
    deadline, signal: controller.signal,
    close() { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort(); },
  };
}

function active(op: Operation): void {
  if (op.signal.aborted || Date.now() >= op.deadline) throw Error('direct_operation_cancelled');
}

async function cancel(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* already consumed/closed */ }
}

/** Headers and the entire body share the request cap and enclosing operation deadline. */
async function request(transport: typeof fetch, url: string, init: RequestInit, max: number, op: Operation): Promise<{ status: number; text: string }> {
  active(op);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
    rejectAbort(Error('direct_network_unavailable'));
  };
  op.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(requestTimeout, op.deadline - Date.now()));
  const read = async () => {
    const options = { ...init, redirect: 'manual' as const, credentials: 'omit' as const, referrerPolicy: 'no-referrer' as const, signal: controller.signal };
    const response = await transport(url, options);
    if (controller.signal.aborted || response.url && response.url !== url || response.status >= 300 && response.status < 400) {
      await cancel(response); throw Error('direct_network_unavailable');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > max)) {
      await cancel(response); throw Error('direct_response_too_large');
    }
    if (!response.body) return { status: response.status, text: '' };
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw Error('direct_network_unavailable');
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > max) { await reader.cancel(); throw Error('direct_response_too_large'); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); reader = undefined; }
    const body = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { status: response.status, text: utf8.decode(body) };
  };
  try { return await Promise.race([read(), aborted]); }
  finally { clearTimeout(timer); op.signal.removeEventListener('abort', abort); controller.abort(); }
}

/** This object is constructed from a server policy snapshot, never from request-selected URLs or recipients. */
export class DirectArweavePreservation {
  readonly #policy: Readonly<DirectPolicy>;
  readonly #key: Record<string, string> | null;
  readonly #executionEnabled: boolean;
  readonly #transport: typeof fetch;

  constructor(options: { secret?: string; policy: DirectPolicy; executionEnabled?: boolean; transport?: typeof fetch }) {
    const policy = { ...options.policy };
    if (policy.network !== 'arweave.N.1' || !isId(policy.treasuryAddress) ||
        !Number.isSafeInteger(policy.maxArchiveBytes) || policy.maxArchiveBytes < 1 || policy.maxArchiveBytes > MAX_BACKUP_BYTES) throw Error('direct_policy_invalid');
    amount(policy.maxRewardWinston);
    this.#policy = Object.freeze(policy);
    this.#executionEnabled = options.executionEnabled === true;
    const transport = options.transport ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init));
    this.#transport = (input, init) => transport(input, init);
    try {
      const key = options.secret ? JSON.parse(options.secret) : null;
      if (key !== null && (!key || typeof key !== 'object' || Array.isArray(key) || key.kty !== 'RSA')) throw Error('invalid');
      this.#key = key;
    } catch {
      // A damaged/missing signer binding prevents new readiness/signatures, but
      // cannot erase the read-only obligation for an already signed paid job.
      this.#key = null;
    }
  }

  async #signer(): Promise<string> {
    try {
      if (!this.#key || this.#key.e !== 'AQAB') throw Error('invalid');
      for (const name of ['n', 'd', 'p', 'q', 'dp', 'dq', 'qi']) decode64(this.#key[name]);
      const signerAddress = await address(this.#key.n);
      if (signerAddress !== this.#policy.treasuryAddress) throw Error('invalid');
      await crypto.subtle.importKey('jwk', { ...this.#key, kty: 'RSA' }, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
      return signerAddress;
    } catch { throw Error('direct_signer_unavailable'); }
  }

  #bytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.#policy.maxArchiveBytes) throw Error('direct_archive_size_invalid');
  }

  #reward(reward: string): void {
    if (amount(reward) > amount(this.#policy.maxRewardWinston)) throw Error('direct_reward_limit');
  }

  async #read<T>(path: string, max: number, parse: (value: string) => T, op: Operation): Promise<T> {
    active(op);
    const reads = operation({ deadline: op.deadline, signal: op.signal });
    try {
      return await Promise.any(hosts.map(async host => {
        const response = await request(this.#transport, `${host}${path}`, { method: 'GET' }, max, reads);
        if (response.status !== 200) throw Error('direct_network_unavailable');
        return parse(response.text);
      }));
    } catch { throw Error('direct_network_unavailable'); }
    finally { reads.close(); }
  }

  async #network(op: Operation): Promise<void> {
    await this.#read('/info', 16_384, text => {
      if (JSON.parse(text)?.network !== 'arweave.N.1') throw Error('invalid');
    }, op);
  }

  async #balance(op: Operation): Promise<string> {
    return this.#read(`/wallet/${this.#policy.treasuryAddress}/balance`, 64, text => {
      const value = text.trim(); amount(value, true); return value;
    }, op);
  }

  async #price(bytes: number, op: Operation): Promise<string> {
    this.#bytes(bytes);
    const reward = await this.#read(`/price/${bytes}`, 64, text => { const value = text.trim(); amount(value); return value; }, op);
    this.#reward(reward); return reward;
  }

  async getBalance(options: DirectOptions = {}): Promise<string> {
    const op = operation(options);
    try { return await this.#balance(op); } finally { op.close(); }
  }

  async getPrice(bytes: number, options: DirectOptions = {}): Promise<string> {
    const op = operation(options);
    try { return await this.#price(bytes, op); } finally { op.close(); }
  }

  async ready(bytes: number, options: DirectOptions = {}): Promise<{ signerAddress: string; balanceWinston: string; rewardWinston: string; checkedAt: number }> {
    this.#bytes(bytes);
    const op = operation(options);
    try {
      const signerAddress = await this.#signer(); active(op);
      const [balanceWinston, rewardWinston] = await Promise.all([this.#balance(op), this.#price(bytes, op), this.#network(op)]);
      active(op);
      if (amount(balanceWinston, true) < amount(rewardWinston)) throw Error('direct_balance_low');
      return { signerAddress, balanceWinston, rewardWinston, checkedAt: Date.now() };
    } finally { op.close(); }
  }

  async #input(input: DirectInput): Promise<{ input: DirectInput; bytes: Uint8Array; tags: Tag[] }> {
    if (!input || typeof input.orderId !== 'string' || !/^[a-f0-9]{32}$/.test(input.orderId) || typeof input.serialized !== 'string' || !input.archive) throw Error('direct_archive_mismatch');
    const snapshot: DirectInput = { orderId: input.orderId, serialized: input.serialized, archive: { ...input.archive } };
    this.#bytes(snapshot.archive.bytes);
    if (!/^[a-f0-9]{64}$/.test(snapshot.archive.digest) || !/^[a-f0-9]{32}$/.test(snapshot.archive.vaultId) ||
        snapshot.archive.parentTxId !== null && !isId(snapshot.archive.parentTxId) || snapshot.serialized.length > this.#policy.maxArchiveBytes) throw Error('direct_archive_mismatch');
    const bytes = encoder.encode(snapshot.serialized);
    if (bytes.length !== snapshot.archive.bytes || await sha256(bytes) !== snapshot.archive.digest) throw Error('direct_archive_mismatch');
    const envelope = parseEnvelope(JSON.parse(snapshot.serialized));
    if (serializeEnvelope(envelope) !== snapshot.serialized || envelope.vault_id !== snapshot.archive.vaultId) throw Error('direct_archive_mismatch');
    const tags: Tag[] = [
      { name: 'App-Name', value: 'SEJIRE' }, { name: 'Type', value: 'vault-envelope' },
      { name: 'Schema', value: envelope.schema }, { name: 'Protocol-Version', value: envelope.protocol },
      { name: 'Vault-Id', value: snapshot.archive.vaultId }, { name: 'Archive-SHA256', value: snapshot.archive.digest },
      { name: 'Archive-Bytes', value: String(bytes.length) }, { name: 'Preservation-Id', value: snapshot.orderId },
      ...(snapshot.archive.parentTxId === null ? [] : [{ name: 'Parent-Tx', value: snapshot.archive.parentTxId }]),
    ];
    return { input: snapshot, bytes, tags };
  }

  async #plan(input: DirectInput, plan: PreparedDirectPlan | SignedDirectPlan, signed: boolean) {
    const checked = await this.#input(input);
    try {
      if (!plan || plan.schema !== (signed ? 'sejire/arweave-direct/signed/v1' : 'sejire/arweave-direct/prepared/v1') ||
          plan.orderId !== checked.input.orderId || !sameArchive(plan.archive, checked.input.archive) ||
          plan.network !== this.#policy.network || plan.treasuryAddress !== this.#policy.treasuryAddress ||
          typeof plan.raw !== 'string' || plan.raw.length > Math.ceil(checked.bytes.length * 4 / 3) + 16_384) throw Error('invalid');
      this.#reward(plan.rewardWinston);
      const raw = JSON.parse(plan.raw) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || JSON.stringify(raw) !== plan.raw ||
          Object.keys(raw).some(key => !transactionKeys.includes(key)) ||
          raw.format !== 2 || raw.quantity !== '0' || raw.target !== '' || raw.reward !== plan.rewardWinston ||
          raw.data !== encode64(checked.bytes) || raw.data_size !== String(checked.bytes.length) ||
          typeof raw.owner !== 'string' || await address(raw.owner) !== this.#policy.treasuryAddress) throw Error('invalid');
      const anchor = decode64(raw.last_tx); if (![32, 48].includes(anchor.length)) throw Error('invalid');
      const tags = checked.tags.map(tag => ({ name: encode64(encoder.encode(tag.name)), value: encode64(encoder.encode(tag.value)) }));
      if (JSON.stringify(raw.tags) !== JSON.stringify(tags)) throw Error('invalid');
      if (signed) {
        const signedPlan = plan as SignedDirectPlan;
        if (!isId(signedPlan.id) || raw.id !== signedPlan.id) throw Error('invalid');
        decode64(raw.signature, 512);
      } else if (raw.id !== '' || raw.signature !== '') throw Error('invalid');
      const ar = createArweaveWebClient(), tx = ar.transactions.fromRaw(raw);
      // SDK verification signs data_root, not data. Recompute the Merkle root
      // from the exact persisted ciphertext before trusting either raw object.
      await tx.prepareChunks(checked.bytes);
      if (raw.data_root !== tx.data_root || !isId(raw.data_root)) throw Error('invalid');
      if (signed && !await ar.transactions.verify(tx)) throw Error('invalid');
      return { ...checked, tx, raw, ar };
    } catch { throw Error('direct_plan_mismatch'); }
  }

  async prepare(input: DirectInput, options: DirectOptions = {}): Promise<PreparedDirectPlan> {
    const op = operation(options);
    try {
      const checked = await this.#input(input);
      await this.#signer(); active(op);
      const [rewardWinston, anchor] = await Promise.all([
        this.#price(checked.bytes.length, op),
        this.#read('/tx_anchor', 128, text => {
          const value = text.trim(), bytes = decode64(value);
          if (![32, 48].includes(bytes.length)) throw Error('invalid'); return value;
        }, op),
        this.#network(op),
      ]);
      active(op);
      const ar = createArweaveWebClient();
      // Supplying all four fields prevents hidden SDK quote/anchor requests.
      const tx = await ar.createTransaction({ data: checked.bytes, owner: this.#key!.n, reward: rewardWinston, last_tx: anchor });
      for (const tag of checked.tags) tx.addTag(tag.name, tag.value);
      const plan: PreparedDirectPlan = { schema: 'sejire/arweave-direct/prepared/v1', orderId: checked.input.orderId,
        archive: checked.input.archive, network: 'arweave.N.1', treasuryAddress: this.#policy.treasuryAddress,
        rewardWinston, raw: JSON.stringify(tx.toJSON()) };
      await this.#plan(checked.input, plan, false); active(op);
      return plan;
    } finally { op.close(); }
  }

  async sign(input: DirectInput, prepared: PreparedDirectPlan, options: DirectOptions = {}): Promise<SignedDirectPlan> {
    if (!this.#executionEnabled) throw Error('direct_execution_disabled');
    const op = operation(options);
    try {
      // Copy the durable object before awaits; callers cannot replace its raw or
      // reward while the signer is validating the immutable job.
      const snapshot = { ...prepared, archive: { ...prepared.archive } };
      const checked = await this.#plan(input, snapshot, false);
      await this.#signer(); active(op);
      await checked.ar.transactions.sign(checked.tx, this.#key);
      const signed: SignedDirectPlan = { ...snapshot, schema: 'sejire/arweave-direct/signed/v1', id: checked.tx.id, raw: JSON.stringify(checked.tx.toJSON()) };
      await this.#plan(checked.input, signed, true); active(op);
      return signed;
    } finally { op.close(); }
  }

  /** The caller must durably commit signed.raw and signed.id before this method. */
  async submit(input: DirectInput, signed: SignedDirectPlan, options: DirectOptions = {}): Promise<{ id: string; accepted: true }> {
    if (!this.#executionEnabled) throw Error('direct_execution_disabled');
    const op = operation(options);
    try {
      const snapshot = { ...signed, archive: { ...signed.archive } };
      const checked = await this.#plan(input, snapshot, true); active(op);
      const post = async (path: '/tx' | '/chunk', body: string) => {
        active(op);
        const response = await request(this.#transport, `${hosts[0]}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        }, 16_384, op);
        if (![200, 202, 208].includes(response.status)) throw Error('direct_submit_uncertain');
      };
      try {
        const chunks = checked.tx.chunks.chunks.length;
        // Same SDK wire format: one-chunk archives travel in /tx. Larger ones
        // retain the exact signed header, then upload deterministic Merkle chunks.
        await post('/tx', chunks <= 1 ? snapshot.raw : JSON.stringify({ ...checked.raw, data: '' }));
        for (let index = 0; index < chunks && chunks > 1; index += 2) {
          await Promise.all(Array.from({ length: Math.min(2, chunks - index) }, (_, offset) =>
            post('/chunk', JSON.stringify(checked.tx.getChunk(index + offset, checked.bytes)))));
        }
        active(op);
        return { id: snapshot.id, accepted: true };
      } catch { throw Error('direct_submit_uncertain'); }
    } finally { op.close(); }
  }

  /** Read-only, including when signing is paused or the secret is unavailable. */
  async reconcile(input: DirectInput, signed: SignedDirectPlan, options: DirectOptions = {}): Promise<DirectCheck> {
    const op = operation(options);
    try {
      const snapshot = { ...signed, archive: { ...signed.archive } };
      const checked = await this.#plan(input, snapshot, true); active(op);
      const { data: _data, ...metadata } = checked.raw;
      let transaction;
      try {
        transaction = await readArweaveTransaction(snapshot.id, { treasuryAddress: this.#policy.treasuryAddress,
          expected: metadata, deadline: op.deadline, signal: op.signal, transport: this.#transport });
      } catch (error) {
        return { txId: snapshot.id, state: 'unavailable', onchainConfirmed: false, archiveVerified: false,
          rewardWinston: null, confirmations: null, checkedAt: Date.now(),
          reason: error instanceof Error && error.message === 'transaction_mismatch' ? 'transaction_mismatch' : 'network_unavailable' };
      }
      const proof: DirectCheck = { txId: snapshot.id, state: transaction.state, onchainConfirmed: transaction.confirmed,
        archiveVerified: false, rewardWinston: transaction.reward, confirmations: transaction.confirmations,
        checkedAt: Date.now(), reason: 'network_pending' };
      if (!transaction.confirmed) return proof;
      // Metadata already matches the signed ID, owner, reward, all recovery tags,
      // Parent-Tx and data_root. Its on-chain spend survives a gateway outage.
      try {
        const bytes = await readArweaveArchive(snapshot.id, checked.input.archive, { maxBytes: this.#policy.maxArchiveBytes,
          deadline: op.deadline, signal: op.signal, transport: this.#transport });
        proof.archiveVerified = bytes !== null;
        proof.reason = bytes ? null : 'archive_unavailable';
      } catch (error) {
        proof.reason = error instanceof Error && error.message === 'archive_integrity_failed' ? 'archive_verification_failed' : 'archive_unavailable';
      }
      proof.checkedAt = Date.now();
      return proof;
    } finally { op.close(); }
  }
}
