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
  forbidOnly: Boolean(process.env.CI),
  preserveOutput: 'always',
  // Production mode is a safety boundary, not merely a base-URL switch. Even
  // when its complete environment tuple is inherited by another npm script,
  // only the bounded read-only/denial WebMCP smoke remains eligible.
  testMatch: webMcpProduction ? '**/webmcp.spec.ts' : undefined,
  // CI: the smoke specs are dominated by fixed settle windows (eight 8 s
  // waits in dashboard-news-request-budget alone), so running them serially
  // just stacks idle sleeps — overlapping workers hide them. Tests already
  // isolate via per-test contexts and fresh seeded profiles. Locally stay at 1
  // so a dev run keeps deterministic ordering and predictable machine load.
  // fullyParallel lets tests WITHIN a file spread across workers; with 1
  // worker (local) it changes nothing.
  //
  // 4 -> 2 to test the last surviving hypothesis for the #8447 browser
  // crashes. All four crashes analysed in detail sit in the top 10-20% of
  // process-churn moments within their own run, and 4 workers on a 2-core
  // runner is the churn. Measured cost of halving: 45.2 s -> 74.4 s on a
  // two-spec subset, 1.64x rather than 2x because the settle windows above
  // are wall-clock, not CPU.
  //
  // The crash rate fell, so 2 stays. The baseline was 50 crashes across 76
  // shard-runs (47% of runs affected). The #8449 annotations then counted 0
  // crashes across 91 main shard-runs on 3-4 November 2026. Going back to 4
  // also bought only ~15% (see the variant-smoke-shards comment in test.yml).
  workers: process.env.CI ? 2 : 1,
  fullyParallel: true,
  timeout: 90000,
  expect: {
    timeout: 30000,
  },
  // No retries, in CI or locally. A test that passes only on a second attempt
  // has a bug, and a retry hides it: CI reported it `flaky` and the job went
  // green. CI ran with one retry from #5685 to absorb chrome-headless-shell
  // SIGTRAP exits (#8447), which turned most browser crashes into passing runs.
  // That crash is gone: BrowserCrashReporter counted 0 across 1229 smoke jobs
  // in 150 Test runs on 15-16 November 2026, after 0 across 91 main shard-runs
  // on 3-4 November. A crash now fails the job, as it should.
  retries: 0,
  // `list` for humans, crash accounting for the record. The crash reporter is
  // separate from `attachBrowserLossDiagnostics` (#6501), which is per spec and
  // sees only the files that opt in; this one counts browser process exits
  // across the whole run, so a crash in any spec is reported even when the job
  // ends green. See e2e/browser-crash-reporter.ts.
  reporter: [
    ['list'],
    ['./e2e/browser-crash-reporter.ts'],
  ],
  use: {
    // Never let a stray production URL retarget ordinary Playwright suites.
    // The environment validation above makes the remote target reachable only
    // through the complete, strict production-smoke tuple.
    baseURL: webMcpProduction ? webMcpProductionUrl : 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 720 },
    colorScheme: 'dark',
    // Reduced motion trips the global rule in index.html that ends every CSS
    // animation and transition at once. Headless Chromium paints each frame of
    // them in software (SwiftShader), and the loading skeletons, spinners and
    // pulses on a dashboard full of fixtures kept the runner's CPU busy for no
    // assertion. Probe runs 45554467245 and 45558531419 (smoke shards 2 and 6,
    // three runs a side): test-seconds fell 25% (3238 -> 2421 over the same 498
    // tests, all passing) and the GPU process's CPU about 3x. Specs that measure
    // what a user sees while things move (CLS, LCP, first paint) opt back into
    // 'no-preference' with test.use.
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // No video. `retain-on-failure` records EVERY test and deletes the video
    // when it passes, so a green shard pays for video it then throws away: 34
    // ffmpeg processes for 28 passing tests on shard 2, 54 for 76 on shard 1
    // (runs 35579482854 and 35563542710). The previous `on-first-retry`
    // recorded only retries, and there are none now. The retained trace above
    // already carries a screencast of the failed attempt.
    video: 'off',
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
          // Do NOT drop `--disable-breakpad` to chase the SIGTRAP crashes in
          // #8447. CI runs chromium_headless_shell, and that bundle ships no
          // `chrome_crashpad_handler` binary, so enabling breakpad aborts the
          // browser at launch rather than producing a minidump:
          //   FATAL:third_party/crashpad/.../spawn_subprocess.cc:237
          //   posix_spawn .../chrome_crashpad_handler
          // Every test then fails in single-digit milliseconds with
          // `browserType.launch: Target page, context or browser has been
          // closed` (run 35570837267). Only the full `chromium-<rev>` build
          // carries the handler, so minidumps need a different browser, not a
          // different flag.
          args: [
            '--use-angle=swiftshader',
            '--use-gl=swiftshader',
            // Chrome 156 exposes document.modelContext under WebMCPTesting;
            // Chrome 157 ignores that name and needs WebMCP (verified on
            // 156.0.8078.80 and 157.0.8103.78). Chrome drops unknown feature
            // names, so passing both covers a runner image on either major.
            // Run 43225352341 failed 9 tests on a 157 image with this flag alone.
            ...(requireWebMcp && !webMcpProduction ? ['--enable-features=WebMCPTesting,WebMCP'] : []),
          ],
        },
      },
    },
  ],
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  webServer: webMcpProduction
    ? undefined
    : {
        // WM_E2E_OFFLINE keeps the dev server's own handlers off the network
        // (shared/e2e-dev-network-guard.ts); page.route only reaches the browser.
        command: 'VITE_E2E=1 WM_E2E_OFFLINE=1 npm run dev -- --host 127.0.0.1 --port 4173',
        url: 'http://127.0.0.1:4173/tests/map-harness.html',
        reuseExistingServer: false,
        timeout: 120000,
      },
});
