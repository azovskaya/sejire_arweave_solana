import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';
import { canonical } from '../../../../../packages/protocol/wire';
import { assertBase58, type Network } from '../../../../../packages/checkout/order';
import { assertUnits, totalUnits } from '../../../../../packages/checkout/amounts';
import { MAX_BACKUP_BYTES } from '../crypto/envelope';
import { envelopeDigest } from '../solana/policy';
export const CONFIG_DOMAIN = 'sejire/config/v1';
export const GENESIS = { devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' } as const;
export type Signature = { publicKey: string; signature: string };
export type Config = {
 domain: typeof CONFIG_DOMAIN; project: 'SEJIRE'; version: number; previous: string | null; environment: Network;
 createdAt: number; nonce: string; serviceLamports: string;
 wallets: { service: string; fund: string; arReserve: string };
 managers: string[]; threshold: number;
 solanaRpcs: string[]; arweaveNodes: string[]; arweaveNetwork: 'arweave.N.1';
 upload: { maxBytes: number; maxRewardWinston: string; acceptingUntil: number };
 identifiers: { protocol: string | null; release: string | null };
};
export type SignedConfig = { config: Config; signatures: Signature[]; acceptance: Signature[] };
export type ConfigChain = { schema: 'sejire/config-chain/v1'; versions: SignedConfig[] };
export type MessageWallet = { publicKey: { toString(): string } | null; signMessage?: (bytes: Uint8Array) => Promise<Uint8Array> };
export function endpoint(value: string): string {
 const u = new URL(value);
 if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname)))) throw Error('invalid_public_endpoint');
 return u.origin;
}
export function exactKeys(value: object, keys: string[]) {
 if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw Error('unexpected_fields_or_secrets');
}
export function validateConfig(c: Config) {
 exactKeys(c, ['domain','project','version','previous','environment','createdAt','nonce','serviceLamports','wallets','managers','threshold','solanaRpcs','arweaveNodes','arweaveNetwork','upload','identifiers']);
 if (c.domain !== CONFIG_DOMAIN || c.project !== 'SEJIRE' || !GENESIS[c.environment] || !Number.isSafeInteger(c.version) || c.version < 1 || !Number.isSafeInteger(c.createdAt) || !/^[a-f0-9]{32}$/.test(c.nonce) || (c.previous !== null && !/^[a-f0-9]{64}$/.test(c.previous))) throw Error('invalid_configuration');
 if (assertUnits(c.serviceLamports) === 0n) throw Error('invalid_service_price');
 exactKeys(c.wallets, ['service','fund','arReserve']);
 if(c.environment==='mainnet-beta'&&[c.wallets.service,c.wallets.fund].some(k=>['Hn9ELgjKXrb7svZM9XtDYozGTirxo5e1tWRy1J1v4vwF','ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd','Gy3SSxP7spgDcserSfMckPd73LeSoxdrvXeNap7huLQN'].includes(k)))throw Error('devnet_wallet_cannot_be_mainnet_treasury');
 for (const k of [c.wallets.service,c.wallets.fund,...c.managers]) assertBase58(k,32);
 if (c.wallets.service === c.wallets.fund || !/^[A-Za-z0-9_-]{43}$/.test(c.wallets.arReserve)) throw Error('invalid_wallet_roles');
 if (!c.managers.length || c.managers.length > 16 || new Set(c.managers).size !== c.managers.length || !Number.isSafeInteger(c.threshold) || c.threshold < 1 || c.threshold > c.managers.length) throw Error('invalid_management_threshold');
 for (const nodes of [c.solanaRpcs,c.arweaveNodes]) if (!Array.isArray(nodes) || !nodes.length || nodes.length > 10 || nodes.some(n => endpoint(n) !== n)) throw Error('invalid_nodes');
 if (c.arweaveNetwork !== 'arweave.N.1') throw Error('wrong_arweave_network');
 exactKeys(c.upload,['maxBytes','maxRewardWinston','acceptingUntil']);
 if (!Number.isSafeInteger(c.upload.maxBytes) || c.upload.maxBytes < 1 || c.upload.maxBytes > MAX_BACKUP_BYTES || !Number.isSafeInteger(c.upload.acceptingUntil) || c.upload.acceptingUntil < 0) throw Error('invalid_upload_policy');
 if (!/^(0|[1-9]\d{0,29})$/.test(c.upload.maxRewardWinston)) throw Error('invalid_storage_budget');
 exactKeys(c.identifiers,['protocol','release']);
 for (const id of Object.values(c.identifiers)) if (id !== null && (typeof id !== 'string' || id.length > 256)) throw Error('invalid_identifier');
}
export const configHash = (c: Config) => envelopeDigest(canonical(c));
export function verifySignatures(value: unknown, signatures: Signature[], allowed: string[], threshold: number) {
 if (!Array.isArray(signatures) || signatures.length > 16) throw Error('invalid_signatures');
 const bytes = new TextEncoder().encode(canonical(value)), seen = new Set<string>();
 for (const s of signatures) {
  exactKeys(s,['publicKey','signature']); assertBase58(s.publicKey,32); assertBase58(s.signature,64);
  if (seen.has(s.publicKey) || !allowed.includes(s.publicKey) || !ed25519.verify(bs58.decode(s.signature),bytes,bs58.decode(s.publicKey))) throw Error('invalid_or_unauthorized_signature');
  seen.add(s.publicKey);
 }
 if (seen.size < threshold) throw Error('management_threshold');
}
export async function walletSignature(value: unknown, wallet: MessageWallet): Promise<Signature> {
 if (!wallet.publicKey || !wallet.signMessage) throw Error('message_signature_not_supported');
 const s = { publicKey: wallet.publicKey.toString(), signature: bs58.encode(await wallet.signMessage(new TextEncoder().encode(canonical(value)))) };
 verifySignatures(value,[s],[s.publicKey],1); return s;
}
export const acceptancePayload = (c: Config) => ({ domain:'sejire/config-acceptance/v1', config:c });
export async function verifyChain(chain: ConfigChain, trustedGenesisHash: string): Promise<Config> {
 exactKeys(chain,['schema','versions']);
 if (chain.schema !== 'sejire/config-chain/v1' || !Array.isArray(chain.versions) || !chain.versions.length || chain.versions.length > 1000 || !/^[a-f0-9]{64}$/.test(trustedGenesisHash)) throw Error('trusted_genesis_required');
 let previous: Config | undefined;
 for (const v of chain.versions) {
  exactKeys(v,['config','signatures','acceptance']); validateConfig(v.config);
  if (!previous) {
   if (v.config.version !== 1 || v.config.previous !== null || await configHash(v.config) !== trustedGenesisHash) throw Error('untrusted_genesis');
  } else if (v.config.version !== previous.version+1 || v.config.previous !== await configHash(previous) || v.config.environment !== previous.environment || v.config.createdAt < previous.createdAt) throw Error('configuration_fork_or_gap');
  const authority = previous ?? v.config;
  verifySignatures(v.config,v.signatures,authority.managers,authority.threshold);
  if (!previous || canonical(previous.managers) !== canonical(v.config.managers) || previous.threshold !== v.config.threshold) verifySignatures(acceptancePayload(v.config),v.acceptance,v.config.managers,v.config.threshold);
  else if (v.acceptance.length) verifySignatures(acceptancePayload(v.config),v.acceptance,v.config.managers,v.config.threshold);
  previous = v.config;
 }
 return structuredClone(previous!);
}
export async function extendChain(current: ConfigChain, incoming: ConfigChain, trusted: string) {
 await verifyChain(incoming,trusted);
 if (incoming.versions.length < current.versions.length || current.versions.some((v,i) => canonical(v.config) !== canonical(incoming.versions[i]?.config))) throw Error('configuration_conflict_or_rollback');
 return structuredClone(incoming);
}
export function splitTotal(total: string, service: string, donationOnly = false) {
 const t = assertUnits(total), s = donationOnly ? 0n : assertUnits(service);
 if (t < s || t === 0n) throw Error('insufficient_total');
 return { servicePayment:s.toString(), fundContribution:(t-s).toString(), total:totalUnits(s.toString(),(t-s).toString()) };
}
