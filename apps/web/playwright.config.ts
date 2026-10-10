import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'checkout.spec.mjs', timeout: 120000, workers: 1,
  reporter: 'list', use: { baseURL: 'http://127.0.0.1:5173', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort', url: 'http://127.0.0.1:5173', reuseExistingServer: false,
    env: { VITE_CHECKOUT_ENABLED: '1', VITE_PUBLISH_MODE: 'solana', VITE_SOLANA_NETWORK: 'devnet', VITE_QA_TOOLS: '0' } },
});
