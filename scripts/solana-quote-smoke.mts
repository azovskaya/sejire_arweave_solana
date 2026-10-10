/** Read-only network check. No wallet connection, signature, upload or payment. */
import { prepareQuote } from '../apps/web/src/lib/solana/client';
import { encryptJson } from '../apps/web/src/lib/crypto/encrypt';
import { deriveKeysFromMnemonic } from '../apps/web/src/lib/crypto/keys';
const keys = deriveKeysFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const envelope = await encryptJson(keys.encKey, keys.vaultId, { synthetic: 'Quote only' });
for (const network of ['devnet', 'mainnet-beta'] as const) {
  const quote = await prepareQuote(envelope, network, '11111111111111111111111111111111');
  console.log(JSON.stringify({ network, maxLamports: quote.maxLamports, expiresAt: quote.expiresAt }));
}
