import { ed25519 } from '@noble/curves/ed25519';
// Local Vite/Playwright fixture ONLY; never imported by product entrypoints.
import { Keypair } from '@solana/web3.js';
import { createMnemonic } from '../src/lib/crypto/bip39';
import { deriveKeysFromMnemonic } from '../src/lib/crypto/keys';
import { emptyVault, putTree, sealVault, openLocalVault } from '../src/lib/crypto/vault';
import { createTree, upsertPersonFields, commitDraft } from '../src/lib/treeEngine';
export function installWallet() {
  // Public reproducible SOFTWARE signer, never funded or broadcast to a real RPC.
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(17));
  const listeners=new Map<string,Set<()=>void>>();
  const state = { reject: false, rejectMessage: false, signCount: 0, emit:(event:string)=>listeners.get(event)?.forEach(fn=>fn()) };
  (window as unknown as { fixtureWallet: typeof state }).fixtureWallet = state;
  (window as unknown as { phantom: unknown }).phantom = { solana: {
    publicKey: signer.publicKey, connect: async () => {}, on:(event:string,fn:()=>void)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event)!.add(fn);},removeListener:(event:string,fn:()=>void)=>listeners.get(event)?.delete(fn), signMessage: async (message: Uint8Array) => {if(state.rejectMessage)throw Object.assign(new Error('synthetic_wallet_rejection'),{code:4001});return ed25519.sign(message, new Uint8Array(32).fill(17));},
    signTransaction: async (tx: import('@solana/web3.js').Transaction) => {
      state.signCount++;
      if (state.reject) throw Object.assign(new Error('synthetic_wallet_rejection'), { code: 4001 });
      tx.partialSign(signer); return tx;
    },
  } };
}
export async function fixture() {
  const words = createMnemonic(), keys = deriveKeysFromMnemonic(words);
  let first = upsertPersonFields(createTree('Synthetic family A'), { id: 'parent', name: 'Parent', parents: [] });
  first = upsertPersonFields(first, { id: 'child', name: 'Child', parents: ['parent'] });
  first = commitDraft(first, 'Synthetic first version');
  first = upsertPersonFields(first, { id: 'child', name: 'Child corrected', parents: ['parent'] });
  first = commitDraft(first, 'Synthetic correction');
  const second = commitDraft(upsertPersonFields(createTree('Synthetic family B'), { id: 'other', name: 'Other', parents: [] }), 'Synthetic second tree');
  const vault = putTree(putTree(emptyVault(keys.vaultId), second), first);
  const envelope = await sealVault(keys, vault);
  return { words, vault, envelope, serialized: JSON.stringify(envelope) };
}
export async function recovered(words: string) { return openLocalVault(deriveKeysFromMnemonic(words)); }
