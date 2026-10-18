// A successful promo choice is reused only in this unlocked browser session.
// Neither the code nor recovery words are written to browser storage.
const acceptedCodes = new Map<string, string>();

export function rememberFundedPromo(vaultId: string, code: string) {
  acceptedCodes.set(vaultId, code.trim());
}

export function getFundedPromo(vaultId?: string | null): string | null {
  return vaultId ? acceptedCodes.get(vaultId) ?? null : null;
}
