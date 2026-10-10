import assert from 'node:assert/strict';
import { connectWallet } from './client';
import { Keypair } from '@solana/web3.js';
import { TurboFactory } from '@ardrive/turbo-sdk/web';
import { DataItem } from '@dha-team/arbundles/web';
import { disposableWallet } from './fixture.selftest';
import { networkConfig } from './policy';

const originalAddress = Keypair.generate().publicKey.toString();
let address = originalAddress;
let messages = 0;
const provider = {
  publicKey: { toString: () => address },
  connect: async () => {},
  signMessage: async (message: Uint8Array) => { messages++; return message; },
  signTransaction: async (tx: unknown) => tx,
};
Object.defineProperty(globalThis, 'window', { configurable: true, value: { phantom: { solana: provider } } });
const adapter = await connectWallet('Phantom');
assert.notEqual(adapter, provider);
assert.equal(adapter.publicKey.toString(), originalAddress);
await adapter.signMessage(new Uint8Array([1]));
assert.equal(messages, 1);
address = Keypair.generate().publicKey.toString();
assert.throws(() => adapter.publicKey.toString(), /wallet_changed/);
await assert.rejects(() => adapter.signMessage(new Uint8Array([2])), /wallet_changed/);
assert.equal(messages, 1, 'must refuse to request a signature from a different account');
await assert.rejects(() => connectWallet('Solflare'), /wallet_not_found/);

// Contract tests use cryptographically real signatures, not real browser extensions.
for (const name of ['Phantom', 'Solflare'] as const) {
  const disposable = disposableWallet();
  const extension = { ...disposable.wallet, connect: async () => {}, signMessage: async (message: Uint8Array) => {
    const signature = await disposable.wallet.signMessage(message);
    return name === 'Phantom' ? { signature } : signature;
  } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: name === 'Phantom'
    ? { phantom: { solana: extension } } : { solflare: extension } });
  const connected = await connectWallet(name);
  const originalSignMessage = extension.signMessage;
  const client = TurboFactory.authenticated({ ...networkConfig('devnet'), walletAdapter: connected });
  const blob = new Blob(['synthetic encrypted-envelope adapter test']);
  const signed = await client.signer.signDataItem({ fileStreamFactory: () => blob.stream(), fileSizeFactory: () => blob.size });
  const bytes = Buffer.from(await new Response(signed.dataItemStreamFactory() as ReadableStream<Uint8Array>).arrayBuffer());
  assert(await new DataItem(bytes).isValid(), `${name} return format must produce a valid signature`);
  assert.equal(extension.signMessage, originalSignMessage, 'SDK must not mutate extension provider');
  assert.equal(disposable.counts.messages, 1);
}
console.log('solana.wallet.selftest: OK — both adapter contracts, real SDK signatures, isolation, changed account and unavailable wallet');
