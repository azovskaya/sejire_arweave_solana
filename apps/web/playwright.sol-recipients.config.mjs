import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'sol-recipients.spec.mjs', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:5199', browserName: 'chromium', headless: true },
  webServer: { command: 'npm exec -- vite --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199/tests/fixtures/sol-recipients.html', reuseExistingServer: false,
    env: { VITE_FUND_API_URL: 'http://127.0.0.1:5199', VITE_CHECKOUT_API_URL: 'http://127.0.0.1:5199' } },
});
