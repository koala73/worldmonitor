import { defineConfig, devices } from '@playwright/test';

const requireWebMcp = process.env.WM_REQUIRE_WEBMCP === '1';
const webMcpProduction = process.env.WM_WEBMCP_PRODUCTION === '1';
const webMcpProductionUrl = process.env.WM_WEBMCP_PRODUCTION_URL?.trim();
const webMcpDeployedShaPresent = Object.hasOwn(process.env, 'WM_WEBMCP_DEPLOYED_SHA');
const webMcpDeployedSha = process.env.WM_WEBMCP_DEPLOYED_SHA?.trim();
const webMcpChromeChannel = process.env.WM_WEBMCP_CHROME_CHANNEL?.trim() || 'chrome';
const webMcpChromeExecutablePath = process.env.WM_WEBMCP_CHROME_EXECUTABLE_PATH?.trim();
const validWebMcpDeployedSha = Boolean(
  webMcpDeployedSha && /^[0-9a-f]{40}$/i.test(webMcpDeployedSha),
);

if (webMcpProduction) {
  if (!requireWebMcp) {
    throw new Error(
      'WM_WEBMCP_PRODUCTION=1 requires WM_REQUIRE_WEBMCP=1 so only the strict WebMCP smoke can target production.',
    );
  }
  if (webMcpProductionUrl !== 'https://www.worldmonitor.app') {
    throw new Error(
      'WM_WEBMCP_PRODUCTION_URL must be https://www.worldmonitor.app for the bounded production smoke.',
    );
  }
  if (!validWebMcpDeployedSha) {
    throw new Error(
      'WM_WEBMCP_DEPLOYED_SHA must record the exact 40-character SHA verified in the deployment control plane.',
    );
  }
} else {
  if (webMcpProductionUrl) {
    throw new Error('WM_WEBMCP_PRODUCTION_URL requires WM_WEBMCP_PRODUCTION=1.');
  }
  if (webMcpDeployedShaPresent && !requireWebMcp) {
    throw new Error(
      'WM_WEBMCP_DEPLOYED_SHA requires WM_REQUIRE_WEBMCP=1 outside production mode.',
    );
  }
  if (webMcpDeployedShaPresent && !validWebMcpDeployedSha) {
    throw new Error(
      'WM_WEBMCP_DEPLOYED_SHA must record an exact 40-character hexadecimal SHA.',
    );
  }
}

export default defineConfig({
  testDir: './e2e',
  preserveOutput: 'always',
  // Production mode is a safety boundary, not merely a base-URL switch. Even
  // when its complete environment tuple is inherited by another npm script,
  // only the bounded read-only/denial WebMCP smoke remains eligible.
  testMatch: webMcpProduction ? '**/webmcp.spec.ts' : undefined,
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
    // Never let a stray production URL retarget ordinary Playwright suites.
    // The environment validation above makes the remote target reachable only
    // through the complete, strict production-smoke tuple.
    baseURL: webMcpProduction ? webMcpProductionUrl : 'http://127.0.0.1:4173',
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
        // The bundled Playwright Chromium can lag the WebMCP origin-trial
        // milestone. Strict smoke runs deliberately use an installed Chrome
        // channel and the command-line equivalent of
        // chrome://flags/#enable-webmcp-testing. If Chrome is absent or too
        // old, the smoke fails instead of silently exercising the no-op path.
        ...(requireWebMcp && !webMcpChromeExecutablePath ? { channel: webMcpChromeChannel } : {}),
        launchOptions: {
          ...(webMcpChromeExecutablePath ? { executablePath: webMcpChromeExecutablePath } : {}),
          args: [
            '--use-angle=swiftshader',
            '--use-gl=swiftshader',
            ...(requireWebMcp && !webMcpProduction ? ['--enable-features=WebMCPTesting'] : []),
          ],
        },
      },
    },
  ],
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  webServer: webMcpProduction
    ? undefined
    : {
        command: 'VITE_E2E=1 npm run dev -- --host 127.0.0.1 --port 4173',
        url: 'http://127.0.0.1:4173/tests/map-harness.html',
        reuseExistingServer: false,
        timeout: 120000,
      },
});
