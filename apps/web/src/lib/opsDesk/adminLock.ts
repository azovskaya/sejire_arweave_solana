import { verifyOpsPassword } from "./store";

type AdminLock = {
  schema: "sejire/admin-lock/v1";
  algorithm: "PBKDF2-SHA256";
  configured: true;
  iterations: number;
  salt: string;
  digest: string;
};

function validBase64(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return atob(value).length === bytes;
  } catch {
    return false;
  }
}

function parseLock(value: unknown): AdminLock {
  if (!value || typeof value !== "object") throw new Error("admin_lock_invalid");
  const lock = value as Partial<AdminLock>;
  if (
    lock.schema !== "sejire/admin-lock/v1" ||
    lock.algorithm !== "PBKDF2-SHA256" ||
    lock.configured !== true ||
    !Number.isInteger(lock.iterations) ||
    lock.iterations !== 600_000 ||
    !validBase64(lock.salt, 32) ||
    !validBase64(lock.digest, 32)
  ) throw new Error("admin_lock_invalid");
  return lock as AdminLock;
}

/** Fetches only a public verifier; the password never leaves the browser. */
export async function verifyAdminLock(password: string): Promise<boolean> {
  const url = new URL("./admin-lock.json", document.baseURI);
  const response = await fetch(url, { cache: "no-store", credentials: "omit", redirect: "error" });
  if (!response.ok) throw new Error("admin_lock_unavailable");
  const body = await response.text();
  if (body.length > 4096) throw new Error("admin_lock_invalid");
  const lock = parseLock(JSON.parse(body) as unknown);
  return verifyOpsPassword(password, `pbkdf2$${lock.iterations}$${lock.salt}$${lock.digest}`);
}
