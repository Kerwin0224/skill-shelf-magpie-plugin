import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SHELF_TEST_PORT || 47931);

export default defineConfig({
  testDir: './test',
  testMatch: '**/*ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node scripts/test-fixtures.mjs',
    url: `http://127.0.0.1:${port}/_identity`,
    reuseExistingServer: false,
    timeout: 15000,
  },
});
