import { isValidMnemonic, normalizeMnemonic, splitWords } from "./bip39";
import { downloadJson } from "../download";

/** Plain BIP-39 backup for SEJIRE — not encrypted; treat like paper. */
export type SeedBackupV1 = {
  schema: "sejire/seed/v1";
  created_at: string;
  word_count: 12;
  /** Space-separated BIP-39 English mnemonic */
  mnemonic: string;
  words: string[];
};

export function buildSeedBackup(phrase: string): SeedBackupV1 {
  const mnemonic = normalizeMnemonic(phrase);
  if (!isValidMnemonic(mnemonic)) {
    throw new Error("Invalid BIP-39 mnemonic");
  }
  const words = splitWords(mnemonic);
  if (words.length !== 12) {
    throw new Error("SEJIRE seed backup expects exactly 12 words");
  }
  return {
    schema: "sejire/seed/v1",
    created_at: new Date().toISOString(),
    word_count: 12,
    mnemonic,
    words,
  };
}

export function parseSeedBackup(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== "sejire/seed/v1") return null;
  const phrase =
    typeof obj.mnemonic === "string"
      ? obj.mnemonic
      : Array.isArray(obj.words)
        ? obj.words.filter((w): w is string => typeof w === "string").join(" ")
        : "";
  const mnemonic = normalizeMnemonic(phrase);
  return isValidMnemonic(mnemonic) ? mnemonic : null;
}

export function downloadSeedBackup(phrase: string) {
  const backup = buildSeedBackup(phrase);
  downloadJson(backup, `sejire-12-words-${backup.created_at.slice(0, 10)}.json`);
}
