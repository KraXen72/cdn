import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  use: { baseURL: 'http://127.0.0.1:5173', timezoneId: 'America/Los_Angeles' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
