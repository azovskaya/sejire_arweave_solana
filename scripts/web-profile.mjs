/** Public defaults are Arweave-only. Historical tooling must opt in explicitly. */
export function webProfile(mode) {
  if (mode === undefined || mode === '' || mode === 'true') return 'decentralized-direct-arweave';
  if (mode === 'false') return 'legacy';
  throw Error('invalid_web_profile');
}

export const DIRECT_BROWSER_ENV = Object.freeze({
  VITE_DECENTRALIZED_MODE: 'true', VITE_PORTABLE_FUNDED: '0',
  VITE_FUND_API_URL: '', VITE_CHECKOUT_API_URL: '', VITE_SPONSOR_API_URL: '', VITE_SPONSOR_URL: '',
  VITE_PRESERVATION_V2_ENABLED: '0', VITE_PRESERVATION_V2_TEST: '0', VITE_RECOVERY_TEST: '0',
  VITE_CHECKOUT_ENABLED: '0', VITE_NATIVE_AR_ENABLED: '0', VITE_NATIVE_AR_PILOT: '0',
  VITE_NATIVE_AR_BROADCAST: '0', VITE_NATIVE_SOL_MAINNET: '0', VITE_PUBLISH_MODE: 'arweave',
  VITE_SOLANA_NETWORK: 'devnet', VITE_AO_MODE: 'local', VITE_SEJIRE_FACTORY_ID: '', VITE_QA_TOOLS: '0',
});

export function webDefines(mode) {
  const values = webProfile(mode) === 'decentralized-direct-arweave'
    ? DIRECT_BROWSER_ENV : { VITE_DECENTRALIZED_MODE: 'false' };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]));
}
