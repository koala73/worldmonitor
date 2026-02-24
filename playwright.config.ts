import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 90000,
  expect: {
    timeout: 30000,
  },
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 720 },
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-angle=swiftshader', '--use-gl=swiftshader'],
        },
      },
    },
  ],
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  webServer: {
    command: 'VITE_E2E=1 npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/tests/map-harness.html',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
