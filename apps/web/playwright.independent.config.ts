import { defineConfig } from '@playwright/test';

/** Exercises the exact static independent build; every external request is intercepted. */
export default defineConfig({
  testDir: './tests', testMatch: 'independent.spec.mjs', timeout: 90_000, workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5193', headless: true, locale: 'ru-RU',
    serviceWorkers: 'block' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium',
      channel: process.env.SEJIRE_BROWSER_CHANNEL || undefined,
      launchOptions: { executablePath: process.env.SEJIRE_BROWSER_EXECUTABLE } } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: { command: 'npx vite preview --host 127.0.0.1 --port 5193 --strictPort',
    url: 'http://127.0.0.1:5193', reuseExistingServer: false, timeout: 120_000 },
});
