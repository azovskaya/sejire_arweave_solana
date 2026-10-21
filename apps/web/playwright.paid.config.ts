import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'paid-solana.spec.mjs', timeout: 90000, workers: 1, reporter: 'list',
  outputDir: 'test-results/paid-solana',
  use: { baseURL: 'http://127.0.0.1:5185', headless: true, locale: 'ru-RU',
    channel: process.env.SEJIRE_BROWSER_CHANNEL || 'chrome', serviceWorkers: 'block',
    launchOptions: { executablePath: process.env.SEJIRE_BROWSER_EXECUTABLE } },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5185 --strictPort', url: 'http://127.0.0.1:5185', reuseExistingServer: false,
    env: { VITE_NATIVE_AR_ENABLED: '1', VITE_PRESERVATION_V2_ENABLED: '1', VITE_NATIVE_AR_PILOT: '1', VITE_NATIVE_AR_BROADCAST: '0',
      VITE_NATIVE_SOL_MAINNET: '0', VITE_QA_TOOLS: '0', VITE_PUBLISH_MODE: 'solana', VITE_SOLANA_NETWORK: 'devnet',
      VITE_FUND_API_URL: 'http://127.0.0.1:5185', VITE_CHECKOUT_API_URL: 'http://127.0.0.1:5185' } },
});
