#!/usr/bin/env node
/**
 * Production-dashboard attribution for issue #7782.
 *
 * The harness builds the real full dashboard with production minification and
 * VITE_E2E instrumentation, waits for the local-ML worker to become available,
 * then runs the dashboard's own per-generation path selector with the committed
 * representative input and the deterministic high-diversity input. The same
 * page and inputs exercise the existing analysis worker for comparison.
 *
 * Usage:
 *   node scripts/profile-news-hybrid-clustering-7782-dashboard.mjs \
 *     docs/perf/news-hybrid-clustering-7782.fixture.json [--samples 3] [--cpu 1,6]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FRAME_BUDGET_MS = 16.7;
export const LONG_TASK_MS = 50;
const DEFAULT_SAMPLES = 3;
const DEFAULT_CPU_RATES = [1, 6];

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    median: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    max: round(sorted.at(-1) ?? 0),
    mean: round(total / Math.max(1, sorted.length)),
  };
}

function pathFrameIntervals(sample, path) {
  if (Array.isArray(sample.pathFrameIntervalsMs)) return sample.pathFrameIntervalsMs;
  return path === 'hybrid' && Array.isArray(sample.coreFrameIntervalsMs)
    ? sample.coreFrameIntervalsMs
    : [];
}

export function buildDashboardCaseSummary(name, path, samples) {
  const coreDurations = samples.map((sample) => sample.coreMs).filter(Number.isFinite);
  const coreFrameBudgetMissCount = samples.filter((sample) =>
    Number(sample.coreMs) >= FRAME_BUDGET_MS
    || (sample.coreFrameIntervalsMs ?? []).some((duration) => Number(duration) >= FRAME_BUDGET_MS),
  ).length;
  const pathFrameBudgetMissCount = samples.filter((sample) =>
    pathFrameIntervals(sample, path).some((duration) => Number(duration) >= FRAME_BUDGET_MS),
  ).length;
  const coreLongTaskCount = samples.reduce(
    (count, sample) => count + (sample.coreLongTasksMs ?? []).filter((duration) => Number(duration) >= LONG_TASK_MS).length,
    0,
  );

  return {
    name,
    path,
    sampleCount: samples.length,
    itemCount: samples[0]?.itemCount ?? 0,
    clusterCount: samples[0]?.clusterCount ?? 0,
    pathProof: {
      selectedEverySample: samples.length > 0 && samples.every((sample) => sample.selectedPath === path),
      mlAvailableEverySample: samples.length > 0 && samples.every((sample) => sample.mlAvailableAtSelection === true),
    },
    totalLatencyMs: summarize(samples.map((sample) => sample.totalLatencyMs)),
    mainThreadTaskMs: summarize(samples.map((sample) => sample.mainThreadTaskMs)),
    coreMs: summarize(coreDurations),
    coreFrameBudgetMissCount,
    pathFrameBudgetMissCount,
    coreLongTaskCount,
    repeatableCoreFrameMiss: coreFrameBudgetMissCount >= 2,
    coldStart: samples.find((sample) => sample.coldStart) ?? null,
    raw: samples,
  };
}

export function decideDashboardAttribution(summaries) {
  const hybrid = summaries.find((summary) => summary.name === 'representative' && summary.path === 'hybrid');
  const worker = summaries.find((summary) => summary.name === 'representative' && summary.path === 'analysis-worker');

  if (!hybrid || !worker) {
    return {
      decision: 'unmet',
      reason: 'Representative hybrid and analysis-worker dashboard samples are both required.',
    };
  }
  if (!hybrid.pathProof.selectedEverySample || !hybrid.pathProof.mlAvailableEverySample) {
    return {
      decision: 'unmet',
      reason: 'The representative hybrid generation was not selected with local ML available for every sample.',
    };
  }
  if (!worker.pathProof.selectedEverySample || hybrid.itemCount !== worker.itemCount) {
    return {
      decision: 'unmet',
      reason: 'The analysis worker did not run on the same representative dashboard input.',
    };
  }

  const repeatableMiss = hybrid.repeatableCoreFrameMiss || hybrid.coreLongTaskCount >= 2;
  if (!repeatableMiss) {
    return {
      decision: 'no-change',
      reason: `No representative dashboard frame miss or ${FRAME_BUDGET_MS} ms core overrun repeated across samples.`,
    };
  }

  const workerReducedOccupancy = worker.mainThreadTaskMs.median < hybrid.mainThreadTaskMs.median;
  const workerRemovedMiss = worker.pathFrameBudgetMissCount < 2
    && worker.pathFrameBudgetMissCount < hybrid.coreFrameBudgetMissCount;
  if (workerReducedOccupancy && workerRemovedMiss) {
    return {
      decision: 'implement',
      reason: 'The existing analysis worker removed a repeatable representative frame-budget miss with lower renderer task occupancy.',
    };
  }

  return {
    decision: 'no-change',
    reason: 'A repeated representative miss was observed, but the existing worker did not improve both frame delivery and renderer task occupancy.',
  };
}

function makeHighDiversity(count) {
  return Array.from({ length: count }, (_, index) => ({
    source: `Outlet${String(index % 47).padStart(2, '0')}`,
    title: `UniqueTopic${index} DistinctEvent${index} Country${index % 173} Marker${index}`,
    link: `https://fixture.test/high-diversity/${index}`,
    publishedAt: Date.UTC(2026, 8, 6, 12, 0, 0) - index * 60_000,
    isAlert: index % 17 === 0,
  }));
}

function parseArgs(argv) {
  const args = {
    fixturePath: 'docs/perf/news-hybrid-clustering-7782.fixture.json',
    samples: DEFAULT_SAMPLES,
    cpuRates: [...DEFAULT_CPU_RATES],
  };
  const rest = argv.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--samples') {
      args.samples = Math.max(1, Number(rest[++index]) || DEFAULT_SAMPLES);
    } else if (value === '--cpu') {
      args.cpuRates = String(rest[++index] ?? '')
        .split(',')
        .map(Number)
        .filter((rate) => Number.isFinite(rate) && rate >= 1);
    } else if (!value.startsWith('--')) {
      args.fixturePath = value;
    }
  }
  if (args.cpuRates.length === 0) throw new Error('At least one positive --cpu rate is required');
  return args;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForUrl(url, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.ok || response.status === 304) return;
    } catch {
      // Preview is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startProductionDashboard() {
  const { build, preview } = await import('vite');
  const port = await freePort();
  process.env.SENTRY_AUTH_TOKEN = '';
  process.env.VITE_SENTRY_DSN = '';
  process.env.VITE_E2E = '1';
  process.env.VITE_VARIANT = 'full';
  const outDir = resolve(ROOT, 'tmp/news-hybrid-dashboard-production');
  const config = {
    mode: 'production',
    customLogger: {
      info: () => {},
      warn: (message) => console.error(message),
      warnOnce: (message) => console.error(message),
      error: (message) => console.error(message),
      clearScreen: () => {},
      hasErrorLogged: () => false,
      hasWarned: false,
    },
    build: { outDir },
  };
  const originalWrite = process.stdout.write;
  try {
    process.stdout.write = process.stderr.write.bind(process.stderr);
    await build(config);
  } finally {
    process.stdout.write = originalWrite;
  }
  const server = await preview({
    ...config,
    preview: { host: '127.0.0.1', port, strictPort: true },
  });
  const url = `http://127.0.0.1:${port}/dashboard`;
  try {
    await waitForUrl(url);
    return { server, url };
  } catch (error) {
    await new Promise((resolveClose) => server.httpServer.close(resolveClose));
    throw error;
  }
}

async function rendererTaskDurationMs(client) {
  const { metrics } = await client.send('Performance.getMetrics');
  const taskDuration = metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0;
  return taskDuration * 1000;
}

async function runPageSample(page, client, path, items, coldStart) {
  await page.evaluate(() => {
    performance.clearMeasures('wm:news-clustering:hybrid-core');
    performance.clearMeasures('wm:news-clustering:path:hybrid');
    performance.clearMeasures('wm:news-clustering:path:analysis-worker');
  });
  const taskBefore = await rendererTaskDurationMs(client);
  const raw = await page.evaluate(async ({ selectedPath, fixtureItems, frameBudgetMs, longTaskMs }) => {
    const hook = window.__wmNewsClusteringProfile;
    if (!hook) throw new Error('Dashboard news-clustering profile hook is unavailable');

    const frames = [];
    let active = true;
    let previousFrame = performance.now();
    const onFrame = (timestamp) => {
      frames.push({ start: previousFrame, end: timestamp, duration: timestamp - previousFrame });
      previousFrame = timestamp;
      if (active) requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
    const longTasks = [];
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ start: entry.startTime, end: entry.startTime + entry.duration, duration: entry.duration });
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // Long Task API is optional; exact core and frame windows remain valid.
    }

    await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    const startedAt = performance.now();
    const result = await hook.run(selectedPath, fixtureItems);
    const endedAt = performance.now();
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    active = false;
    observer?.disconnect();

    const lastMeasure = (name) => performance.getEntriesByName(name).at(-1);
    const pathMeasure = lastMeasure(`wm:news-clustering:path:${selectedPath}`);
    const coreMeasure = selectedPath === 'hybrid'
      ? lastMeasure('wm:news-clustering:hybrid-core')
      : null;
    if (!pathMeasure) throw new Error(`No performance measure recorded for ${selectedPath}`);

    const overlaps = (entry, start, end) => entry.start < end && entry.end > start;
    const pathStart = pathMeasure.startTime;
    const pathEnd = pathStart + pathMeasure.duration;
    const coreStart = coreMeasure?.startTime ?? 0;
    const coreEnd = coreStart + (coreMeasure?.duration ?? 0);
    const pathFrames = frames.filter((entry) => overlaps(entry, pathStart, pathEnd));
    const coreFrames = coreMeasure ? frames.filter((entry) => overlaps(entry, coreStart, coreEnd)) : [];
    const coreLongTasks = coreMeasure ? longTasks.filter((entry) => overlaps(entry, coreStart, coreEnd)) : [];

    return {
      ...result,
      totalLatencyMs: pathMeasure.duration || endedAt - startedAt,
      coreMs: coreMeasure?.duration ?? 0,
      pathFrameIntervalsMs: pathFrames
        .map((entry) => entry.duration)
        .filter((duration) => duration >= frameBudgetMs),
      coreFrameIntervalsMs: coreFrames.map((entry) => entry.duration),
      coreLongTasksMs: coreLongTasks.filter((entry) => entry.duration >= longTaskMs).map((entry) => entry.duration),
      pathFrameBudgetExceeded: pathFrames.some((entry) => entry.duration >= frameBudgetMs),
      coreFrameBudgetExceeded: Boolean(coreMeasure) && (
        coreMeasure.duration >= frameBudgetMs
        || coreFrames.some((entry) => entry.duration >= frameBudgetMs)
      ),
    };
  }, {
    selectedPath: path,
    fixtureItems: items,
    frameBudgetMs: FRAME_BUDGET_MS,
    longTaskMs: LONG_TASK_MS,
  });
  const taskAfter = await rendererTaskDurationMs(client);
  return {
    ...raw,
    coldStart,
    mainThreadTaskMs: round(Math.max(0, taskAfter - taskBefore)),
  };
}

async function installDashboardEnvironment(page) {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('wm-ai-flow-browser-model', 'true');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/api/news/v1/list-feed-digest')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ categories: {}, feedStatuses: {}, generatedAt: new Date(0).toISOString() }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const fixturePath = resolve(ROOT, args.fixturePath);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (!Array.isArray(fixture.items) || fixture.items.length === 0) {
    throw new Error('A nonempty representative fixture is required');
  }
  const cases = {
    representative: fixture.items,
    highDiversity1500: makeHighDiversity(1500),
  };

  mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
  const { server, url } = await startProductionDashboard();
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--use-gl=swiftshader'],
  });
  const reports = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const consoleMessages = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('[MLWorker]') || text.includes('[App] Initialization failed')) {
        consoleMessages.push(text);
      }
    });
    page.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.message}`));
    await installDashboardEnvironment(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.__wmNewsClusteringProfile), null, { timeout: 60_000 });
    await page.waitForFunction(
      () => document.documentElement.dataset.wmInitialDataReady === 'true',
      null,
      { timeout: 120_000 },
    );
    try {
      await page.waitForFunction(
        () => window.__wmNewsClusteringProfile?.getState().mlAvailable === true,
        null,
        { timeout: 60_000 },
      );
    } catch (error) {
      const state = await page.evaluate(() => window.__wmNewsClusteringProfile?.getState() ?? null);
      throw new Error(
        `Local ML did not become available: ${JSON.stringify({ state, consoleMessages })}`,
        { cause: error },
      );
    }

    const assetScripts = await page.locator('script[src]').evaluateAll((scripts) =>
      scripts.map((script) => script.getAttribute('src')),
    );
    if (assetScripts.some((src) => src?.includes('/@vite/')) || !assetScripts.some((src) => src?.startsWith('/assets/'))) {
      throw new Error('Profile did not load production-built dashboard assets');
    }

    const client = await context.newCDPSession(page);
    await client.send('Performance.enable');
    const firstByPath = new Set();
    for (const cpuThrottleRate of args.cpuRates) {
      await client.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottleRate });
      for (const [name, items] of Object.entries(cases)) {
        for (const path of ['hybrid', 'analysis-worker']) {
          const samples = [];
          for (let index = 0; index < args.samples; index += 1) {
            const coldStart = !firstByPath.has(path);
            samples.push(await runPageSample(page, client, path, items, coldStart));
            firstByPath.add(path);
            await delay(100);
          }
          reports.push({
            cpuThrottleRate,
            ...buildDashboardCaseSummary(name, path, samples),
          });
        }
      }
    }

    const decisionAtSlowCpu = decideDashboardAttribution(
      reports.filter((report) => report.cpuThrottleRate === Math.max(...args.cpuRates)),
    );
    const report = {
      issue: 7782,
      generatedAt: new Date().toISOString(),
      surface: 'production-minified full dashboard with local ML available',
      host: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        userAgent: await page.evaluate(() => navigator.userAgent),
      },
      build: {
        productionMinify: true,
        viteE2EInstrumentation: true,
        graphics: 'SwiftShader (headless capability support; clustering is CPU-attributed)',
        assetScripts,
      },
      fixture: {
        path: args.fixturePath,
        capturedAt: fixture.capturedAt ?? null,
        generatedAt: fixture.generatedAt ?? null,
        source: fixture.source ?? null,
      },
      budgets: { frameMs: FRAME_BUDGET_MS, longTaskMs: LONG_TASK_MS },
      samplesPerCaseAndPath: args.samples,
      cpuThrottleRates: args.cpuRates,
      cases: reports,
      gate: decisionAtSlowCpu,
    };
    const outputPath = resolve(ROOT, 'tmp/news-hybrid-clustering-7782-dashboard.json');
    writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolveClose) => server.httpServer.close(resolveClose));
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
