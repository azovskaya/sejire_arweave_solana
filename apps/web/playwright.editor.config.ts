import { defineConfig } from '@playwright/test';

// Synthetic local editor only. No wallet, real API, archive upload or secrets.
export default defineConfig({
  testDir: './tests', testMatch: 'editor-safety.spec.mjs', timeout: 45000,
  workers: 1, retries: 0, reporter: 'list', outputDir: 'test-results/editor-safety',
  use: { baseURL: 'http://127.0.0.1:5186', headless: true, locale: 'ru-RU',
    viewport: { width: 1440, height: 960 }, serviceWorkers: 'block', trace: 'off', screenshot: 'off' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5186 --strictPort',
    url: 'http://127.0.0.1:5186', reuseExistingServer: false,
    env: { VITE_NATIVE_AR_ENABLED: '1', VITE_PRESERVATION_V2_ENABLED: '1',
      VITE_NATIVE_AR_PILOT: '1', VITE_NATIVE_AR_BROADCAST: '0', VITE_NATIVE_SOL_MAINNET: '0',
      VITE_QA_TOOLS: '0', VITE_PUBLISH_MODE: 'solana', VITE_SOLANA_NETWORK: 'devnet',
      VITE_CHECKOUT_API_URL: 'http://127.0.0.1:5186', VITE_FUND_API_URL: 'http://127.0.0.1:5186' },
  },
});
