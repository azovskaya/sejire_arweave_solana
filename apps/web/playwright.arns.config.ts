import { defineConfig } from '@playwright/test';

/** Serves the already-built ArNS promo dist (npm run arns:build) like a static gateway. */
export default defineConfig({
  testDir: './tests',
  testMatch: 'arns-hosted.spec.mjs',
  timeout: 120000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5191',
    headless: true,
    locale: 'ru-RU',
    channel: process.env.SEJIRE_BROWSER_CHANNEL || 'chrome',
    serviceWorkers: 'block',
    launchOptions: { executablePath: process.env.SEJIRE_BROWSER_EXECUTABLE },
  },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 5191 --strictPort',
    url: 'http://127.0.0.1:5191',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
