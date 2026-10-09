import { fingerprintVaultId } from "../crypto/keys";
import type {
  HotTreasury,
  OpsMovement,
  OpsSecrets,
  OpsSettings,
  PaymentProviderSetting,
  RedactedOpsKeys,
} from "./types";

export const OPS_STORAGE_KEY = "sejire.ops.v1";
const SESSION_KEY = "sejire.ops.session";
const MIN_PASSWORD = 12;
const PBKDF2_ITERS = 210_000;

type Disk = {
  passwordHash: string;
  wrap?: { iv: string; data: string };
  /** Read only during migration of older local records; never written again. */
  hotTreasury?: HotTreasury;
  treasuryAddress?: string;
  treasuryKeySet?: boolean;
  settings: OpsSettings;
  kaspiTokenSet?: boolean;
  siteKeySet?: boolean;
  movements: OpsMovement[];
};

const DEFAULT_SETTINGS: OpsSettings = {
  paymentProvider: "mock",
  publishPriceMinor: "1500",
  publishCurrency: "KZT",
  kaspiTradePointId: "",
  kaspiApiBase: "",
};

const memory = new Map<string, string>();
let activeTreasury: HotTreasury | null = null;

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem(key);
  } catch {
    /* private mode */
  }
  return memory.get(key) ?? null;
}

function storageSet(key: string, value: string): void {
  memory.set(key, value);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* quota / private */
  }
}

function storageRemove(key: string): void {
  memory.delete(key);
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function encoder() {
  return new TextEncoder();
}

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function passwordTooShort(password: string): boolean {
  return password.trim().length < MIN_PASSWORD;
}

export async function hashOpsPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERS },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERS}$${toB64(salt)}$${toB64(bits)}`;
}

export async function verifyOpsPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  const key = await crypto.subtle.importKey("raw", encoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations },
    key,
    expected.length * 8
  );
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function wrapKeyFromPassword(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations: PBKDF2_ITERS },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptSecrets(password: string, secrets: OpsSecrets): Promise<{ iv: string; data: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await wrapKeyFromPassword(password, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder().encode(JSON.stringify(secrets))
  );
  return { iv: `${toB64(salt)}.${toB64(iv)}`, data: toB64(cipher) };
}

async function decryptSecrets(password: string, wrap: { iv: string; data: string }): Promise<OpsSecrets> {
  const [saltB64, ivB64] = wrap.iv.split(".");
  if (!saltB64 || !ivB64) throw new Error("wrap_invalid");
  const key = await wrapKeyFromPassword(password, fromB64(saltB64));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(fromB64(ivB64)) },
    key,
    new Uint8Array(fromB64(wrap.data))
  );
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as OpsSecrets;
  return {
    turboJwk: typeof parsed.turboJwk === "string" ? parsed.turboJwk : undefined,
    siteJwk: typeof parsed.siteJwk === "string" ? parsed.siteJwk : undefined,
    kaspiMerchantToken: typeof parsed.kaspiMerchantToken === "string" ? parsed.kaspiMerchantToken : undefined,
  };
}

function parseDisk(raw: string | null): Disk | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as Partial<Disk>;
    if (typeof rec.passwordHash !== "string" || !rec.passwordHash) return null;
    return {
      passwordHash: rec.passwordHash,
      wrap: rec.wrap && typeof rec.wrap.iv === "string" && typeof rec.wrap.data === "string" ? rec.wrap : undefined,
      hotTreasury:
        rec.hotTreasury && typeof rec.hotTreasury.jwk === "string" && typeof rec.hotTreasury.address === "string"
          ? rec.hotTreasury
          : undefined,
      treasuryAddress: typeof rec.treasuryAddress === 'string' ? rec.treasuryAddress : rec.hotTreasury?.address,
      treasuryKeySet: Boolean(rec.treasuryKeySet || rec.hotTreasury?.jwk),
      settings: {
        paymentProvider: rec.settings?.paymentProvider === "kaspi" ? "kaspi" : "mock",
        publishPriceMinor: rec.settings?.publishPriceMinor || DEFAULT_SETTINGS.publishPriceMinor,
        publishCurrency: rec.settings?.publishCurrency || DEFAULT_SETTINGS.publishCurrency,
        kaspiTradePointId: rec.settings?.kaspiTradePointId || "",
        kaspiApiBase: rec.settings?.kaspiApiBase || "",
      },
      kaspiTokenSet: Boolean(rec.kaspiTokenSet),
      siteKeySet: Boolean(rec.siteKeySet),
      movements: Array.isArray(rec.movements) ? rec.movements.filter(isMovement) : [],
    };
  } catch {
    return null;
  }
}

function isMovement(value: unknown): value is OpsMovement {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.at === "number" && (rec.kind === "paid" || rec.kind === "saved");
}

function readDisk(): Disk | null {
  return parseDisk(storageGet(OPS_STORAGE_KEY));
}

function writeDisk(disk: Disk): void {
  delete disk.hotTreasury;
  storageSet(OPS_STORAGE_KEY, JSON.stringify(disk));
}

export function opsNeedsSetup(): boolean {
  return !readDisk()?.passwordHash;
}

export function getHotTreasury(): HotTreasury | null {
  return activeTreasury;
}

export function isTreasuryPublishEnabled(): boolean {
  return Boolean(getHotTreasury()?.jwk);
}

export function listOpsMovements(): OpsMovement[] {
  return [...(readDisk()?.movements ?? [])];
}

export function getOpsSettings(): OpsSettings {
  return { ...(readDisk()?.settings ?? DEFAULT_SETTINGS) };
}

export function readSessionPassword(): string | null {
  try {
    if (typeof sessionStorage === "undefined") return memory.get(SESSION_KEY) ?? null;
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return memory.get(SESSION_KEY) ?? null;
  }
}

function writeSessionPassword(password: string | null): void {
  if (!password) {
    memory.delete(SESSION_KEY);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  memory.set(SESSION_KEY, password);
  try {
    sessionStorage.setItem(SESSION_KEY, password);
  } catch {
    /* ignore */
  }
}

export async function setupOpsPassword(password: string): Promise<void> {
  if (passwordTooShort(password)) throw new Error("password_too_short");
  if (!opsNeedsSetup()) throw new Error("already_setup");
  writeDisk({
    passwordHash: await hashOpsPassword(password),
    settings: { ...DEFAULT_SETTINGS },
    movements: [],
  });
  activeTreasury=null;
  writeSessionPassword(password);
}

export async function loginOps(password: string): Promise<boolean> {
  const disk = readDisk();
  if (!disk) return false;
  const ok = await verifyOpsPassword(password, disk.passwordHash);
  if (ok) {
    let secrets: OpsSecrets = {};
    try {secrets=disk.wrap?await decryptSecrets(password,disk.wrap):{};}catch{secrets={};}
    if(disk.hotTreasury?.jwk){
      secrets.turboJwk??=disk.hotTreasury.jwk;
      disk.treasuryAddress=disk.hotTreasury.address;
      disk.treasuryKeySet=true;
      disk.wrap=await encryptSecrets(password,secrets);
      writeDisk(disk);
    }
    activeTreasury=secrets.turboJwk?{jwk:secrets.turboJwk,address:disk.treasuryAddress||'configured'}:null;
    writeSessionPassword(password);
  }
  return ok;
}

export function logoutOps(): void {
  activeTreasury=null;
  writeSessionPassword(null);
}

export async function changeOpsPassword(nextPassword: string): Promise<void> {
  if (passwordTooShort(nextPassword)) throw new Error("password_too_short");
  const current = readSessionPassword();
  if (!current) throw new Error("unauthorized");
  const disk = readDisk();
  if (!disk) throw new Error("unauthorized");
  const secrets = disk.wrap ? await decryptSecrets(current, disk.wrap) : {};
  disk.passwordHash = await hashOpsPassword(nextPassword);
  disk.wrap = disk.wrap ? await encryptSecrets(nextPassword, secrets) : undefined;
  writeDisk(disk);
  writeSessionPassword(nextPassword);
}

export async function loadOpsSecrets(): Promise<OpsSecrets> {
  const password = readSessionPassword();
  const disk = readDisk();
  if (!password || !disk?.wrap) return {};
  try {
    const secrets=await decryptSecrets(password, disk.wrap);
    activeTreasury=secrets.turboJwk?{jwk:secrets.turboJwk,address:disk.treasuryAddress||'configured'}:null;
    return secrets;
  } catch {
    return {};
  }
}

export function looksLikeJwk(raw: string): boolean {
  try {
    const jwk = JSON.parse(raw) as { kty?: unknown; n?: unknown; d?: unknown };
    return typeof jwk.kty === "string" && typeof jwk.n === "string" && typeof jwk.d === "string";
  } catch {
    return false;
  }
}

export type OpsKeyPatch = {
  turboJwk?: string;
  siteJwk?: string;
  kaspiMerchantToken?: string;
  kaspiTradePointId?: string;
  kaspiApiBase?: string;
  paymentProvider?: PaymentProviderSetting;
  publishPriceMinor?: string;
  publishCurrency?: string;
  clearTreasury?: boolean;
  clearSiteKey?: boolean;
  clearKaspiToken?: boolean;
  hotAddress?: string;
};

export async function applyOpsKeyPatch(patch: OpsKeyPatch): Promise<void> {
  const password = readSessionPassword();
  if (!password) throw new Error("unauthorized");
  const disk = readDisk();
  if (!disk) throw new Error("unauthorized");
  const secrets = disk.wrap ? await decryptSecrets(password, disk.wrap) : {};

  const assignSecret = (key: keyof OpsSecrets, value: string | undefined, clear: boolean) => {
    if (clear) {
      delete secrets[key];
      return;
    }
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    secrets[key] = trimmed;
  };

  assignSecret("turboJwk", patch.turboJwk, patch.clearTreasury === true);
  assignSecret("siteJwk", patch.siteJwk, patch.clearSiteKey === true);
  assignSecret("kaspiMerchantToken", patch.kaspiMerchantToken, patch.clearKaspiToken === true);

  if (secrets.turboJwk && !looksLikeJwk(secrets.turboJwk)) throw new Error("turbo_jwk_invalid");
  if (secrets.siteJwk && !looksLikeJwk(secrets.siteJwk)) throw new Error("site_jwk_invalid");

  if(patch.clearTreasury)disk.treasuryAddress=undefined;
  else if(secrets.turboJwk)disk.treasuryAddress=patch.hotAddress||disk.treasuryAddress||disk.hotTreasury?.address||'configured';
  disk.treasuryKeySet=Boolean(secrets.turboJwk);

  if (patch.paymentProvider === "kaspi" || patch.paymentProvider === "mock") {
    disk.settings.paymentProvider = patch.paymentProvider;
  }
  if (typeof patch.publishPriceMinor === "string" && patch.publishPriceMinor.trim()) {
    disk.settings.publishPriceMinor = patch.publishPriceMinor.trim();
  }
  if (typeof patch.publishCurrency === "string" && patch.publishCurrency.trim()) {
    disk.settings.publishCurrency = patch.publishCurrency.trim();
  }
  if (typeof patch.kaspiTradePointId === "string") disk.settings.kaspiTradePointId = patch.kaspiTradePointId.trim();
  if (typeof patch.kaspiApiBase === "string") disk.settings.kaspiApiBase = patch.kaspiApiBase.trim();

  disk.kaspiTokenSet = Boolean(secrets.kaspiMerchantToken);
  disk.siteKeySet = Boolean(secrets.siteJwk);
  disk.wrap = await encryptSecrets(password, secrets);
  writeDisk(disk);
  activeTreasury=secrets.turboJwk?{jwk:secrets.turboJwk,address:disk.treasuryAddress||'configured'}:null;
}

export async function setGeneratedTreasury(jwk: string, address: string): Promise<void> {
  await applyOpsKeyPatch({ turboJwk: jwk, hotAddress: address });
}

export function redactOpsKeys(balanceAr?: string | null): RedactedOpsKeys {
  const disk = readDisk();
  return {
    treasuryConfigured: Boolean(disk?.treasuryKeySet),
    treasuryAddress: disk?.treasuryAddress && disk.treasuryAddress !== "configured" ? disk.treasuryAddress : null,
    treasuryBalanceAr: balanceAr ?? null,
    siteKeyConfigured: Boolean(disk?.siteKeySet),
    kaspiTokenConfigured: Boolean(disk?.kaspiTokenSet),
    kaspiTradePointId: disk?.settings.kaspiTradePointId || "",
    kaspiApiBase: disk?.settings.kaspiApiBase || "",
    paymentProvider: disk?.settings.paymentProvider || "mock",
    publishPriceMinor: disk?.settings.publishPriceMinor || "1500",
    publishCurrency: disk?.settings.publishCurrency || "KZT",
    passwordConfigured: Boolean(disk?.passwordHash),
    hotTreasury: Boolean(disk?.treasuryKeySet),
  };
}

export function recordOpsMovement(event: {
  kind: "paid" | "saved";
  amountMinor?: number;
  currency?: string;
  provider?: string;
  txId?: string;
  vaultId?: string;
}): void {
  const disk = readDisk();
  if (!disk) return;
  const vaultFp = event.vaultId ? fingerprintVaultId(event.vaultId) : undefined;
  const txFp = event.txId ? `${event.txId.slice(0, 6)}…${event.txId.slice(-4)}` : undefined;
  disk.movements.unshift({
    at: Date.now(),
    kind: event.kind,
    amountMinor: event.amountMinor ?? 0,
    currency: event.currency || disk.settings.publishCurrency,
    provider: event.provider || "treasury",
    txFp,
    vaultFp,
  });
  disk.movements = disk.movements.slice(0, 200);
  writeDisk(disk);
}

export function resetOpsDesk(): void {
  memory.clear();
  activeTreasury=null;
  storageRemove(OPS_STORAGE_KEY);
  writeSessionPassword(null);
}

export function assertNoSecretsInBlob(blob: string): void {
  if (/"turboJwk"|"kaspiMerchantToken"|"mnemonic"|"vaultId"|"vault_id"/i.test(blob)) {
    throw new Error("ops payload leaked a secret field");
  }
}
