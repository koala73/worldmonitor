#!/usr/bin/env node
/**
 * Trade-animation rebuild attribution harness (#7781).
 *
 * Drives the settled map harness through a 61-frame animation window with a
 * fixed overlay fixture (nuclear + data-center detail + trade routes on/off).
 * Attributes main-thread JS build vs deck.gl setProps commit, long tasks, and
 * missed display frames. Pure summarizers are exported so CI can lock the
 * decision math without launching a browser.
 *
 * Usage:
 *   node scripts/measure-trade-animation-rebuild.mjs [--url URL] [--cpu 4]
 *     [--repeats 3] [--frames 61] [--warmup 20] [--json]
 *     [--software-gl] [--headed] [--start-server]
 *
 * Default URL: http://127.0.0.1:4173/tests/map-harness.html?alert=false
 * --start-server builds production assets and serves them with Vite preview.
 * Software WebGL (SwiftShader) is labeled and is not a hardware FPS claim.
 */
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const FRAME_BUDGET_MS = 16;
export const LONGTASK_MS = 50;
export const MISSED_FRAME_MS = 20;
export const MATERIAL_PER_BUILD_MS = 1;
export const REPEATABLE_OVER_BUDGET = 3;

function round(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function summarizeLongTasks(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const totalMs = list.reduce((sum, entry) => sum + (Number(entry?.duration) || 0), 0);
  const longTaskCount = list.filter((entry) => (Number(entry?.duration) || 0) > LONGTASK_MS).length;
  const tbtMs = list.reduce(
    (sum, entry) => sum + Math.max(0, (Number(entry?.duration) || 0) - LONGTASK_MS),
    0,
  );
  return {
    taskCount: list.length,
    longTaskCount,
    totalMs: round(totalMs),
    tbtMs: round(tbtMs),
  };
}

export function summarizeProfile(profile) {
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const totals = samples.map((sample) => Number(sample.totalMs) || 0);
  const jsBuilds = samples.map((sample) => Number(sample.jsBuildMs) || 0);
  const deckCommits = samples.map((sample) => Number(sample.deckCommitMs) || 0);
  const rafIntervals = Array.isArray(profile?.rafIntervalsMs) ? profile.rafIntervalsMs.map(Number) : [];
  const identitySamples = samples.slice(1);
  const nuclearChanges = identitySamples.filter((sample) => sample.nuclearIdentityChanged).length;
  const tripsChanges = identitySamples.filter((sample) => sample.tripsIdentityChanged).length;
  const overBudgetCount = totals.filter((value) => value > FRAME_BUDGET_MS).length;
  const missedFrameCount = rafIntervals.filter((value) => value > MISSED_FRAME_MS).length;
  const recordedBuildCount = Number(profile?.buildCount);
  const buildCount = Number.isFinite(recordedBuildCount) ? recordedBuildCount : samples.length;

  return {
    displayFrames: Number(profile?.displayFrames) || 0,
    warmupFrames: Number(profile?.warmupFrames) || 0,
    zoom: Number(profile?.zoom) || 0,
    enabledLayers: Array.isArray(profile?.enabledLayers) ? [...profile.enabledLayers] : [],
    buildCount,
    hintCallCount: Number(profile?.hintCallCount) || 0,
    hintScanCount: Number(profile?.hintScanCount) || 0,
    sampleCount: samples.length,
    totalMs: round(totals.reduce((sum, value) => sum + value, 0)),
    jsBuildMs: round(jsBuilds.reduce((sum, value) => sum + value, 0)),
    deckCommitMs: round(deckCommits.reduce((sum, value) => sum + value, 0)),
    maxTotalMs: round(Math.max(0, ...totals)),
    p95TotalMs: round(percentile(totals, 95)),
    meanTotalMs: round(totals.length ? totals.reduce((sum, value) => sum + value, 0) / totals.length : 0),
    meanJsBuildMs: round(jsBuilds.length ? jsBuilds.reduce((sum, value) => sum + value, 0) / jsBuilds.length : 0),
    meanDeckCommitMs: round(
      deckCommits.length ? deckCommits.reduce((sum, value) => sum + value, 0) / deckCommits.length : 0,
    ),
    overBudgetCount,
    missedFrameCount,
    nuclearIdentityChanges: nuclearChanges,
    tripsIdentityChanges: tripsChanges,
    longTasks: summarizeLongTasks(profile?.longTasks),
    fixture: profile?.fixture ?? null,
    glRenderer: profile?.glRenderer ?? null,
  };
}

export function isSoftwareGlRenderer(glRenderer) {
  const text = String(glRenderer || '').toLowerCase();
  return text.includes('swiftshader') || text.includes('llvmpipe') || /\bsoftware\b/.test(text);
}

export function decideTradeAnimationIsolation(tradeOn, tradeOff, options = {}) {
  const softwareGl = Boolean(options.softwareGl) || isSoftwareGlRenderer(tradeOn?.glRenderer);
  const hardware = Boolean(options.hardware) && !softwareGl;
  const perBuildOn = tradeOn.buildCount
    ? tradeOn.totalMs / tradeOn.buildCount
    : 0;
  const perBuildOff = tradeOff.buildCount
    ? tradeOff.totalMs / tradeOff.buildCount
    : 0;
  const extraPerBuildMs = round(Math.max(0, perBuildOn - perBuildOff));
  const extraTotalMs = round(Math.max(0, tradeOn.totalMs - tradeOff.totalMs));
  const extraOverBudget = (Number(tradeOn.overBudgetCount) || 0) - (Number(tradeOff.overBudgetCount) || 0);
  const extraLongTasks =
    (Number(tradeOn.longTasks?.longTaskCount) || 0) - (Number(tradeOff.longTasks?.longTaskCount) || 0);
  const extraMissedFrames =
    (Number(tradeOn.missedFrameCount) || 0) - (Number(tradeOff.missedFrameCount) || 0);
  const repeatableBudgetMiss = extraOverBudget >= REPEATABLE_OVER_BUDGET;
  const repeatableLongTask = extraLongTasks >= 2;
  const repeatableMissedFrames = extraMissedFrames >= REPEATABLE_OVER_BUDGET;
  const rebuildCausedMiss = extraPerBuildMs >= MATERIAL_PER_BUILD_MS || repeatableBudgetMiss;

  if (!tradeOn.buildCount) {
    return {
      decision: 'unmet',
      reason: 'No animation-driven updateLayers samples were recorded with trade routes enabled.',
      extraPerBuildMs,
      extraTotalMs,
    };
  }

  const fpsOnly = repeatableMissedFrames && !repeatableBudgetMiss && !repeatableLongTask;
  if (fpsOnly && !hardware) {
    return {
      decision: 'unmet',
      reason:
        softwareGl ? 'Only software-GL missed frames were observed. That is not a hardware frame-budget miss; re-run headed without SwiftShader.' : 'Missed frames were observed without a verified hardware renderer; hardware attribution is unmet.',
      extraPerBuildMs,
      extraTotalMs,
    };
  }

  if ((repeatableBudgetMiss || repeatableLongTask || (repeatableMissedFrames && hardware)) && rebuildCausedMiss) {
    return {
      decision: 'implement',
      reason:
        'Unrelated rebuilds contributed to a repeatable main-thread budget miss versus the trade-off fixture.',
      extraPerBuildMs,
      extraTotalMs,
    };
  }

  return {
    decision: 'no-change',
    reason:
      'No repeatable main-thread frame/interaction budget miss was attributable to unrelated layer rebuilds.',
    extraPerBuildMs,
    extraTotalMs,
  };
}

export function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:4173/tests/map-harness.html?alert=false',
    cpu: 1,
    repeats: 3,
    frames: 61,
    warmup: 20,
    json: false,
    softwareGl: false,
    headed: false,
    startServer: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--cpu') args.cpu = Number(rest[++i]) || 1;
    else if (flag === '--repeats') args.repeats = Number(rest[++i]) || 1;
    else if (flag === '--frames') args.frames = Number(rest[++i]) || 61;
    else if (flag === '--warmup') args.warmup = Number(rest[++i]) || 0;
    else if (flag === '--json') args.json = true;
    else if (flag === '--software-gl') args.softwareGl = true;
    else if (flag === '--headed') args.headed = true;
    else if (flag === '--start-server') args.startServer = true;
    else if (flag === '--url') args.url = String(rest[++i] || args.url);
    else if (!flag.startsWith('--')) args.url = flag;
  }
  return args;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForUrl(url, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.ok || response.status === 304) return;
    } catch {
      // Server not up yet.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startViteServer() {
  const { build, preview } = await import('vite');
  const port = await freePort();
  // A local measurement must never publish source maps or runtime telemetry.
  process.env.SENTRY_AUTH_TOKEN = '';
  process.env.VITE_SENTRY_DSN = '';
  process.env.VITE_E2E = '1';
  process.env.VITE_VARIANT = 'full';
  const outDir = resolve('tmp/trade-animation-production');
  const config = {
    mode: 'production',
    // Keep machine-readable stdout reserved for the report.
    customLogger: { info: () => {}, warn: (msg) => console.error(msg),
      warnOnce: (msg) => console.error(msg), error: (msg) => console.error(msg),
      clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false },
    build: { outDir, rollupOptions: { input: { mapHarness: resolve('tests/map-harness.html') } } },
  };
  const originalWrite = process.stdout.write;
  try {
    process.stdout.write = process.stderr.write.bind(process.stderr);
    await build(config);
  } finally {
    process.stdout.write = originalWrite;
  }
  const server = await preview({ ...config, preview: { host: '127.0.0.1', port, strictPort: true } });
  const url = `http://127.0.0.1:${port}/tests/map-harness.html?alert=false`;
  try {
    await waitForUrl(url);
    return { server, url };
  } catch (error) {
    await new Promise((resolve) => server.httpServer.close(resolve));
    throw error;
  }
}

async function runProfile(page, options) {
  await page.waitForFunction(() => Boolean(window.__mapHarness?.ready), null, { timeout: 30_000 });
  if (await page.locator('.layer-warn-overlay').count()) throw new Error('Dismiss the layer warning before profiling; it obscures the map');
  return page.evaluate(async (profileOptions) => {
    const harness = window.__mapHarness;
    if (!harness?.runTradeAnimationProfile) {
      throw new Error('map harness is missing runTradeAnimationProfile');
    }
    return harness.runTradeAnimationProfile(profileOptions);
  }, options);
}

async function measure(args) {
  const { chromium } = await import('@playwright/test');
  const launchArgs = args.softwareGl
    ? ['--use-angle=swiftshader', '--use-gl=swiftshader']
    : [];
  const browser = await chromium.launch({
    headless: !args.headed,
    args: launchArgs,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    if (args.cpu > 1) {
      await client.send('Emulation.setCPUThrottlingRate', { rate: args.cpu });
    }
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const tradeOn = [];
    const tradeOff = [];
    for (let i = 0; i < args.repeats; i++) {
      // Alternate order to reduce warm-cache and elapsed-time bias.
      for (const on of i % 2 === 0 ? [true, false] : [false, true]) {
        const profile = await runProfile(page, {
          displayFrames: args.frames, warmupFrames: args.warmup, zoom: 5,
          enabledLayers: on ? ['nuclear', 'datacenters', 'tradeRoutes'] : ['nuclear', 'datacenters'],
          includeNews: true,
        });
        (on ? tradeOn : tradeOff).push(profile);
        if (on && i === args.repeats - 1) await page.screenshot({ path: 'tmp/trade-animation-profile.png' });
      }
    }
    const assetScripts = await page.locator('script[src]').evaluateAll((scripts) => scripts.map((s) => s.getAttribute('src')));
    if (args.startServer && (assetScripts.some((src) => src.includes('/@vite/')) || !assetScripts.some((src) => src.startsWith('/assets/')))) {
      throw new Error('Profile did not load production-built assets');
    }
    const userAgent = await page.evaluate(() => navigator.userAgent);
    return { tradeOn, tradeOff, userAgent, assetScripts };
  } finally {
    await browser.close();
  }
}

function meanSummaries(summaries) {
  if (!summaries.length) {
    return summarizeProfile({});
  }
  const first = summaries[0];
  const average = (select) => round(summaries.reduce((sum, item) => sum + select(item), 0) / summaries.length);
  return {
    ...first,
    buildCount: average((item) => item.buildCount),
    hintCallCount: average((item) => item.hintCallCount),
    hintScanCount: average((item) => item.hintScanCount),
    sampleCount: average((item) => item.sampleCount),
    totalMs: average((item) => item.totalMs),
    jsBuildMs: average((item) => item.jsBuildMs),
    deckCommitMs: average((item) => item.deckCommitMs),
    maxTotalMs: round(Math.max(...summaries.map((item) => item.maxTotalMs))),
    p95TotalMs: average((item) => item.p95TotalMs),
    meanTotalMs: average((item) => item.meanTotalMs),
    meanJsBuildMs: average((item) => item.meanJsBuildMs),
    meanDeckCommitMs: average((item) => item.meanDeckCommitMs),
    overBudgetCount: average((item) => item.overBudgetCount),
    missedFrameCount: average((item) => item.missedFrameCount),
    nuclearIdentityChanges: average((item) => item.nuclearIdentityChanges),
    tripsIdentityChanges: average((item) => item.tripsIdentityChanges),
    longTasks: {
      taskCount: average((item) => item.longTasks.taskCount),
      longTaskCount: average((item) => item.longTasks.longTaskCount),
      totalMs: average((item) => item.longTasks.totalMs),
      tbtMs: average((item) => item.longTasks.tbtMs),
    },
  };
}

export function buildReport(result, args) {
  const onSummaries = (result?.tradeOn || []).map(summarizeProfile);
  const offSummaries = (result?.tradeOff || []).map(summarizeProfile);
  const tradeOn = meanSummaries(onSummaries);
  const tradeOff = meanSummaries(offSummaries);
  const softwareGl = Boolean(args?.softwareGl) || isSoftwareGlRenderer(tradeOn.glRenderer);
  const hardwareGl = /Apple|NVIDIA|AMD|Intel|Adreno|Mali|PowerVR|Radeon/i.test(tradeOn.glRenderer || '') && !softwareGl;
  const decision = decideTradeAnimationIsolation(tradeOn, tradeOff, {
    softwareGl,
    hardware: hardwareGl && Boolean(args?.headed),
  });
  return {
    generatedAt: new Date().toISOString(),
    url: args?.url,
    surface: args?.startServer ? 'Vite production build + preview' : 'externally supplied URL; build unverified',
    cpuThrottleRate: Number(args?.cpu) || 1,
    repeats: Number(args?.repeats) || 1,
    softwareGl,
    hardwareGl,
    headed: Boolean(args?.headed),
    userAgent: result?.userAgent ?? null,
    assetScripts: result?.assetScripts ?? [],
    tradeOn,
    tradeOff,
    decision,
    repeatsRaw: {
      tradeOn: result.tradeOn,
      tradeOff: result.tradeOff,
    },
  };
}

function printHuman(report) {
  const gl = report.tradeOn.glRenderer || 'unknown';
  console.log(`\nTrade-animation rebuild profile (#7781)`);
  console.log(`URL: ${report.url}`);
  console.log(`CPU throttle: ${report.cpuThrottleRate}x  repeats: ${report.repeats}`);
  console.log(`GL: ${gl}`);
  console.log(`Software GL: ${report.softwareGl}  headed: ${report.headed}`);
  console.log(`UA: ${report.userAgent || 'unknown'}\n`);
  const printSide = (label, side) => {
    console.log(label);
    console.log(`  builds=${side.buildCount}  samples=${side.sampleCount}  layers=${side.enabledLayers.join(',')}`);
    console.log(
      `  total=${side.totalMs}ms  jsBuild=${side.jsBuildMs}ms  deckCommit=${side.deckCommitMs}ms  mean/frame=${side.meanTotalMs}ms  p95=${side.p95TotalMs}ms  max=${side.maxTotalMs}ms`,
    );
    console.log(
      `  overBudget(> ${FRAME_BUDGET_MS}ms)=${side.overBudgetCount}  missedFrames(>${MISSED_FRAME_MS}ms)=${side.missedFrameCount}  longTasks>${LONGTASK_MS}ms=${side.longTasks.longTaskCount} tbt=${side.longTasks.tbtMs}ms`,
    );
    console.log(
      `  hintCalls=${side.hintCallCount} hintScans=${side.hintScanCount} nuclearNew=${side.nuclearIdentityChanges} tripsNew=${side.tripsIdentityChanges}`,
    );
    if (side.fixture) {
      console.log(
        `  fixture nuclear=${side.fixture.nuclearCount} datacenters=${side.fixture.datacenterCount} segments=${side.fixture.routeSegments} trips=${side.fixture.trips} chokepoints=${side.fixture.chokepoints} news=${side.fixture.newsMarkers}`,
      );
    }
  };
  printSide('Trade routes ON', report.tradeOn);
  printSide('Trade routes OFF', report.tradeOff);
  console.log(`\nDecision: ${report.decision.decision}`);
  console.log(`  ${report.decision.reason}`);
  console.log(`  extra per build: ${report.decision.extraPerBuildMs}ms  extra total: ${report.decision.extraTotalMs}ms`);
  console.log('\nSoftware-GL FPS is not a hardware speedup. Trust attributed main-thread buckets.\n');
}

async function main() {
  const args = parseArgs(process.argv);
  let server = null;
  try {
    if (args.startServer) {
      server = await startViteServer();
      args.url = server.url;
    }
    const result = await measure(args);
    const report = buildReport(result, args);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (report.decision.decision === 'implement') process.exitCode = 2;
  } finally {
    if (server?.server) await new Promise((resolve) => server.server.httpServer.close(resolve));
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
