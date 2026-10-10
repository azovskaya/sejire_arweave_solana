/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NATIVE_AR_PILOT?: string;
  readonly VITE_NATIVE_AR_ENABLED?: string;
  readonly VITE_NATIVE_AR_BROADCAST?: string;
  readonly VITE_NATIVE_SOL_MAINNET?: string;
  readonly VITE_CHECKOUT_ENABLED?: string;
  readonly VITE_CHECKOUT_API_URL?: string;
  readonly VITE_SOLANA_NETWORK?: "devnet" | "mainnet-beta";
  readonly VITE_PUBLISH_MODE?: string;
  readonly VITE_QA_TOOLS?: string;
  readonly VITE_SPONSOR_URL?: string;
  readonly VITE_AO_MODE?: string;
  readonly VITE_SEJIRE_FACTORY_ID?: string;
  readonly VITE_AO_HB_NODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
