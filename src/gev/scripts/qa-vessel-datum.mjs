#!/usr/bin/env node
/**
 * qa-vessel-datum.mjs — assertion harness for the AIS vessel vertical-datum
 * pass described in docs/CURRENT-STATE.md.
 *
 * Drives the REAL app in headless Chromium against the LIVE AISStream feed
 * and asserts, per port:
 *   1. every vessel billboard is depth-test-free
 *      (disableDepthTestDistance === Infinity — locked principle #2), and
 *   2. near-port anchors sit at the SEA SURFACE, not the ellipsoid: median
 *      ellipsoidal height within the EGM96 band (N + 3 m lift):
 *      Rotterdam N ≈ +43.7 → ≈ +46.7 m, Houston N ≈ −28.4 → ≈ −25.4 m.
 *      (At the pre-fix ellipsoid datum both medians would be ≈ 0–3 m.)
 * Then captures a screenshot to the gitignored qa-shots/ as visual proof
 * (Rotterdam chevrons were fully sea-mesh-occluded before the fix).
 *
 * Usage:
 *   node scripts/qa-vessel-datum.mjs
 *   node scripts/qa-vessel-datum.mjs --ports rotterdam --url http://localhost:4173
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
const PORT_KEYS = getOpt('--ports', 'rotterdam,houston').split(',').map((s) => s.trim()).filter(Boolean);
const OUT_DIR = getOpt('--out', 'qa-shots');

/**
 * Camera framings match qa-vessel-cards.mjs; heightBand is the expected
 * near-port anchor ellipsoidal height (N + VESSEL_LIFT_M, ±~7 m for N drift
 * across the port area + tolerance).
 */
const PORTS = {
  rotterdam: {
    lon: 4.05, lat: 51.93, height: 18000, heading: 0.3, pitch: -1.25,
    heightBand: [40, 54],
  },
  houston: {
    lon: -95.08, lat: 29.72, height: 16000, heading: 5.9, pitch: -1.3,
    heightBand: [-33, -18],
  },
};

/** Degrees of lat/lon around the port center counted as "near-port". */
const NEAR_DEG = 1.0;
/** Max billboards sampled for the depth-test sweep. */
const SAMPLE_CAP = 500;

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
    } catch { /* fall through to Puppeteer's cache */ }
  }
  return null;
}

/**
 * In-page probe: locate the vessel BillboardCollection (duck-typed — its
 * billboards carry the vessel record as `id`, so `id.mmsi` exists), then
 * report depth-test flags across a sample and ellipsoidal heights of
 * near-port billboards.
 */
function probeVessels({ portLat, portLon, nearDeg, sampleCap }) {
  const gev = window.__godsEyeView;
  const viewer = gev?.viewer;
  if (!viewer) return { error: 'no viewer' };
  const ellipsoid = viewer.scene.globe.ellipsoid;
  const prims = viewer.scene.primitives;

  let collection = null;
  for (let i = 0; i < prims.length; i += 1) {
    const p = prims.get(i);
    if (!p || typeof p.get !== 'function' || typeof p.length !== 'number' || p.length === 0) continue;
    const first = p.get(0);
    if (first && first.id && typeof first.id === 'object' && 'mmsi' in first.id
        && first.disableDepthTestDistance !== undefined) {
      collection = p;
      break;
    }
  }
  if (!collection) return { error: 'vessel billboard collection not found' };

  let depthFreeCount = 0;
  let depthTestedCount = 0;
  const nearHeights = [];
  const step = Math.max(1, Math.floor(collection.length / sampleCap));
  for (let i = 0; i < collection.length; i += step) {
    const b = collection.get(i);
    if (!b) continue;
    if (b.disableDepthTestDistance === Number.POSITIVE_INFINITY) depthFreeCount += 1;
    else depthTestedCount += 1;
    const rec = b.id;
    if (Number.isFinite(rec?.lat) && Number.isFinite(rec?.lon)
        && Math.abs(rec.lat - portLat) <= nearDeg && Math.abs(rec.lon - portLon) <= nearDeg) {
      const carto = ellipsoid.cartesianToCartographic(b.position);
      if (carto) nearHeights.push(carto.height);
    }
  }
  nearHeights.sort((a, b) => a - b);
  const median = nearHeights.length ? nearHeights[Math.floor(nearHeights.length / 2)] : null;
  return {
    total: collection.length,
    sampled: depthFreeCount + depthTestedCount,
    depthFreeCount,
    depthTestedCount,
    nearCount: nearHeights.length,
    medianHeight: median,
    minHeight: nearHeights[0] ?? null,
    maxHeight: nearHeights[nearHeights.length - 1] ?? null,
  };
}

async function main() {
  console.log(`\nAIS Vessel Datum — assertion harness`);
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Ports   : ${PORT_KEYS.join(', ')}\n`);

  try {
    const res = await fetch(APP_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    console.error(`Start it first:  ./scripts/dev-fresh.sh`);
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chromeExecutable = findChromeExecutable();
  const browser = await puppeteer.launch({
    headless: 'new',
    ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1600,900',
    ],
  });

  let failures = 0;
  try {
    for (const key of PORT_KEYS) {
      const port = PORTS[key];
      if (!port) {
        console.error(`  [\x1b[31mFAIL\x1b[0m] unknown port '${key}' (have: ${Object.keys(PORTS).join(', ')})`);
        failures += 1;
        continue;
      }
      console.log(`  ▸ ${key}`);

      const page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 900 });
      page.on('pageerror', (err) => console.error(`    [page-error] ${err.message}`));

      await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 60000 });

      // Frame the port (kill the intro flight first) and enable the layer.
      await page.evaluate(async (p) => {
        const gev = window.__godsEyeView;
        const v = gev.viewer;
        v.camera.cancelFlight?.();
        v.scene.tweens?.removeAll?.();
        const carto = {
          longitude: (p.lon * Math.PI) / 180,
          latitude: (p.lat * Math.PI) / 180,
          height: p.height,
        };
        v.camera.setView({
          destination: v.scene.globe.ellipsoid.cartographicToCartesian(carto),
          orientation: { heading: p.heading, pitch: p.pitch, roll: 0 },
        });
        await gev.dataManager.setEnabled('ais-live-vessels', true);
      }, port);

      // Wait for rows + the geoid re-floor: poll until near-port anchors sit
      // inside the expected band (both ports' bands exclude the pre-fix 0–3 m
      // ellipsoid datum, so this only settles once the lift is applied).
      const probeArgs = { portLat: port.lat, portLon: port.lon, nearDeg: NEAR_DEG, sampleCap: SAMPLE_CAP };
      const deadline = Date.now() + 120000;
      let probe = null;
      let settled = false;
      while (Date.now() < deadline) {
        probe = await page.evaluate(probeVessels, probeArgs);
        if (probe && !probe.error && probe.nearCount >= 3
            && probe.medianHeight !== null
            && probe.medianHeight >= port.heightBand[0]
            && probe.medianHeight <= port.heightBand[1]) {
          settled = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }

      const fmt = (v) => (v === null || v === undefined ? '—' : v.toFixed ? v.toFixed(1) : String(v));
      if (!probe || probe.error) {
        console.error(`    [\x1b[31mFAIL\x1b[0m] probe error: ${probe?.error || 'no probe result'}`);
        failures += 1;
      } else {
        const heightOk = settled;
        const depthOk = probe.depthTestedCount === 0 && probe.depthFreeCount > 0;
        console.log(
          `    vessels=${probe.total} sampled=${probe.sampled} nearPort=${probe.nearCount} ` +
          `medianH=${fmt(probe.medianHeight)}m (band ${port.heightBand[0]}..${port.heightBand[1]}) ` +
          `range=${fmt(probe.minHeight)}..${fmt(probe.maxHeight)}m`
        );
        console.log(
          `    [${depthOk ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ` +
          `depth-test-free sprites: ${probe.depthFreeCount}/${probe.sampled} (locked principle #2)`
        );
        console.log(
          `    [${heightOk ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ` +
          `sea-surface anchor datum (N + lift, locked principle #1)`
        );
        if (!depthOk) failures += 1;
        if (!heightOk) failures += 1;
      }

      // Visual proof — re-assert the framing (the app's intro flight can land
      // mid-probe on slow runs), wait for the photoreal tileset, screenshot.
      await page.evaluate((p) => {
        const v = window.__godsEyeView.viewer;
        v.camera.cancelFlight?.();
        v.scene.tweens?.removeAll?.();
        const carto = {
          longitude: (p.lon * Math.PI) / 180,
          latitude: (p.lat * Math.PI) / 180,
          height: p.height,
        };
        v.camera.setView({
          destination: v.scene.globe.ellipsoid.cartographicToCartesian(carto),
          orientation: { heading: p.heading, pitch: p.pitch, roll: 0 },
        });
      }, port);
      await page
        .waitForFunction(() => window.__godsEyeView?.tileset?.tilesLoaded, { timeout: 60000, polling: 500 })
        .catch(() => console.log('    (tileset settle timeout — screenshotting anyway)'));
      await new Promise((r) => setTimeout(r, 2500));
      const outPath = path.join(OUT_DIR, `vessel-datum-${key}.png`);
      await page.screenshot({ path: outPath });
      console.log(`    [SHOT] ${outPath}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m` : '\n\x1b[32mAll datum checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
