import { defineConfig, devices } from '@playwright/test';
if (!process.env.SEJIRE_TEST_API_ORIGIN) throw Error('Portable browser acceptance requires the baked SEJIRE_TEST_API_ORIGIN');
export default defineConfig({
  testDir: './tests', testMatch: ['arns-hosted.spec.mjs', 'portable-funded.spec.mjs'], timeout: 120000, workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5191', headless: true, locale: 'ru-RU', serviceWorkers: 'block' },
  projects: [ { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } }, { name: 'webkit', use: { ...devices['Desktop Safari'] } } ],
  webServer: { command: 'npx vite preview --host 127.0.0.1 --port 5191 --strictPort', url: 'http://127.0.0.1:5191', reuseExistingServer: false, timeout: 120000 },
});
