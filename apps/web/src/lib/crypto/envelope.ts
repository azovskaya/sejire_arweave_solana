import type { EnvelopeV1 } from "./encrypt";

export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

/** Validate portable ciphertext before importing it or sending it to storage. */
export function parseEnvelope(raw: unknown): EnvelopeV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_envelope");
  const value = raw as Record<string, unknown>;
  if (typeof value.ciphertext === "string" && value.ciphertext.length > MAX_BACKUP_BYTES) {
    throw new Error("envelope_too_large");
  }
  const allowed = ["schema", "vault_id", "cipher", "kdf", "iv", "ciphertext", "protocol"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
      value.schema !== "sejire/envelope/v1" || value.cipher !== "aes-gcm-256" ||
      value.kdf !== "hkdf-sha256" || value.protocol !== "sejire/v0.3" ||
      typeof value.vault_id !== "string" || !/^[a-f0-9]{32}$/.test(value.vault_id) ||
      typeof value.iv !== "string" || !/^[A-Za-z0-9+/]{16}$/.test(value.iv) ||
      typeof value.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext) ||
      value.ciphertext.length % 4 !== 0 || value.ciphertext.length < 24) {
    throw new Error("invalid_envelope");
  }
  return value as EnvelopeV1;
}

/** Whitelist the encrypted envelope; never forward a whole tree or unknown fields. */
export function serializeEnvelope(envelope: EnvelopeV1): string {
  const data = JSON.stringify(parseEnvelope(envelope));
  if (new TextEncoder().encode(data).length > MAX_BACKUP_BYTES) throw new Error("envelope_too_large");
  return data;
}
