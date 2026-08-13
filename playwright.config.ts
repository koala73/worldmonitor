import { defineConfig, devices } from '@playwright/test';

const localChromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: './e2e',
  // CI: the smoke specs are dominated by fixed settle windows (eight 8 s
  // waits in dashboard-news-request-budget alone), so running them serially
  // just stacks idle sleeps — 4 workers overlap them. Tests already isolate
  // via per-test contexts and fresh seeded profiles. Locally stay at 1 so a
  // dev run keeps deterministic ordering and predictable machine load.
  // fullyParallel lets tests WITHIN a file spread across workers; with 1
  // worker (local) it changes nothing.
  workers: process.env.CI ? 4 : 1,
  fullyParallel: true,
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
    // A locally supplied browser can run the E2E suite without Playwright's
    // bundled ffmpeg; CI and pinned-browser runs retain failure video.
    video: localChromiumExecutable ? 'off' : 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-angle=swiftshader', '--use-gl=swiftshader'],
          // CI keeps Playwright's pinned Chromium. Local verification can
          // explicitly opt into an installed Chromium-compatible executable
          // when the pinned test runtime is unavailable.
          ...(localChromiumExecutable ? { executablePath: localChromiumExecutable } : {}),
        },
      },
    },
  ],
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  webServer: {
    // Invoke the project's locked Vite binary directly. This keeps the E2E
    // server independent of an ambient npm executable, while cross-env still
    // supplies a portable VITE_E2E assignment on Windows and POSIX shells.
    command: 'node node_modules/cross-env/dist/bin/cross-env.js VITE_E2E=1 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/tests/map-harness.html',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
