#!/usr/bin/env node
/**
 * qa-firms.mjs — headless proof for the LIVE NASA FIRMS fires layer.
 *
 * Drives the REAL app in headless Chromium against a dev server with a
 * FIRMS key (default :4420). The live section rides the proxy's 30-min disk
 * cache (zero upstream quota risk per run); the degraded states are
 * fabricated with request interception so they're deterministic.
 *
 *   (i)   LIVE — layer loads >1000 detections, no error, label 'LIVE ·',
 *         /api/firms/status reports the key + transaction telemetry.
 *   (ii)  CARDS — the shared world-overlay canvas reports painted FIRMS
 *         entries and is non-blank at a fire cluster (detections LOD) AND at
 *         global zoom (cell cards); aggregate cells expose no action target.
 *   (iii) KEYLESS — /api/firms intercepted to 503 {error:'no_key'}:
 *         stats.error 'KEY REQUIRED', zero fires, no crash.
 *   (iv)  STALE — /api/firms intercepted to a stale:true payload with
 *         fresh-enough detections: stats.stale true, error 'STALE · …',
 *         fires still render (old data beats a wiped map).
 *   (v)   ACTION (synthetic) — one deterministic intercepted detection's
 *         accessible card selects exactly that stable fire and transfers the
 *         camera through the shared UI navigation policy.
 *
 * Visual proof saved to qa-shots/ (gitignored).
 *
 * Run:  node scripts/qa-firms.mjs --url http://localhost:4420
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
const APP_URL = getOpt('--url', 'http://localhost:4420');
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

/** Non-transparent pixels plus source-scoped host diagnostics. */
async function cardCanvasInk(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('world-overlay-canvas');
    const diagnostics = window.__gevWorldOverlay?.getDiagnostics?.();
    const painted = diagnostics?.paintedBySource?.firms || 0;
    const entries = diagnostics?.entriesBySource?.firms || 0;
    if (!canvas) return {
      present: false, ink: 0, painted, entries,
      candidates: diagnostics?.candidateCount || 0,
      projected: diagnostics?.projectedCount || 0,
    };
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    if (!width || !height) return {
      present: true, ink: 0, painted, entries,
      candidates: diagnostics?.candidateCount || 0,
      projected: diagnostics?.projectedCount || 0,
    };
    const data = ctx.getImageData(0, 0, width, height).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) ink++;
    return {
      present: true, ink, painted, entries,
      candidates: diagnostics?.candidateCount || 0,
      projected: diagnostics?.projectedCount || 0,
    };
  });
}

/** Wait for two consecutive painted frames instead of sampling a render gap. */
async function waitForCardCanvasInk(page, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  let sample = null;
  while (Date.now() < deadline) {
    await page.evaluate(() => window.__godsEyeView?.viewer?.scene?.requestRender?.());
    await sleep(150);
    sample = await cardCanvasInk(page);
    if (sample.present && sample.entries > 0 && sample.painted > 0 && sample.ink > 500) {
      consecutive += 1;
      if (consecutive >= 2) return sample;
    } else {
      consecutive = 0;
    }
  }
  return sample || {
    present: false, ink: 0, painted: 0, entries: 0, candidates: 0, projected: 0,
  };
}

/** Currently painted FIRMS actions mirrored for keyboard/assistive input. */
async function firmsActionSnapshot(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll(
      '#world-overlay-action-list button[data-overlay-action-key]',
    )].filter((button) => String(button.dataset.overlayActionKey || '').startsWith('firms\u0000'));
    return {
      count: buttons.length,
      selectedCount: buttons.filter((button) => button.getAttribute('aria-pressed') === 'true').length,
      labels: buttons.map((button) => button.getAttribute('aria-label') || button.textContent || ''),
    };
  });
}

/** Wait until the accessible mirror reflects the requested FIRMS action count. */
async function waitForFirmsActionCount(page, expected, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await firmsActionSnapshot(page);
  while (Date.now() < deadline && snapshot.count !== expected) {
    await page.evaluate(() => window.__godsEyeView?.viewer?.scene?.requestRender?.());
    await sleep(175);
    snapshot = await firmsActionSnapshot(page);
  }
  return snapshot;
}

/** Boot the app and enable the fires layer, polling until settled. */
async function bootAndEnable(page, { timeoutS = 45 } = {}) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 60000 },
  );
  await sleep(1500);
  return page.evaluate(async (tS) => {
    const dm = window.__godsEyeView.dataManager;
    await dm.setEnabled('local-firms', true);
    const mod = dm.layers.get('local-firms').module;
    let s = null;
    for (let i = 0; i < tS; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      s = mod.getStats();
      if ((s.count > 0 || s.error) && !s.loading) break;
    }
    return s;
  }, timeoutS);
}

/** Teleport the camera (duck-typed cartographic — no Cesium global). */
async function setView(page, lon, lat, height) {
  await page.evaluate((lo, la, h) => {
    const gev = window.__godsEyeView;
    const ell = gev.viewer.scene.globe.ellipsoid;
    const d2r = Math.PI / 180;
    // The app's intro flyTo animation clobbers a setView issued mid-flight.
    try { gev.viewer.camera.cancelFlight(); } catch { /* no flight active */ }
    gev.viewer.camera.setView({
      destination: ell.cartographicToCartesian({ longitude: lo * d2r, latitude: la * d2r, height: h }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    gev.viewer.scene.requestRender?.();
  }, lon, lat, height);
}

/** Fabricated stale-but-recent proxy payload for section (iv). */
function stalePayload() {
  const now = Date.now();
  const acq = new Date(now - 2 * 3600000);
  const acqDate = acq.toISOString().slice(0, 10);
  const acqTime = `${String(acq.getUTCHours()).padStart(2, '0')}${String(acq.getUTCMinutes()).padStart(2, '0')}`;
  const mk = (lat, lon, frp, confidence) => ({
    lat, lon, frp, confidence, brightness: 330, brightnessTi5: 290,
    daynight: 'N', acqDate, acqTime, satellite: 'N20', instrument: 'VIIRS',
  });
  return {
    fetchedAt: now - 2 * 3600000,
    stale: true,
    ttlMs: 1800000,
    sources: [{ source: 'VIIRS_NOAA20_NRT', count: 3, ok: false }],
    count: 3,
    fires: [mk(61.9, -122.9, 900, 'h'), mk(61.95, -122.8, 45, 'n'), mk(61.85, -123.0, 4, 'l')],
  };
}

async function main() {
  console.log('\nLive NASA FIRMS Proof (qa-firms)');
  console.log(`  App URL : ${APP_URL}\n`);

  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    process.exit(2);
  }

  const status = await fetch(`${APP_URL}/api/firms/status`).then((r) => r.json()).catch(() => null);
  if (!status?.hasKey) {
    console.error('\x1b[31mServer has no FIRMS key — run against the keyed dev server (:4420).\x1b[0m');
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

    // ── (i) LIVE feed ────────────────────────────────────────────────────────
    console.log('(i) LIVE — loading the fires layer through the cached proxy...');
    const live = await bootAndEnable(page);
    {
      const ok = live.count > 1000 && !live.error && String(live.loadingLabel || '').startsWith('LIVE');
      record('LIVE: >1000 detections, no error, LIVE label', ok,
        `count=${live.count} error=${JSON.stringify(live.error)} label=${JSON.stringify(live.loadingLabel)}`);
      record('LIVE: /api/firms/status has key + transaction telemetry',
        status.hasKey === true && (status.transactions === null || Number.isFinite(status.transactions?.used)),
        `transactions=${JSON.stringify(status.transactions)} count=${status.count}`);
      if (!ok) exitCode = 1;
    }

    // ── (ii) CARDS — canvas overlay draws at both LODs ──────────────────────
    console.log('\n(ii) CARDS — tactical card overlay ink at both LODs...');
    {
      const strongest = await page.evaluate(() => {
        const mod = window.__godsEyeView.dataManager.layers.get('local-firms').module;
        return mod.getStrongestFire();
      });
      if (!strongest) {
        record('CARDS: detections-LOD cards drawn', false, 'no strongest fire available');
        exitCode = 1;
      } else {
        await setView(page, strongest.longitude, strongest.latitude, 60000);
        const det = await waitForCardCanvasInk(page);
        record('CARDS: detections-LOD cards drawn (host source + canvas ink)',
          det.present && det.painted > 0 && det.ink > 500,
          `entries=${det.entries} candidates=${det.candidates} projected=${det.projected} `
          + `painted=${det.painted} inkPx=${det.ink} @ strongest fire FRP ${strongest.frp}`);
        if (!(det.present && det.painted > 0 && det.ink > 500)) exitCode = 1;
        await page.screenshot({ path: path.join(SHOTS_DIR, 'firms-cards-detections.png') });

        // Global LOD band starts at 9,000 km; its labelDistance is 12,000 km
        // (cards fade to zero beyond it, matching the legacy labels) — so the
        // cell-card proof must sit inside that window.
        await setView(page, strongest.longitude, strongest.latitude, 10000000);
        // Do not let the previous detections frame satisfy the ink predicate
        // before the 650 ms LOD watcher has swapped in aggregate cell cards.
        const aggregateActions = await waitForFirmsActionCount(page, 0);
        const cells = await waitForCardCanvasInk(page);
        record('CARDS: global-LOD cell cards drawn (host source + canvas ink)',
          cells.present && cells.painted > 0 && cells.ink > 500,
          `entries=${cells.entries} candidates=${cells.candidates} projected=${cells.projected} `
          + `painted=${cells.painted} inkPx=${cells.ink}`);
        if (!(cells.present && cells.painted > 0 && cells.ink > 500)) exitCode = 1;
        record('CARDS: aggregate cells expose no FIRMS action target',
          aggregateActions.count === 0,
          `actionButtons=${aggregateActions.count}`);
        if (aggregateActions.count !== 0) exitCode = 1;
        await page.screenshot({ path: path.join(SHOTS_DIR, 'firms-global-cells.png') });
      }
    }

    // ── (iii) KEYLESS (intercepted) ──────────────────────────────────────────
    console.log('\n(iii) KEYLESS — intercepted 503 no_key...');
    await page.setRequestInterception(true);
    let interceptMode = 'keyless';
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/firms/status')) {
        req.respond({
          status: 200, contentType: 'application/json',
          body: JSON.stringify(interceptMode === 'keyless'
            ? { hasKey: false }
            : { hasKey: true, lastFetch: Date.now() - 7200000, count: 3, stale: true, ttlMs: 1800000, transactions: null }),
        });
        return;
      }
      if (url.includes('/api/firms')) {
        if (interceptMode === 'keyless') {
          req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'no_key' }) });
        } else {
          req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(stalePayload()) });
        }
        return;
      }
      try { req.continue(); } catch { /* already handled */ }
    });

    const keyless = await bootAndEnable(page, { timeoutS: 20 });
    {
      const ok = keyless.error === 'KEY REQUIRED' && keyless.count === 0;
      record('KEYLESS: error "KEY REQUIRED", zero fires, no crash', ok,
        `error=${JSON.stringify(keyless.error)} count=${keyless.count} label=${JSON.stringify(keyless.loadingLabel)}`);
      if (!ok) exitCode = 1;
      await page.screenshot({ path: path.join(SHOTS_DIR, 'firms-keyless.png') });
    }

    // ── (iv) STALE (intercepted) ─────────────────────────────────────────────
    console.log('\n(iv) STALE — intercepted stale:true payload...');
    interceptMode = 'stale';
    const stale = await bootAndEnable(page, { timeoutS: 20 });
    {
      const ok = stale.stale === true
        && String(stale.error || '').startsWith('STALE')
        && stale.count === 3;
      record('STALE: stats.stale, "STALE · cached" error, fires still render', ok,
        `stale=${stale.stale} error=${JSON.stringify(stale.error)} count=${stale.count}`);
      if (!ok) exitCode = 1;
      await page.screenshot({ path: path.join(SHOTS_DIR, 'firms-stale.png') });
    }

    // ── (v) ACTION (deterministic intercepted detection) ────────────────────────
    console.log('\n(v) ACTION — synthetic intercepted fire card through shared camera policy...');
    await setView(page, -122.9, 61.9, 60000);
    const actionCards = await waitForCardCanvasInk(page);
    const beforeActions = await firmsActionSnapshot(page);
    if (!(actionCards.present && actionCards.painted > 0 && beforeActions.count > 0)) {
      record('ACTION (synthetic): individual fire action is available', false,
        `painted=${actionCards.painted} actionButtons=${beforeActions.count}`);
      exitCode = 1;
    } else {
      const prepared = await page.evaluate(() => {
        const gev = window.__godsEyeView;
        const mod = gev.dataManager.layers.get('local-firms').module;
        const target = mod.getDetectableObjects({ maxCount: 1 })[0];
        if (!target?.position) return null;

        const sentinel = gev.viewer.entities.add({
          id: 'qa-firms-prior-camera-owner',
          position: target.position,
        });
        gev.viewer.trackedEntity = sentinel;

        const camera = gev.viewer.camera;
        const originalFly = camera.flyToBoundingSphere;
        const proof = {
          sentinel,
          originalFly,
          flightCount: 0,
          trackedAtFlight: 'not-called',
          request: null,
          generationBefore: gev.styleManager._navigationGeneration,
        };
        proof.onRequest = (event) => {
          proof.request = {
            kind: event.detail?.kind || null,
            id: event.detail?.id || null,
          };
        };
        window.addEventListener('gev:world-request-focus', proof.onRequest);
        camera.flyToBoundingSphere = function qaFirmsObservedFlight(...args) {
          proof.flightCount += 1;
          proof.trackedAtFlight = gev.viewer.trackedEntity?.id || null;
          return originalFly.apply(this, args);
        };
        window.__qaFirmsActionProof = proof;
        return { generationBefore: proof.generationBefore };
      });

      if (!prepared) {
        record('ACTION (synthetic): individual fire action is available', false,
          'no deterministic fire position');
        exitCode = 1;
      } else {
        const clicked = await page.evaluate(() => {
          const button = [...document.querySelectorAll(
            '#world-overlay-action-list button[data-overlay-action-key]',
          )].find((candidate) => String(candidate.dataset.overlayActionKey || '').startsWith('firms\u0000'));
          button?.click();
          return Boolean(button);
        });

        for (let i = 0; i < 30; i += 1) {
          const settled = await page.evaluate(() => {
            window.__godsEyeView?.viewer?.scene?.requestRender?.();
            return (window.__qaFirmsActionProof?.flightCount || 0) > 0;
          });
          if (settled) break;
          await sleep(100);
        }
        await sleep(250);

        const proof = await page.evaluate(() => {
          const gev = window.__godsEyeView;
          const state = window.__qaFirmsActionProof;
          const actionButtons = [...document.querySelectorAll(
            '#world-overlay-action-list button[data-overlay-action-key]',
          )].filter((button) => String(button.dataset.overlayActionKey || '').startsWith('firms\u0000'));
          const selectedEntityId = window.__gevContextStore?.selectedEntityId || null;
          const result = {
            flightCount: state?.flightCount || 0,
            trackedAtFlight: state?.trackedAtFlight,
            trackingReleased: gev.viewer.trackedEntity == null,
            generationBefore: state?.generationBefore,
            generationAfter: gev.styleManager._navigationGeneration,
            request: state?.request || null,
            selectedEntityId,
            selectedActionCount: actionButtons.filter(
              (button) => button.getAttribute('aria-pressed') === 'true',
            ).length,
          };
          if (state) {
            gev.viewer.camera.flyToBoundingSphere = state.originalFly;
            window.removeEventListener('gev:world-request-focus', state.onRequest);
            if (state.sentinel) gev.viewer.entities.remove(state.sentinel);
          }
          delete window.__qaFirmsActionProof;
          return result;
        });

        const actionOk = clicked
          && proof.flightCount === 1
          && proof.trackedAtFlight == null
          && proof.trackingReleased
          && proof.generationAfter === proof.generationBefore + 1
          && proof.request?.kind === 'fire'
          && proof.request?.id === proof.selectedEntityId
          && proof.selectedActionCount === 1;
        record('ACTION (synthetic): stable fire selects once and shared policy owns flight', actionOk,
          `clicked=${clicked} flights=${proof.flightCount} trackedAtFlight=${JSON.stringify(proof.trackedAtFlight)} `
          + `generation=${proof.generationBefore}->${proof.generationAfter} `
          + `request=${JSON.stringify(proof.request)} selected=${JSON.stringify(proof.selectedEntityId)} `
          + `selectedActions=${proof.selectedActionCount}`);
        if (!actionOk) exitCode = 1;
        await page.screenshot({ path: path.join(SHOTS_DIR, 'firms-synthetic-fire-action.png') });
      }
    }
  } catch (e) {
    console.error('\x1b[31mHarness error:\x1b[0m', e);
    exitCode = 3;
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  console.log('\n' + '─'.repeat(60));
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log(`  Shots : ${SHOTS_DIR}/firms-*.png`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => { console.error(e); process.exit(3); });
