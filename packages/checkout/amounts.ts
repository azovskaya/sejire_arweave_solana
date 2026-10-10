/** Chain representation limits only. No commercial contribution ceiling. */
export const U64_MAX = (1n << 64n) - 1n;
export function assertUnits(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) throw new Error('invalid_units');
  const units = BigInt(value);
  if (units > U64_MAX) throw new Error('technical_amount_overflow');
  return units;
}
export function parseAmount(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new Error('invalid_decimals');
  // No exponent, comma, whitespace, sign, silent rounding or enormous BigInt parsing.
  if (typeof value !== 'string' || value.length > 32 || !/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error('invalid_amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('excess_precision');
  const units = (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
  assertUnits(units);
  return units;
}
export function formatAmount(value: string, decimals: number): string {
  const units = assertUnits(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new Error('invalid_decimals');
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${units / scale}${fraction ? '.' + fraction : ''}`;
}
export function totalUnits(...amounts: string[]): string {
  const sum = amounts.reduce((total, amount) => total + assertUnits(amount), 0n).toString();
  assertUnits(sum);
  return sum;
}
/** Threshold is a confirmation policy, never a rejection/cap or a wallet spending allowance. */
export function requiresLargeAmountConfirmation(amount: string, threshold: string): boolean {
  const boundary = assertUnits(threshold);
  if (boundary === 0n) throw new Error('invalid_confirmation_threshold');
  return assertUnits(amount) >= boundary;
}
