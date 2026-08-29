#!/usr/bin/env node
/**
 * qa-traffic.mjs — headless proof for the TomTom live-flow traffic layer.
 *
 * Drives the REAL app in headless Chromium against a dev server that has a
 * TomTom key (default :4410) and asserts the live-mode contract, then uses
 * request interception to fabricate the keyless state deterministically
 * (no key removal needed, no upstream traffic).
 *
 *   (i)   LIVE mode — stats.mode 'live', dots rendered, colored buckets
 *         non-empty (free+slow+jam > 0), coverage > 0, tiles fetched > 0.
 *   (ii)  C4 oblique bounds — at 2.5 km / -20° pitch the road-fetch box
 *         center lands within 12 km of the camera (look-at point), never
 *         the pre-fix horizon-biased midpoint (>25 km).
 *   (iii) Budget honesty — /api/tomtom/status dailyCount grows by no more
 *         than the tiles the page actually fetched this run.
 *   (iv)  Uncovered-roads param — 'hide' renders zero sim dots; 'sim'
 *         restores them (Mumbai has partial coverage; Austin may be 100%,
 *         so this asserts on whichever view has sim dots, else records
 *         INCONCLUSIVE rather than a false failure).
 *   (v)   KEYLESS fallback — with /api/tomtom/status intercepted to
 *         {hasKey:false}: mode 'sim', every dot white (buckets.sim ===
 *         count), and ZERO /api/tomtom/flow requests issued.
 *
 * Visual proof saved to qa-shots/ (gitignored).
 *
 * Run:  node scripts/qa-traffic.mjs --url http://localhost:4410
 * Exits non-zero on any FAIL. Does not commit anything.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots');

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4410');
const HEADFUL = argv.includes('--headful');

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
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
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

/** Enable traffic + teleport, then poll the layer until settled. */
async function settleTraffic(page, view, { minCount = 1, timeoutS = 30 } = {}) {
  return page.evaluate(async (v, minC, tS) => {
    const gev = window.__godsEyeView;
    const dm = gev.dataManager;
    await dm.setEnabled('traffic', true);
    const mod = dm.layers.get('traffic').module;
    const ell = gev.viewer.scene.globe.ellipsoid;
    const d2r = Math.PI / 180;
    // The app's intro flyTo animation clobbers a setView issued mid-flight —
    // cancel any active tween before teleporting.
    try { gev.viewer.camera.cancelFlight(); } catch { /* no flight active */ }
    gev.viewer.camera.setView({
      destination: ell.cartographicToCartesian({ longitude: v.lon * d2r, latitude: v.lat * d2r, height: v.height }),
      orientation: { heading: (v.heading || 0) * d2r, pitch: (v.pitch ?? -90) * d2r, roll: 0 },
    });
    let s = null;
    for (let i = 0; i < tS; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      s = mod.getStats();
      if (s.count >= minC && !s.loading) break;
    }
    return s;
  }, view, minCount, timeoutS);
}

async function main() {
  console.log('\nTomTom Live-Flow Traffic Proof (qa-traffic)');
  console.log(`  App URL : ${APP_URL}\n`);

  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    process.exit(2);
  }

  const statusBefore = await fetch(`${APP_URL}/api/tomtom/status`).then((r) => r.json()).catch(() => null);
  if (!statusBefore?.hasKey) {
    console.error('\x1b[31mServer has no TomTom key — run against the keyed dev server (:4410).\x1b[0m');
    process.exit(2);
  }

  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(findChromeExecutable() ? { executablePath: findChromeExecutable() } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-dev-shm-usage', '--disable-web-security',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--window-size=1440,900',
    ],
  });

  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Track flow-tile requests + traffic console lines for (ii)/(iii)/(v).
    const flowRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/tomtom/flow/')) flowRequests.push(req.url());
    });
    const trafficLogs = [];
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('[Data:Traffic]')) trafficLogs.push(t);
    });

    console.log('Loading app...');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 60000 },
    );
    await sleep(1500);

    // ── (i) LIVE mode: San Antonio — fast Overpass extract, partial TomTom
    // coverage (sim dots exist for (iv)). Mumbai proved too Overpass-cold for
    // a deterministic harness; congestion colors assert the same either way.
    console.log('\n(i) LIVE mode — San Antonio (partial coverage)...');
    let mumbai = await settleTraffic(page, { lon: -98.4936, lat: 29.4241, height: 2800, heading: 23, pitch: -72 }, { minCount: 300, timeoutS: 45 });
    if (!mumbai || mumbai.count === 0) {
      // One retry with a nudged center to defeat the overlap gate (a slow
      // first Overpass response can strand the initial load).
      mumbai = await settleTraffic(page, { lon: -98.487, lat: 29.43, height: 2800, heading: 23, pitch: -72 }, { minCount: 300, timeoutS: 45 });
    }
    {
      const b = mumbai.flowBuckets || {};
      const colored = (b.free || 0) + (b.slow || 0) + (b.jam || 0);
      record('LIVE: stats.mode === "live"', mumbai.mode === 'live', `mode=${mumbai.mode}`);
      record('LIVE: dots rendered', mumbai.count > 0, `count=${mumbai.count}`);
      record('LIVE: colored flow dots present (free+slow+jam > 0)', colored > 0,
        `free=${b.free} slow=${b.slow} jam=${b.jam} sim=${b.sim}`);
      record('LIVE: flow coverage > 0 and tiles fetched > 0',
        mumbai.flowCoveragePct > 0 && mumbai.tilesFetched > 0,
        `coverage=${mumbai.flowCoveragePct}% tiles=${mumbai.tilesFetched}`);
      if (mumbai.mode !== 'live' || !(mumbai.count > 0) || !(colored > 0)) exitCode = 1;
      await sleep(1200);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'traffic-live-flow.png') });
    }

    // ── (iv) uncovered-roads param — hide vs sim ─────────────────────────────
    console.log('\n(iv) uncoveredRoads param — hide vs sim...');
    if ((mumbai.flowBuckets?.sim || 0) > 0) {
      const hid = await page.evaluate(async () => {
        const gev = window.__godsEyeView;
        const mod = gev.dataManager.layers.get('traffic').module;
        const before = mod.getStats().lastUpdate;
        mod.setParams({ uncoveredRoads: 'hide' });
        const ell = gev.viewer.scene.globe.ellipsoid;
        const d2r = Math.PI / 180;
        // Shift far enough to defeat the overlap gate and force a re-render.
        gev.viewer.camera.setView({
          destination: ell.cartographicToCartesian({ longitude: -98.51 * d2r, latitude: 29.435 * d2r, height: 2800 }),
          orientation: { heading: 0.4, pitch: -1.25, roll: 0 },
        });
        // Poll for a NEW render (lastUpdate changes) — the pre-shift stats
        // would otherwise satisfy a count>0 check instantly.
        let s = null;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          s = mod.getStats();
          if (s.lastUpdate !== before && s.count > 0 && !s.loading) break;
        }
        mod.setParams({ uncoveredRoads: 'sim' });
        return s;
      });
      record('PARAM: hide mode renders zero sim (white) dots',
        (hid.flowBuckets?.sim || 0) === 0 && hid.count > 0,
        `count=${hid.count} sim=${hid.flowBuckets?.sim}`);
      if ((hid.flowBuckets?.sim || 0) !== 0) exitCode = 1;
      await page.screenshot({ path: path.join(SHOTS_DIR, 'traffic-live-hide-mode.png') });
    } else {
      record('PARAM: hide mode renders zero sim (white) dots', null,
        'view had 100% coverage (no sim dots to hide) — inconclusive here, covered by unit tests');
    }

    // ── (ii) C4 oblique bounds ───────────────────────────────────────────────
    console.log('\n(ii) C4 — oblique fetch bounds land at the look-at point...');
    trafficLogs.length = 0;
    await settleTraffic(page, { lon: -97.72, lat: 30.245, height: 2500, heading: 315, pitch: -20 }, { minCount: 100 });
    {
      const fetchLine = trafficLogs.find((t) => t.includes('fetch') && t.includes('['));
      let ok = false; let detail = 'no fetch log captured';
      if (fetchLine) {
        const m = fetchLine.match(/\[(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/);
        if (m) {
          const [s, w, n, e] = m.slice(1).map(Number);
          const cLat = (s + n) / 2; const cLon = (w + e) / 2;
          const dKm = Math.sqrt(((cLat - 30.245) * 111) ** 2 + ((cLon - (-97.72)) * 111 * Math.cos(30.27 * Math.PI / 180)) ** 2);
          ok = dKm > 1 && dKm <= 13; // look-at ~6.9 km ahead; clamp allows ≤12 (+margin)
          detail = `box center (${cLat.toFixed(4)},${cLon.toFixed(4)}) is ${dKm.toFixed(1)} km from camera (want 1–13 km; pre-fix bug: 25+ km)`;
        }
      }
      record('C4: oblique fetch box centers on the look-at point', ok, detail);
      if (!ok) exitCode = 1;
      await page.screenshot({ path: path.join(SHOTS_DIR, 'traffic-c4-oblique.png') });
    }

    // ── (iii) budget honesty ─────────────────────────────────────────────────
    console.log('\n(iii) Budget — dailyCount grew by ≤ requests this run...');
    {
      const statusAfter = await fetch(`${APP_URL}/api/tomtom/status`).then((r) => r.json());
      const grew = statusAfter.dailyCount - statusBefore.dailyCount;
      const ok = grew >= 0 && grew <= flowRequests.length;
      record('BUDGET: /api/tomtom/status growth ≤ page tile requests', ok,
        `before=${statusBefore.dailyCount} after=${statusAfter.dailyCount} pageRequests=${flowRequests.length}`);
      if (!ok) exitCode = 1;
    }

    // ── (v) KEYLESS fallback (intercepted — server key untouched) ────────────
    console.log('\n(v) KEYLESS — intercepted status, expect pure simulation...');
    await page.setRequestInterception(true);
    const keylessFlowReqs = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/tomtom/status')) {
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasKey: false }) });
        return;
      }
      if (url.includes('/api/tomtom/flow/')) {
        keylessFlowReqs.push(url);
        req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'no_key' }) });
        return;
      }
      try { req.continue(); } catch { /* already handled */ }
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 60000 },
    );
    await sleep(1500);
    let simStats = await settleTraffic(page, { lon: -98.4936, lat: 29.4241, height: 3000 }, { minCount: 100, timeoutS: 45 });
    if (!simStats || simStats.count === 0) {
      // Public Overpass can throttle bursts across harness runs — one retry.
      simStats = await settleTraffic(page, { lon: -98.487, lat: 29.43, height: 3000 }, { minCount: 100, timeoutS: 45 });
    }
    {
      const b = simStats.flowBuckets || {};
      const allWhite = simStats.count > 0 && b.sim === simStats.count && !b.free && !b.slow && !b.jam;
      record('KEYLESS: stats.mode === "sim"', simStats.mode === 'sim', `mode=${simStats.mode}`);
      record('KEYLESS: every dot is white simulation', allWhite,
        `count=${simStats.count} sim=${b.sim} free=${b.free} slow=${b.slow} jam=${b.jam}`);
      record('KEYLESS: zero flow-tile requests issued', keylessFlowReqs.length === 0,
        `flowRequests=${keylessFlowReqs.length}`);
      // Keyless is a designed fallback, not a fault: it must read SIMULATED
      // without ever raising a layer error.
      const keylessHonest = !simStats.error
        && String(simStats.loadingLabel || '').startsWith('SIMULATED');
      record('KEYLESS: no error, and the label reads SIMULATED', keylessHonest,
        `err=${simStats.error || 'none'} label="${simStats.loadingLabel}"`);
      if (simStats.mode !== 'sim' || !allWhite || keylessFlowReqs.length !== 0 || !keylessHonest) {
        exitCode = 1;
      }
      await sleep(1000);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'traffic-sim-keyless.png') });
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
  console.log(`  Shots : ${SHOTS_DIR}/traffic-*.png`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => { console.error(e); process.exit(3); });
