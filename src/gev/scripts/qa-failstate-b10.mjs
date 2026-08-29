#!/usr/bin/env node
/**
 * qa-failstate-b10.mjs
 *
 * Targeted proof for Batch 10 — the "silent-failure" theme (finding H3 + H9).
 * Drives the REAL app in headless Chromium and asserts that dead/failed feeds
 * are SURFACED to the user instead of a healthy-looking empty state.
 *
 * Node-side request interception (page.setRequestInterception) fabricates the
 * upstream failures so the run is deterministic and never depends on live
 * AISStream / CelesTrak availability:
 *
 *   (i)  AIS invalid key   — /api/ais-live is answered with
 *        {rows:[],status:'error',error:'invalid key'}. Assert the layer's
 *        getStats().error is set (feed down) — NOT a clean 'just now · 0'.
 *
 *   (ii) CelesTrak outage  — first serve a good catalog so there's something to
 *        preserve, then flip ALL /api/celestrak/* groups to HTTP 503. Toggle
 *        satellites off/on. Assert the catalog is NOT wiped to 0 AND
 *        getStats().error is set.
 *
 *   (iii) DETECT with no data — enable panoptic detection with NO data layers.
 *        Assert the shared #world-overlay-canvas is non-empty (mode banner drawn),
 *        so DETECT reads "armed, nothing in view" instead of a blank canvas.
 *        The banner is developer telemetry, hidden from users by default, so this
 *        harness loads the app with ?detectDebug=1 — without it the pixel check
 *        would pass on scanlines alone and no longer assert what it names.
 *        (Absent-by-default is pinned in src/data/detectionHost.test.mjs.)
 *
 * Run:  node scripts/qa-failstate-b10.mjs --url http://localhost:4300
 * Exits non-zero if any assertion fails. DOES NOT COMMIT anything.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const getFlag = (name) => argv.includes(name);

const APP_URL = getOpt('--url', 'http://localhost:4300');

/**
 * Check (iii) asserts the detection MODE BANNER is drawn on a zero-object frame.
 * That banner is developer telemetry and is hidden from users by default, so the
 * harness must ask for it explicitly — otherwise the pixel check silently passes
 * on scanlines alone and the assertion name stops meaning anything.
 */
function withDetectDebug(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('detectDebug', '1');
  return parsed.toString();
}
const HEADFUL = getFlag('--headful');
const ARTIFACT_DIR = getOpt('--artifact-dir', null);

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Prefer puppeteer's version-pinned Chrome-for-Testing over the system
  // Chrome: /Applications auto-updates underneath the harnesses, and its
  // software-GL behavior shifts across majors (system Chrome 150 blew the
  // tile-gated drain budget under SwiftShader on 2026-07-30 — six
  // false-negative qa-cctv-v2 runs against a healthy build). A deterministic
  // pinned browser beats the newest one for regression harnesses.
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findChromeExecutable() {
  for (const candidate of CHROME_EXECUTABLE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok === null ? '\x1b[33mINCONCLUSIVE\x1b[0m' : ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readLayerControl(page, layerId, expectedLabel) {
  await page.waitForFunction(
    (id, label) => {
      const button = document.querySelector(`[data-layer-id="${id}"] .data-toggle-btn`);
      return button?.textContent?.trim() === label;
    },
    { timeout: 5000 },
    layerId,
    expectedLabel,
  );
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-layer-id="${id}"]`);
    const button = row?.querySelector('.data-toggle-btn');
    const meta = row?.querySelector('.data-toggle-meta');
    return {
      label: button?.textContent?.trim() || '',
      feedState: button?.dataset?.feedState || '',
      ariaLabel: button?.getAttribute('aria-label') || '',
      meta: meta?.textContent?.trim() || '',
    };
  }, layerId);
}

async function captureLayerControl(page, layerId, filename) {
  if (!ARTIFACT_DIR) return;
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const dataPanel = await page.$('#data-panel');
  const panelCollapsed = await dataPanel?.evaluate((element) => element.classList.contains('collapsed'));
  if (panelCollapsed) await page.click('#data-panel .panel-collapse-btn');
  const row = await page.$(`[data-layer-id="${layerId}"]`);
  if (!row) throw new Error(`Layer control not found for screenshot: ${layerId}`);
  await row.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.waitForFunction((id) => {
    const element = document.querySelector(`[data-layer-id="${id}"]`);
    const rect = element?.getBoundingClientRect();
    return !!rect && rect.width > 0 && rect.height > 0;
  }, { timeout: 5_000 }, layerId);
  await sleep(100);
  await row.screenshot({ path: path.join(ARTIFACT_DIR, filename) });
}

// A minimal but valid TLE for one satellite (ISS), so the "good catalog" pass
// builds a non-zero catalog we can later prove is preserved across the outage.
// parseTLE in satellites.js expects `NAME\n1 ...\n2 ...` triplets.
const GOOD_TLE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
  'NOAA 19',
  '1 33591U 09005A   08264.51782528 -.00000045  00000-0  35116-4 0  9999',
  '2 33591  99.1949 123.4567 0013000 200.0000 160.0000 14.12345678123456',
].join('\n');

async function main() {
  console.log('\nSilent-Failure Proof (Batch 10 — H3 + H9)');
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Mode    : ${HEADFUL ? 'headful' : 'headless'}\n`);

  try {
    const res = await fetch(APP_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    process.exit(2);
  }

  const chromeExecutable = findChromeExecutable();
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
    ],
  });

  let exitCode = 0;

  // Node-side controllable interception mode, flipped mid-run.
  //   celestrak: 'good'  → serve GOOD_TLE for every group
  //   celestrak: 'partial' → fail one group while preserving a usable catalog
  //   celestrak: 'down'    → 503 for every group (total outage)
  const mode = { celestrak: 'good' };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      // (i) AIS invalid-key: the exact payload the spec calls for.
      if (url.includes('/api/ais-live') && !url.includes('/track')) {
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ rows: [], status: 'error', error: 'invalid key' }),
        });
        return;
      }
      // (ii) CelesTrak proxy — /api/celestrak/<group>
      if (url.includes('/api/celestrak/')) {
        if (mode.celestrak === 'down'
          || (mode.celestrak === 'partial' && url.includes('/api/celestrak/stations'))) {
          req.respond({ status: 503, contentType: 'text/plain', body: 'upstream unavailable' });
        } else {
          req.respond({ status: 200, contentType: 'text/plain', body: GOOD_TLE });
        }
        return;
      }
      req.continue();
    });

    console.log('Loading app...');
    await page.goto(withDetectDebug(APP_URL), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView
        && window.__godsEyeView.viewer
        && window.__godsEyeView.dataManager
        && window.__godsEyeView.styleManager,
      { timeout: 60000 },
    );
    await sleep(1500);

    // ── (0) Manager-owned periodic refresh → shared work/failure/recovery ──
    console.log('\n(0) Universal periodic refresh feedback...');
    const refreshFeedback = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      const ids = ['flights', 'military', 'satellites'];
      const styleManager = window.__godsEyeView.styleManager;
      const outcomes = [];
      const readBanner = () => ({
        hidden: document.getElementById('global-loading-status')?.hidden,
        state: document.getElementById('global-loading-status')?.dataset?.state || '',
        label: document.getElementById('global-loading-label')?.textContent?.trim() || '',
        detail: document.getElementById('global-loading-detail')?.textContent?.trim() || '',
      });

      for (const id of ids) {
        const entry = dm.layers.get(id);
        if (!entry) {
          outcomes.push({ id, missing: true });
          continue;
        }
        const original = {
          enabled: entry.enabled,
          initialized: entry.initialized,
          lifecycleState: entry.lifecycleState,
          update: entry.module.update,
          getStats: entry.module.getStats,
          managerRefreshError: entry.managerRefreshError,
        };
        const baseStats = typeof original.getStats === 'function'
          ? original.getStats.call(entry.module)
          : { count: 0, lastUpdate: null };
        let rejectRefresh;
        try {
          entry.enabled = true;
          entry.initialized = true;
          entry.lifecycleState = 'enabled';
          entry.managerRefreshError = null;
          entry.module.getStats = () => ({
            ...baseStats,
            error: null,
            lastError: null,
            available: true,
            unavailable: false,
            loading: false,
            refreshing: false,
          });
          entry.module.update = () => new Promise((resolve, reject) => {
            rejectRefresh = reject;
          });
          const pendingFailure = dm._runPeriodicUpdate(id, entry);
          styleManager._updateGlobalLoadingFeedback(performance.now());
          await new Promise((resolve) => setTimeout(resolve, 220));
          styleManager._updateGlobalLoadingFeedback(performance.now());
          const working = readBanner();
          rejectRefresh(new Error(`${id} QA refresh failure`));
          await pendingFailure;
          styleManager._updateGlobalLoadingFeedback(performance.now());
          const failed = readBanner();
          const managerError = entry.managerRefreshError;

          entry.module.update = async () => true;
          const pendingRecovery = dm._runPeriodicUpdate(id, entry);
          styleManager._updateGlobalLoadingFeedback(performance.now());
          await pendingRecovery;
          styleManager._updateGlobalLoadingFeedback(performance.now());
          outcomes.push({
            id,
            name: entry.module.name,
            working,
            failed,
            managerError,
            recoveredError: entry.managerRefreshError,
            lifecycleState: entry.lifecycleState,
            enabled: entry.enabled,
          });
        } finally {
          entry.module.update = original.update;
          entry.module.getStats = original.getStats;
          entry.enabled = original.enabled;
          entry.initialized = original.initialized;
          entry.lifecycleState = original.lifecycleState;
          entry.managerRefreshError = original.managerRefreshError;
        }
      }
      return outcomes;
    });
    for (const outcome of refreshFeedback) {
      const passed = !outcome.missing
        && outcome.working.hidden === false
        && outcome.working.label === 'REFRESHING LIVE DATA'
        && outcome.working.detail.includes(outcome.name)
        && outcome.failed.hidden === false
        && outcome.failed.label === 'LOAD FAILED'
        && outcome.failed.state === 'error'
        && outcome.managerError?.includes('QA refresh failure')
        && outcome.recoveredError === null
        && outcome.lifecycleState === 'enabled'
        && outcome.enabled === true;
      record(
        `${outcome.name || outcome.id}: periodic refresh reports work, failure, and recovery`,
        passed,
        JSON.stringify(outcome),
      );
      if (!passed) exitCode = 1;
    }

    // ── (i) AIS invalid key → surfaced error, not a clean empty ──────────────
    console.log('\n(i) AIS invalid-key: enabling ais-live-vessels...');
    const aisStats = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('ais-live-vessels', true);
      const mod = dm.layers.get('ais-live-vessels').module;
      // DataLayerManager intentionally treats enable() as a synchronous
      // lifecycle hook, while this layer starts its first poll asynchronously
      // from enable(). Wait on the layer's public loading state instead of a
      // machine-speed-dependent fixed delay so the assertion always observes
      // the injected response, not an in-flight request.
      const deadline = Date.now() + 5000;
      while (mod.getStats().loading && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return mod.getStats();
    });
    {
      const hasError = typeof aisStats.error === 'string' && aisStats.error.length > 0;
      const cleanEmpty = !hasError && (aisStats.count === 0);
      record(
        'AIS: dead feed surfaces an error (not clean empty)',
        hasError && !cleanEmpty,
        `stats=${JSON.stringify({ error: aisStats.error, count: aisStats.count, lastUpdate: aisStats.lastUpdate })}`,
      );
      if (!hasError) exitCode = 1;
    }
    const aisControl = await readLayerControl(page, 'ais-live-vessels', 'UNAVAILABLE');
    const aisChipHonest = aisControl.feedState === 'unavailable'
      && aisControl.ariaLabel === 'Live AIS Vessels: UNAVAILABLE';
    const aisMetaHonest = /^UNAVAILABLE · AISStream · /i.test(aisControl.meta)
      && aisStats.error
      && aisControl.meta.includes(aisStats.error);
    record(
      'AIS: layer control reads UNAVAILABLE',
      aisChipHonest,
      JSON.stringify(aisControl),
    );
    record(
      'AIS: layer metadata names the upstream error',
      aisMetaHonest,
      `meta=${JSON.stringify(aisControl.meta)}`,
    );
    if (!aisChipHonest || !aisMetaHonest) exitCode = 1;
    await captureLayerControl(page, 'ais-live-vessels', 'failstate-ais-unavailable.png');

    // ── (ii) CelesTrak outage on re-enable → catalog NOT wiped, error set ────
    console.log('\n(ii) Satellites: building a good catalog first...');
    const goodStats = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('satellites', true);
      await new Promise((r) => setTimeout(r, 800));
      const mod = dm.layers.get('satellites').module;
      return mod.getStats();
    });
    record(
      'Satellites: good catalog loaded before outage (baseline)',
      goodStats.count > 0,
      `count=${goodStats.count} error=${goodStats.error ?? null}`,
    );
    if (!(goodStats.count > 0)) {
      // Without a baseline the preservation assertion is meaningless.
      record('Satellites: catalog preserved across total outage', null, 'no baseline catalog to preserve');
    } else {
      console.log('     Failing one CelesTrak group and verifying the visible degraded state...');
      mode.celestrak = 'partial';
      const partialStats = await page.evaluate(async () => {
        const dm = window.__godsEyeView.dataManager;
        await dm.setEnabled('satellites', false);
        await new Promise((r) => setTimeout(r, 200));
        await dm.setEnabled('satellites', true);
        await new Promise((r) => setTimeout(r, 800));
        return dm.layers.get('satellites').module.getStats();
      });
      const partialControl = await readLayerControl(page, 'satellites', 'DEGRADED');
      const partialChipHonest = partialStats.count > 0
        && /1 CelesTrak group unavailable/i.test(partialStats.error || '')
        && partialControl.feedState === 'degraded'
        && partialControl.ariaLabel === 'Satellites: DEGRADED';
      const partialMetaHonest = /^DEGRADED · CelesTrak · /i.test(partialControl.meta)
        && /1 CelesTrak group unavailable/i.test(partialControl.meta);
      record(
        'Satellites: partial outage renders a DEGRADED chip',
        partialChipHonest,
        JSON.stringify({ stats: partialStats, control: partialControl }),
      );
      record(
        'Satellites: degraded metadata names partial coverage',
        partialMetaHonest,
        `meta=${JSON.stringify(partialControl.meta)}`,
      );
      if (!partialChipHonest || !partialMetaHonest) exitCode = 1;
      await captureLayerControl(page, 'satellites', 'failstate-satellites-degraded.png');

      console.log('     Flipping ALL CelesTrak groups to 503 and toggling satellites off→on...');
      mode.celestrak = 'down';
      const outageStats = await page.evaluate(async (baseline) => {
        const dm = window.__godsEyeView.dataManager;
        // Toggle off then on — the re-enable's update() re-fetches (now all 503).
        await dm.setEnabled('satellites', false);
        await new Promise((r) => setTimeout(r, 200));
        await dm.setEnabled('satellites', true);
        await new Promise((r) => setTimeout(r, 800));
        const mod = dm.layers.get('satellites').module;
        return { stats: mod.getStats(), baseline };
      }, goodStats.count);

      const s = outageStats.stats;
      const notWiped = s.count > 0; // catalog preserved, not blanked to 0
      const errorSet = typeof s.error === 'string' && s.error.length > 0;
      const outageControl = await readLayerControl(page, 'satellites', 'UNAVAILABLE');
      const outageChipHonest = outageControl.feedState === 'unavailable'
        && outageControl.ariaLabel === 'Satellites: UNAVAILABLE';
      const outageMetaHonest = /^UNAVAILABLE · CelesTrak · /i.test(outageControl.meta)
        && outageControl.meta.includes(s.error || '');
      record(
        'Satellites: catalog NOT wiped to 0 on total outage',
        notWiped,
        `count=${s.count} (baseline=${outageStats.baseline})`,
      );
      record(
        'Satellites: outage surfaces stats.error',
        errorSet,
        `error=${JSON.stringify(s.error)} lastUpdate=${s.lastUpdate}`,
      );
      record(
        'Satellites: total outage renders an UNAVAILABLE chip',
        outageChipHonest,
        JSON.stringify(outageControl),
      );
      record(
        'Satellites: unavailable metadata names the outage',
        outageMetaHonest,
        `meta=${JSON.stringify(outageControl.meta)}`,
      );
      if (!notWiped || !errorSet || !outageChipHonest || !outageMetaHonest) exitCode = 1;
      await captureLayerControl(page, 'satellites', 'failstate-satellites-unavailable.png');
    }

    // ── (iii) DETECT with no data layers → mode banner drawn (non-blank) ─────
    console.log('\n(iii) DETECT with no data layers: disabling data layers, enabling panoptic...');
    const detect = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const dm = gev.dataManager;
      // Turn OFF every data layer so detection collects zero objects.
      for (const [id, entry] of dm.layers) {
        if (entry.enabled) { try { await dm.setEnabled(id, false); } catch { /* ignore */ } }
      }
      // Enable panoptic detection via the styleManager facade (the UI path).
      gev.styleManager.setDetection({ enabled: true, mode: 'panoptic' });
      const canvas = document.getElementById('world-overlay-canvas');
      if (!canvas) return { present: false };
      const viewer = gev.viewer;
      const tileset = gev.tileset;
      const priorDefaultLoop = viewer.useDefaultRenderLoop;
      const priorTilesetShow = tileset?.show;
      let nonEmpty = 0;
      let solid = 0;
      let sampled = 0;
      viewer.useDefaultRenderLoop = false;
      if (tileset) tileset.show = false;
      try {
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline && solid <= 20) {
          viewer.render();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const w = canvas.width, h = canvas.height;
          const off = document.createElement('canvas');
          off.width = w; off.height = h;
          const octx = off.getContext('2d');
          // The detection pass (banner included) paints on the host-owned
          // blend-isolation surface beneath the shared canvas — composite
          // both so the sample sees whichever surface carries the banner.
          const detSurface = document.getElementById('world-overlay-detection-surface');
          if (detSurface) octx.drawImage(detSurface, 0, 0);
          octx.drawImage(canvas, 0, 0);
          const dpr = window.devicePixelRatio || 1;
          const bw = Math.min(w, Math.round(260 * dpr));
          const bh = Math.min(h, Math.round(48 * dpr));
          const data = octx.getImageData(0, 0, bw, bh).data;
          sampled = bw * bh;
          nonEmpty = 0;
          solid = 0;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 4) nonEmpty++;
            // The banner paints labelBg at full opacity (alpha 0.66-0.78 => 168+).
            // Scanlines paint the SAME color but scaled by _theme.scanline, and
            // only on every fourth row, so they never reach this threshold. This
            // is what separates "the banner is drawn" from "something is drawn".
            if (data[i] > 128) solid++;
          }
        }
      } finally {
        if (tileset) tileset.show = priorTilesetShow;
        viewer.useDefaultRenderLoop = priorDefaultLoop;
        viewer.scene.requestRender();
      }
      const detState = gev.styleManager.getDetectionState?.() || null;
      return { present: true, nonEmpty, solid, sampled, mode: detState?.detectionMode ?? null };
    });

    if (!detect.present) {
      record('DETECT: mode banner drawn on 0 objects', false, 'world-overlay canvas absent');
      exitCode = 1;
    } else {
      // Solid pixels only: a non-empty canvas proves SOMETHING painted, which
      // faint scanlines alone satisfy. The banner's opaque background is what
      // this check is named for, so that is what it asserts.
      const bannerDrawn = detect.solid > 20;
      record(
        'DETECT: mode banner drawn on 0 objects (opaque banner fill present)',
        bannerDrawn,
        `solidPx=${detect.solid} nonEmptyPx=${detect.nonEmpty}/${detect.sampled} mode=${detect.mode}`,
      );
      if (!bannerDrawn) exitCode = 1;
    }

  } catch (e) {
    console.error('\x1b[31mHarness error:\x1b[0m', e);
    exitCode = 3;
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const inconclusive = results.filter((r) => r.ok === null).length;
  console.log('\n' + '─'.repeat(60));
  console.log(`  RESULT: ${pass} passed, ${fail} failed, ${inconclusive} inconclusive`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
