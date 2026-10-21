#!/usr/bin/env node
/**
 * Browser/CPU-throttled twin of scripts/profile-news-hybrid-clustering-7782.mjs.
 * Bundles the shared clustering core with production minify, then times the
 * synchronous Jaccard stage and a real analysis-worker round trip in Chromium.
 *
 * Usage:
 *   node scripts/profile-news-hybrid-clustering-7782-browser.mjs <minimized-fixture.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { bundleProfileInput, bundleAnalysisWorker, budgetEvidence } from './news-clustering-profile-input.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAME_BUDGET_MS = 16.7;
const LONG_TASK_MS = 50;
const SAMPLES = 9;
const CPU_RATES = [1, 4, 6];

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    median: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sum / Math.max(sorted.length, 1)),
  };
}

function makeHighDiversity(count) {
  return Array.from({ length: count }, (_, i) => ({
    source: `Outlet${String(i % 47).padStart(2, '0')}`,
    title: `UniqueTopic${i} DistinctEvent${i} Country${i % 173} Marker${i}`,
    link: `https://fixture.test/high-diversity/${i}`,
    publishedAt: Date.UTC(2026, 8, 6, 12, 0, 0) - i * 60_000,
    isAlert: i % 17 === 0,
  }));
}

async function measurePage(page, items, samples, workerSource) {
  return page.evaluate(async ({ items: fixtureItems, samples: sampleCount, longTaskMs, workerSource }) => {
    const news = fixtureItems.map(globalThis.NewsClustering.protoItemToNewsItem);

    const longtasks = [];
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longtasks.push({ duration: entry.duration, startTime: entry.startTime });
        }
      });
      observer.observe({ type: 'longtask' });
    } catch {
      /* longtask unsupported */
    }

    const clusteringApi = globalThis.NewsClustering;
    if (typeof clusteringApi?.clusterNewsCore !== 'function') {
      throw new Error('NewsClustering bundle did not export clusterNewsCore');
    }

    const yieldTick = () => new Promise((resolve) => setTimeout(resolve, 0));
    await yieldTick();
    const syncTimings = [];
    const syncWindows = [];
    let clusterCount = 0;
    clusteringApi.clusterNewsCore(news, clusteringApi.getSourceTier);
    await yieldTick();
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      const clusters = clusteringApi.clusterNewsCore(news, clusteringApi.getSourceTier);
      const end = performance.now();
      syncTimings.push(end - start);
      syncWindows.push({ start, end });
      clusterCount = clusters.length;
      await yieldTick();
    }
    const clusteringLongTasks = longtasks.filter((task) => syncWindows.some(({ start, end }) => task.startTime < end && task.startTime + task.duration > start));

    const serializeTimings = [];
    let itemBytes = 0;
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      const json = JSON.stringify(news);
      JSON.parse(json);
      serializeTimings.push(performance.now() - start);
      itemBytes = new Blob([json]).size;
      await yieldTick();
    }

    const cloneTimings = [];
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      structuredClone(news);
      cloneTimings.push(performance.now() - start);
      await yieldTick();
    }

    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    function spawnWorker() { return new Worker(workerUrl); }

    const workerMainThreadTimings = [];
    function requestCluster(worker, payload) {
      return new Promise((resolve, reject) => {
        let postMs = 0;
        const timer = setTimeout(() => reject(new Error('Worker profile request timed out')), 30_000);
        const onMessage = (event) => {
          if (event.data?.type === 'ready') return;
          clearTimeout(timer);
          worker.removeEventListener('message', onMessage);
          const start = performance.now();
          const clusters = hydrateWorkerClusters(event.data);
          workerMainThreadTimings.push(postMs + performance.now() - start);
          resolve(clusters);
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', reject, { once: true });
        const postStart = performance.now();
        worker.postMessage({ type: 'cluster', id: 'profile', items: payload, sourceTiers: clusteringApi.SOURCE_TIERS });
        postMs = performance.now() - postStart;
      });
    }

    function hydrateWorkerClusters(message) {
      const clusters = Array.isArray(message?.clusters) ? message.clusters : [];
      return clusters.map((cluster) => ({
        ...cluster,
        firstSeen: new Date(cluster.firstSeen),
        lastUpdated: new Date(cluster.lastUpdated),
        allItems: (cluster.allItems ?? []).map((item) => ({
          ...item,
          pubDate: new Date(item.pubDate),
        })),
      }));
    }

    const payload = news;
    const expected = JSON.stringify(clusteringApi.clusterNewsCore(news, clusteringApi.getSourceTier));
    function assertParity(clusters) {
      if (JSON.stringify(clusters) !== expected) throw new Error('Real analysis worker output differs from synchronous clustering');
    }

    const coldStarted = performance.now();
    const coldWorker = spawnWorker();
    await new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.data?.type === 'ready') {
          coldWorker.removeEventListener('message', onMessage);
          resolve();
        }
      };
      coldWorker.addEventListener('message', onMessage);
      coldWorker.addEventListener('error', reject, { once: true });
    });
    const coldReadyMs = performance.now() - coldStarted;
    const coldRequestStarted = performance.now();
    const coldClusters = await requestCluster(coldWorker, payload);
    const coldRoundTripMs = performance.now() - coldRequestStarted;
    assertParity(coldClusters);
    coldWorker.terminate();

    const warmWorker = spawnWorker();
    await new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.data?.type === 'ready') {
          warmWorker.removeEventListener('message', onMessage);
          resolve();
        }
      };
      warmWorker.addEventListener('message', onMessage);
      warmWorker.addEventListener('error', reject, { once: true });
    });
    assertParity(await requestCluster(warmWorker, payload));
    const warmTimings = [];
    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now();
      const clusters = await requestCluster(warmWorker, payload);
      warmTimings.push(performance.now() - start);
      assertParity(clusters);
    }
    warmWorker.terminate();
    URL.revokeObjectURL(workerUrl);

    return {
      workerOutputParity: true,
      clusterCount,
      itemCount: news.length,
      syncTimings,
      syncWindows,
      workerMainThreadTimings,
      serializeTimings,
      cloneTimings,
      itemBytes,
      coldReadyMs,
      coldRoundTripMs,
      warmTimings,
      longtasks: clusteringLongTasks.filter((entry) => entry.duration >= longTaskMs),
      allLongtasks: longtasks.filter((entry) => entry.duration >= longTaskMs),
    };
  }, { items, samples, longTaskMs: LONG_TASK_MS, workerSource });
}

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('usage: node scripts/profile-news-hybrid-clustering-7782-browser.mjs <minimized-fixture.json>');
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (!Array.isArray(fixture.items) || fixture.items.length === 0) throw new Error('A nonempty representative fixture is required');
  mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
  const bundle = bundleProfileInput();
  const workerSource = await bundleAnalysisWorker();
  const cases = {
    representative: fixture.items,
    highDiversity1500: makeHighDiversity(1500),
  };

  const browser = await chromium.launch({ headless: true });
  const reports = [];
  try {
    for (const cpu of CPU_RATES) {
      for (const [name, items] of Object.entries(cases)) {
        const page = await browser.newPage();
        await page.setContent(
          `<!doctype html><html><head></head><body>
<script id="clustering-bundle">${bundle}</script>

</body></html>`,
        );
        const session = await page.context().newCDPSession(page);
        await session.send('Emulation.setCPUThrottlingRate', { rate: cpu });
        const raw = await measurePage(page, items, SAMPLES, workerSource);
        await page.close();
        const sync = summarize(raw.syncTimings);
        reports.push({
          name,
          cpuThrottleRate: cpu,
          browser: 'chromium',
          productionMinify: true,
          itemCount: raw.itemCount,
          clusterCount: raw.clusterCount,
          syncMainThreadMs: sync,
          serializationMs: summarize(raw.serializeTimings),
          structuredCloneMs: summarize(raw.cloneTimings),
          serializationBytes: { items: raw.itemBytes },
          workerColdReadyMs: round(raw.coldReadyMs),
          workerColdRoundTripMs: round(raw.coldRoundTripMs),
          workerWarmRoundTripMs: summarize(raw.warmTimings),
          workerMainThreadScriptMs: summarize(raw.workerMainThreadTimings),
          clusteringLongTaskCount: raw.longtasks.length,
          clusteringLongTaskDurationsMs: raw.longtasks.map((entry) => round(entry.duration)),
          pageLongTaskCount: raw.allLongtasks.length,
          pageLongTaskDurationsMs: raw.allLongtasks.map((entry) => round(entry.duration)),
          ...budgetEvidence(raw.syncTimings),
          raw,
        });
      }
    }
  } finally {
    await browser.close();
  }

  const justified = reports
    .filter((row) => row.name === 'representative' || row.name === 'highDiversity1500')
    .some((row) => row.repeatableBudgetExceedance);

  const report = {
    issue: 7782,
    generatedAt: new Date().toISOString(),
    surface: 'isolated production-minified core and real analysis worker; not dashboard interaction latency',
    budgets: { frameMs: FRAME_BUDGET_MS, longTaskMs: LONG_TASK_MS },
    samplesPerCase: SAMPLES,
    fixture: {
      path: fixturePath,
      capturedAt: fixture.capturedAt ?? null,
      generatedAt: fixture.generatedAt ?? null,
      source: fixture.source ?? null,
    },
    cases: reports,
    gate: {
      isolatedStageHasRepeatableBudgetExceedance: justified,
      recommendation: justified ? 'requires-dashboard-attribution' : 'stop-without-moving-work',
    },
  };
  writeFileSync(resolve(ROOT, 'tmp/news-hybrid-clustering-7782-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
