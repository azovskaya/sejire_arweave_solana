// Test helpers only. Disposable signing keys are never written to disk or logged.
import { createPrivateKey, sign } from "node:crypto";
import { Keypair, Transaction } from "@solana/web3.js";
import type { SolanaWalletAdapter } from "@ardrive/turbo-sdk/web";
import { createMnemonic } from "../crypto/bip39";
import { deriveKeysFromMnemonic } from "../crypto/keys";
import { encryptJson } from "../crypto/encrypt";
import { emptyVault, putTree } from "../crypto/vault";
import { commitDraft, createTree, upsertPersonFields } from "../treeEngine";

export function disposableWallet() {
  const keypair = Keypair.generate();
  const key = createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), keypair.secretKey.slice(0, 32),
  ]) });
  const counts = { messages: 0, transactions: 0 };
  const wallet: SolanaWalletAdapter = {
    publicKey: keypair.publicKey,
    signMessage: async (message) => { counts.messages++; return sign(null, message, key); },
    signTransaction: async (tx: unknown) => {
      if (!(tx instanceof Transaction)) throw new Error("legacy transaction expected");
      counts.transactions++; tx.partialSign(keypair); return tx;
    },
  };
  return { wallet, counts };
}

export async function preservationFixture(words = createMnemonic()) {
  const keys = deriveKeysFromMnemonic(words);
  let first = upsertPersonFields(createTree("Synthetic family A"), { id: "parent", name: "Synthetic parent", parents: [] });
  first = upsertPersonFields(first, { id: "child", name: "Synthetic child", parents: ["parent"] });
  first = commitDraft(first, "Synthetic recovery fixture");
  const second = createTree("Synthetic family B");
  const vault = putTree(putTree(emptyVault(keys.vaultId), second), first);
  const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
  return { words, keys, vault, envelope };
}
