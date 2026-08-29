#!/usr/bin/env node
/**
 * qa-traffic-preset-ab.mjs — A/B screenshot capture for preset-aware
 * traffic dot styling (field finding 2026-07-23: NVG/FLIR/CRT
 * post-FX crush the green/amber/red congestion coding).
 *
 * For each view, settles the live traffic layer ONCE, then for each
 * post-FX style (normal / surveillance=NVG / thermal=FLIR / retro=CRT)
 * drives the REAL StyleManager.setStyle path and captures:
 *   A — presetDots 'off' (shipped palette under that preset), and
 *   B — presetDots 'on'  (preset-aware luminance/size encoding),
 * at identical framing with the identical dot set — the kill switch
 * restyles in place, no refetch, so the pair is a true A/B.
 *
 * Views: Mumbai Western Express Hwy (live rush window for jam coverage)
 * + Austin I-35 downtown corridor (common target).
 *
 * Shots + per-shot layer stats land in --out
 * (default qa-shots/preset-traffic, gitignored).
 *
 * Run:  node scripts/qa-traffic-preset-ab.mjs --url http://localhost:4390
 * Exits non-zero on harness failure (no live mode, zero dots, style or
 * param not adopted by the layer).
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
const APP_URL = getOpt('--url', 'http://localhost:4390');
const OUT_DIR = path.resolve(REPO_ROOT, getOpt('--out', 'qa-shots/preset-traffic'));

// Framing note: at shallow oblique pitch the camera sits 5+ km from the
// roads — free/slow dots (2 km depth punch) cull under the mesh and the
// rest fade to ~2 px, so no styling is judgeable there. Both views keep the
// camera close/steep enough that every bucket renders (same reason
// qa-traffic's proof shot is near-nadir).
const VIEWS = [
  {
    id: 'i35-close',
    label: 'Austin I-35 jam cluster — close queue read',
    lon: -97.7365, lat: 30.252, height: 1400, heading: 8, pitch: -65,
  },
  {
    id: 'i35-nadir',
    label: 'Austin I-35 corridor — near-nadir city scale',
    lon: -97.7365, lat: 30.25, height: 2400, heading: 8, pitch: -70,
  },
];
/**
 * StyleManager preset names with user-facing labels + expected profile.
 * `ironbow` flips the thermal palette uniform (0 = grayscale WHOT,
 * 1 = Ironbow "Predator" ramp) — round 2 requires the dots to read in both.
 */
const STYLES = [
  { id: 'normal', name: 'normal', label: 'Normal', profile: 'normal' },
  { id: 'surveillance', name: 'surveillance', label: 'NVG', profile: 'mono' },
  { id: 'thermal', name: 'thermal', label: 'FLIR WHOT', profile: 'mono', ironbow: false },
  { id: 'thermal-ironbow', name: 'thermal', label: 'FLIR Ironbow', profile: 'mono', ironbow: true },
  { id: 'retro', name: 'retro', label: 'CRT', profile: 'crt' },
];

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

/** Same pattern as qa-traffic-jamviz-ab: wait for the 3D tileset to settle. */
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

/** Enable traffic + teleport, then poll the layer until settled. */
function settleTraffic(page, view, { minCount = 100, timeoutS = 45 } = {}) {
  return page.evaluate(async (v, minC, tS) => {
    const gev = window.__godsEyeView;
    await gev.dataManager.setEnabled('traffic', true);
    const mod = gev.dataManager.layers.get('traffic').module;
    try { gev.viewer.camera.cancelFlight(); } catch { /* no flight */ }
    const ell = gev.viewer.scene.globe.ellipsoid;
    const d2r = Math.PI / 180;
    gev.viewer.camera.setView({
      destination: ell.cartographicToCartesian({
        longitude: v.lon * d2r, latitude: v.lat * d2r, height: v.height,
      }),
      orientation: {
        heading: (v.heading || 0) * d2r, pitch: (v.pitch ?? -90) * d2r, roll: 0,
      },
    });
    let s = null;
    // `renderSettled` separates a real settle from a timeout returning the
    // last (stale, possibly still-loading) sample — without it a capture of
    // the previous view's dots passes.
    let renderSettled = false;
    for (let i = 0; i < tS; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      s = mod.getStats();
      if (s.count >= minC && !s.loading) {
        renderSettled = true;
        break;
      }
    }
    return { ...s, renderSettled };
  }, view, minCount, timeoutS);
}

async function main() {
  console.log('\nPreset-aware traffic styling A/B capture');
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
    await sleep(1500);

    let firstView = true;
    for (const view of VIEWS) {
      console.log(`\n── ${view.label} (${view.id})`);
      const settled = await settleTraffic(page, view);
      // `mode` only says a TomTom key is configured; `error` says whether the
      // flow feed is actually up. A degraded run renders simulated white dots
      // and must not pass as a live styling capture — and a wait that timed
      // out never rendered this view at all.
      if (!settled || !settled.renderSettled || settled.count === 0
          || settled.mode !== 'live' || settled.error) {
        console.error('  [FAIL] traffic never settled live '
          + `(count=${settled?.count} mode=${settled?.mode} `
          + `settled=${Boolean(settled?.renderSettled)} err=${settled?.error || 'none'})`);
        exitCode = 1;
        continue;
      }
      await waitForTilesLoaded(page, firstView ? 30000 : 15000);
      firstView = false;

      for (const style of STYLES) {
        // Real user path: StyleManager.setStyle drives the post-FX stage AND
        // the gev:style-change event the traffic layer listens to. The
        // thermal palette uniform selects WHOT vs Ironbow.
        await page.evaluate((s) => {
          const sm = window.__godsEyeView.styleManager;
          sm.setStyle(s.name, { applyPreset: true });
          if (sm.stages.thermal) sm.stages.thermal.uniforms.palette = s.ironbow ? 1.0 : 0.0;
        }, style);
        await sleep(1800); // 500 ms intensity lerp + settle

        // Round 2 legs: dots alone (DETECT off) vs dots + bucket-colored
        // brackets (DENSE) — presetDots stays at its default 'on'.
        for (const detect of ['off', 'on']) {
          await page.evaluate((d) => {
            window.__godsEyeView.styleManager._setDetectionMode(d === 'on' ? 'DENSE' : 'OFF');
          }, detect);
          await sleep(1200); // label-arbiter solve + a few rendered frames

          const final = await page.evaluate(() => {
            const mod = window.__godsEyeView.dataManager.layers.get('traffic').module;
            return { stats: mod.getStats(), params: mod.getParams() };
          });
          const shot = `${view.id}--${style.id}--detect-${detect}.png`;
          await page.screenshot({ path: path.join(OUT_DIR, shot) });

          const b = final.stats.flowBuckets || {};
          // Bucket colors are the whole point of this capture, so a degraded
          // feed (mode 'live', flow down, every dot white) has to fail here.
          const colored = (b.free || 0) + (b.slow || 0) + (b.jam || 0);
          // A style swap can kick a re-render; capturing mid-load screenshots
          // the previous style's dots.
          const ok = !final.stats.loading
            && final.stats.mode === 'live' && !final.stats.error
            && final.stats.count > 0 && colored > 0
            && final.params.presetDots === 'on'
            && final.stats.stylePreset === style.name
            && final.stats.styleProfile === style.profile;
          if (!ok) exitCode = 1;
          console.log(`  [${ok ? 'OK' : 'FAIL'}] ${shot}  dots=${final.stats.count} `
            + `free=${b.free} slow=${b.slow} jam=${b.jam} sim=${b.sim} `
            + `stylePreset=${final.stats.stylePreset} profile=${final.stats.styleProfile} `
            + `err=${final.stats.error || 'none'} loading=${final.stats.loading}`);
          manifest.push({
            view: view.id, label: view.label,
            style: style.id, styleLabel: style.label, detect, shot,
            capturedAt: new Date().toISOString(),
            count: final.stats.count, flowBuckets: b,
            stylePreset: final.stats.stylePreset,
            styleProfile: final.stats.styleProfile,
            coveragePct: final.stats.flowCoveragePct,
            // A rejected capture must look rejected in the manifest too, not
            // just in the console verdict — record the gating fields.
            ok,
            loading: final.stats.loading,
            error: final.stats.error || null,
            renderSettled: final.renderSettled,
          });
        }
      }

      // Leave the page in the shipped default state between views.
      await page.evaluate(() => {
        const sm = window.__godsEyeView.styleManager;
        sm.setStyle('normal', { applyPreset: true });
        sm._setDetectionMode('OFF');
        if (sm.stages.thermal) sm.stages.thermal.uniforms.palette = 0.0;
      });
      await sleep(1000);
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
