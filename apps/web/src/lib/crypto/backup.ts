import type { EnvelopeV1 } from "./encrypt";
import { MAX_BACKUP_BYTES, parseEnvelope } from "./envelope";
import { parseSeedBackup } from "./seedBackup";
import { parsePreservationReceipt, type PreservationReceipt } from "../solana/receipt";

import { parseNativeReceipt, type NativeReceipt } from "../native/receipt";

export type PortableBackup =
  | { kind: "nativeReceipt"; receipt: NativeReceipt }
  | { kind: "words"; mnemonic: string }
  | { kind: "receipt"; receipt: PreservationReceipt }
  | { kind: "vault"; envelope: EnvelopeV1 };

export function parsePortableBackup(text: string): PortableBackup {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error("envelope_too_large");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("invalid_backup"); }
  const mnemonic = parseSeedBackup(raw);
  if (mnemonic) return { kind: "words", mnemonic };
  if (raw && typeof raw === "object" && "schema" in raw && raw.schema === "sejire/preservation-receipt/v1") {
    return { kind: "receipt", receipt: parsePreservationReceipt(raw) };
  }
  if (raw && typeof raw === "object" && "schema" in raw && raw.schema === "sejire/native-receipt/v1") return { kind: "nativeReceipt", receipt: parseNativeReceipt(raw) };
  return { kind: "vault", envelope: parseEnvelope(raw) };
}
