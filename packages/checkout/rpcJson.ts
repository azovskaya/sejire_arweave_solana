import { assertUnits } from './amounts';

/** Decode RPC JSON without rounding a u64 before validation. JSON.parse alone
 * silently rounds amounts above Number.MAX_SAFE_INTEGER. Only plain, safe
 * integer tokens become numbers; other numeric tokens retain their exact text.
 * Quoted JSON strings (including escapes) are copied unchanged. */
export function parseRpcJson(source: string): unknown {
  // Validate the original grammar first. Its decoded values are discarded:
  // rewriting a numeric object key must not turn invalid JSON into valid JSON.
  JSON.parse(source);
  const pieces: string[] = [];
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  let index = 0, copied = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      index++;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index++] === '"') break;
      }
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      number.lastIndex = index;
      const match = number.exec(source);
      if (match) {
        const token = match[0];
        if (!/^-?(?:0|[1-9][0-9]*)$/.test(token) || token === '-0' || !Number.isSafeInteger(Number(token))) {
          pieces.push(source.slice(copied, index), JSON.stringify(token));
          copied = index + token.length;
        }
        index += token.length;
        continue;
      }
    }
    index++;
  }
  pieces.push(source.slice(copied));
  return JSON.parse(pieces.join(''));
}

/** RPC amounts may be a safe number or an exact integer token retained above.
 * Fractional/exponential forms, negative amounts, overflow and already-rounded
 * unsafe JavaScript numbers are rejected before any wallet action. */
export function rpcU64(value: unknown): string {
  try {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw Error();
      return assertUnits(String(value)).toString();
    }
    if (typeof value !== 'string') throw Error();
    return assertUnits(value).toString();
  } catch { throw Error('invalid_rpc_integer'); }
}
