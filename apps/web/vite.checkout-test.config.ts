import { mergeConfig } from 'vite';
import appConfig from './vite.config';

// Checkout browser tests import a software signer immediately after navigation.
// The polyfill plugin injects this bare specifier after the dependency scan;
// discovering it later changes optimized chunks and reloads that first page.
// Prebundle the observed missing dependency only in this test server.
export default mergeConfig(appConfig, {
  cacheDir: process.env.SEJIRE_CHECKOUT_TEST_CACHE_DIR || 'node_modules/.vite-checkout-tests',
  optimizeDeps: { include: ['vite-plugin-node-polyfills/shims/buffer'] },
});
