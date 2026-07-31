import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 90000,
  expect: {
    timeout: 30000,
  },
  // One retry in CI, none locally (#5685). Playwright can throw from its own
  // event dispatch — `Object with guid response@<id> was not bound in the
  // connection` — when the client receives a `response` event referencing an
  // object it cannot resolve. That fires BEFORE any listener body runs, so no
  // defensive code in a spec can prevent it: variant-live-smoke's capture
  // helper already try/catches every accessor it touches and the throw still
  // escaped, reddening a required gate 2.3s into a boot test whose own
  // assertions had not yet run.
  //
  // A retry cannot hide a deterministic failure — that fails both attempts.
  // When the second attempt passes, Playwright reports the test as `flaky`
  // rather than silently green, so a genuine product race still surfaces.
  // Local runs stay at 0 so a flake is felt immediately while iterating.
  retries: process.env.CI ? 1 : 0,
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
