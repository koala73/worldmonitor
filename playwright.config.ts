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
  // REVERT THIS if the crash rate does not fall. The annotations from #8449
  // measure it on every merge; the baseline is 50 crashes across 76
  // shard-runs, 47% of runs affected.
  workers: process.env.CI ? 2 : 1,
  fullyParallel: true,
  timeout: 90000,
  expect: {
    timeout: 30000,
  },
  // One retry in CI, none locally (#5685). The retry was added for `Object
  // with guid response@<id> was not bound in the connection`, described then as
  // Playwright throwing from its own event dispatch. That diagnosis was wrong
  // (#8447). The message is what the client prints when the connection dies
  // with responses in flight, and the cause is the browser process exiting with
  // SIGTRAP mid-navigation. Six main runs separate cleanly: 0 crashes green,
  // 1 crash reported `flaky` because the retry absorbed it, 2 crashes red
  // because the crash recurred on the retry.
  //
  // So this retry is load-bearing in the worst way. It converts most browser
  // crashes into a passing run, which is why the browser-loss diagnostics this
  // job has collected since #5685 went unread for months. Leave it at 1 while
  // the crash is being diagnosed and let the SIGTRAP check in test.yml do the
  // reporting, then revisit. Local runs stay at 0 so a flake is felt
  // immediately while iterating.
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
    // `retain-on-failure` records EVERY test and deletes the video when it
    // passes, so a green shard pays for video it then throws away: 34 ffmpeg
    // processes for 28 passing tests on shard 2, 54 for 76 on shard 1
    // (runs 35579482854 and 35563542710). One ffmpeg per context, spawned and
    // killed alongside the browser.
    //
    // `on-first-retry` records only the retry attempt. CI runs with
    // retries: 1, so a deterministic failure still gets video, because its
    // retry fails too and is recorded.
    //
    // The real cost is flaky tests. `preserveVideo` in playwright/lib/index.js
    // keys on the PER-ATTEMPT status (`testInfo.status !== expectedStatus`), so
    // `retain-on-failure` keeps the failed first attempt even when the retry
    // passes; `on-first-retry` records the retry regardless of its outcome. So
    // for a flake we trade a video of the failure for a video of the pass.
    // Accepted because the browser crashes in #8447 kill the recording anyway
    // and are diagnosed from the pw:browser log, which this does not touch.
    video: 'on-first-retry',
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
