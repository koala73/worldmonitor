#!/usr/bin/env node
/**
 * qa-traffic-jamviz-ab.mjs — A/B screenshot capture for the jam-viz
 * congestion prototypes.
 *
 * For each view, renders the SAME camera framing under each jamViz mode
 * (none = shipped main behavior / density / heatline / both), forcing a
 * fresh camera-driven re-render between modes via an away-and-back teleport
 * (setParams applies on the next load, same semantics as uncoveredRoads).
 * Shots + per-shot layer stats land in --out (default qa-shots/jamviz).
 *
 * Views: Austin I-35 downtown corridor (owner's requested A/B target) at
 * city scale + low detail, plus Mumbai Western Express Hwy — captured
 * because Austin is off-peak at 22:00 CT while Mumbai is in live morning
 * rush, guaranteeing jam-bucket coverage in the drama shots.
 *
 * Run:  node scripts/qa-traffic-jamviz-ab.mjs --url http://localhost:4412
 * Exits non-zero on harness failure (missing live mode, zero dots, etc.).
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
const APP_URL = getOpt('--url', 'http://localhost:4412');
const OUT_DIR = path.resolve(REPO_ROOT, getOpt('--out', 'qa-shots/jamviz'));

const VIEWS = [
  {
    id: 'i35-city',
    label: 'Austin I-35 corridor — city scale',
    lon: -97.7365, lat: 30.235, height: 3000, heading: 8, pitch: -38,
  },
  {
    id: 'i35-detail',
    label: 'Austin I-35 at downtown — queue detail',
    lon: -97.735, lat: 30.262, height: 1100, heading: 10, pitch: -45,
  },
  {
    id: 'mumbai-wexp',
    label: 'Mumbai Western Express Hwy — live morning rush',
    lon: 72.851, lat: 19.115, height: 3200, heading: 0, pitch: -40,
  },
];
const MODES = ['none', 'density', 'heatline', 'both'];

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
const findChromeExecutable = () =>
  CHROME_EXECUTABLE_CANDIDATES.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same pattern as qa-cctv-v2: wait for the 3D tileset to settle for crisp shots. */
function waitForTilesLoaded(page, timeoutMs) {
  return page.waitForFunction(
    () => {
      const prims = window.__godsEyeView.viewer.scene.primitives;
      for (let i = 0; i < prims.length; i++) {
        const p = prims.get(i);
        if (p && p.constructor && p.constructor.name === 'Cesium3DTileset') {
          return p.tilesLoaded === true;
        }
      }
      return true;
    },
    { timeout: timeoutMs }
  ).then(() => true).catch(() => false);
}

/** Teleport to a view (cancelling any camera flight first). */
function setView(page, v) {
  return page.evaluate((view) => {
    const gev = window.__godsEyeView;
    try { gev.viewer.camera.cancelFlight(); } catch { /* no flight */ }
    const ell = gev.viewer.scene.globe.ellipsoid;
    const d2r = Math.PI / 180;
    gev.viewer.camera.setView({
      destination: ell.cartographicToCartesian({
        longitude: view.lon * d2r, latitude: view.lat * d2r, height: view.height,
      }),
      orientation: {
        heading: (view.heading || 0) * d2r,
        pitch: (view.pitch ?? -90) * d2r,
        roll: 0,
      },
    });
  }, v);
}

/**
 * Poll layer stats until a render newer than `sinceLastUpdate` settles.
 * Returns the last sample with `renderSettled` reporting whether the
 * freshness predicate was actually met — on timeout the sample is stale
 * (possibly still-colored buckets from the previous view), and a caller that
 * cannot tell the difference will pass a capture that never rendered.
 */
function waitForFreshRender(page, sinceLastUpdate, timeoutS = 40) {
  return page.evaluate(async (since, tS) => {
    const mod = window.__godsEyeView.dataManager.layers.get('traffic').module;
    let s = null;
    let renderSettled = false;
    for (let i = 0; i < tS; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      s = mod.getStats();
      if (s.lastUpdate && s.lastUpdate !== since && s.count > 0 && !s.loading) {
        renderSettled = true;
        break;
      }
    }
    return { ...s, renderSettled };
  }, sinceLastUpdate, timeoutS);
}

async function main() {
  console.log('\nJam-viz A/B capture');
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Out dir : ${OUT_DIR}\n`);

  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`Dev server not reachable at ${APP_URL} (${e.message}).`);
    process.exit(2);
  }
  const status = await fetch(`${APP_URL}/api/tomtom/status`).then((r) => r.json()).catch(() => null);
  if (!status?.hasKey) {
    console.error('Server has no TomTom key — the A/B needs live flow.');
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    ...(findChromeExecutable() ? { executablePath: findChromeExecutable() } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-dev-shm-usage', '--disable-web-security',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--window-size=1600,900',
    ],
  });

  const manifest = [];
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    console.log('Loading app...');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 60000 },
    );
    await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled('traffic', true));
    await sleep(1500);

    let firstView = true;
    for (const view of VIEWS) {
      console.log(`\n── ${view.label} (${view.id})`);
      for (const mode of MODES) {
        // Apply the mode, then force a re-render AT THE EXACT SAME framing:
        // hop ~8.6 km east (defeats the overlap/center-shift gate — adjacent
        // views alone can sit inside it), WAIT for the away render to commit
        // (otherwise its late commit satisfies the freshness poll and the
        // shot captures the away render), then return — the comeback load
        // re-spawns with the new mode active.
        await page.evaluate((m) => {
          window.__godsEyeView.dataManager.layers.get('traffic').module.setParams({ jamViz: m });
        }, mode);
        const preHop = await page.evaluate(
          () => window.__godsEyeView.dataManager.layers.get('traffic').module.getStats().lastUpdate,
        );
        await setView(page, { ...view, lon: view.lon + 0.09 });
        const hop = await waitForFreshRender(page, preHop, 30);
        const since = await page.evaluate(
          () => window.__godsEyeView.dataManager.layers.get('traffic').module.getStats().lastUpdate,
        );
        await setView(page, view);
        const stats = await waitForFreshRender(page, since);
        await waitForTilesLoaded(page, firstView ? 30000 : 15000);
        await sleep(1400); // flow-recolor race + heat-line pulse mid-bright

        const final = await page.evaluate(() => {
          const mod = window.__godsEyeView.dataManager.layers.get('traffic').module;
          return { stats: mod.getStats(), params: mod.getParams() };
        });
        const shot = `${view.id}--${mode}.png`;
        await page.screenshot({ path: path.join(OUT_DIR, shot) });

        const b = final.stats.flowBuckets || {};
        // `mode` is the CONFIGURED source, not feed health: a keyed run whose
        // TomTom flow died still reports mode 'live' while every dot renders
        // simulated white. Health is `!error` + actually-colored dots.
        const colored = (b.free || 0) + (b.slow || 0) + (b.jam || 0);
        // A capture whose waits timed out shows the PREVIOUS view's dots.
        // That is a failed capture, not a footnote in the manifest.
        const renderSettled = Boolean(hop.renderSettled && stats.renderSettled)
          && !final.stats.loading;
        const ok = renderSettled && final.stats.mode === 'live' && !final.stats.error
          && final.stats.count > 0 && colored > 0
          && final.params.jamViz === mode
          && (mode !== 'none' || final.stats.heatLines === 0);
        if (!ok) exitCode = 1;
        console.log(`  [${ok ? 'OK' : 'FAIL'}] ${shot}  dots=${final.stats.count} `
          + `free=${b.free} slow=${b.slow} jam=${b.jam} sim=${b.sim} `
          + `heatLines=${final.stats.heatLines} cov=${final.stats.flowCoveragePct}% `
          + `err=${final.stats.error || 'none'} settled=${renderSettled}`);
        manifest.push({
          view: view.id, label: view.label, mode, shot,
          capturedAt: new Date().toISOString(),
          count: final.stats.count, flowBuckets: b,
          heatLines: final.stats.heatLines,
          closedRoads: final.stats.closedRoads,
          coveragePct: final.stats.flowCoveragePct,
          error: final.stats.error || null,
          renderSettled,
        });
        firstView = false;
      }
    }
  } catch (e) {
    console.error('Harness error:', e);
    exitCode = 3;
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await browser.close();
  }
  console.log(`\nShots + manifest.json → ${OUT_DIR}`);
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(3); });
