#!/usr/bin/env node
/**
 * track-regression.mjs
 *
 * DETERMINISTIC regression harness for 3D flight TRACKING.
 *
 * Background: tracked-plane 3D has regressed FOUR times (flicker → freeze →
 * jitter → pull-out → cross-layer orphan), each fix sometimes revealing the
 * next. This script locks the invariants so they can't silently break again.
 *
 * It drives the REAL app (http://localhost:4173) in headless Chromium with the
 * same WebGL launch flags the existing Cesium render harness uses
 * (tools/cesium-render.mjs): --use-gl=angle / --use-angle=swiftshader.
 *
 * DETERMINISM: it does NOT depend on live OpenSky / adsb.lol / AISStream
 * (all optional or rate-limited in local QA). Instead it installs a persistent
 * `fetch` shim in the page that intercepts the poll endpoints and returns
 * SYNTHETIC aircraft positioned near the camera, in the EXACT upstream payload
 * shapes the layers parse:
 *   - flights  → GET /api/opensky      → { states: [ <state-vector[]> ] }
 *   - military → GET /api/adsblol/mil  → { ac: [ <adsblol-aircraft{}> ] }
 *   - vessels  → GET /api/ais-live     → connected, zero-row snapshot
 * The shim stays installed so the layers' setInterval pollers keep the
 * synthetic planes alive (under MISSING_POLL_LIMIT=3 so they're never pruned).
 *
 * The four invariants, each one assertion block:
 *   1. NO JITTER          — the tracked plane's 3D MODEL position and its
 *                           getDetectableObjects() (HUD/detection) position use
 *                           the SAME per-frame value. We sample both over ~30
 *                           frames and assert max|visual-centre−detectable| ≈ 0.
 *   2. NO PULL-OUT        — tracking plane B while tracking A must not fly the
 *                           camera to a high overview (deselect/switch never
 *                           moves the camera — it stays in the follow band).
 *   3. NO CROSS-LAYER     — tracking military then commercial (and vice versa)
 *      ORPHAN               clears the FIRST layer (its getTrackedInfo()===null),
 *                           via the per-layer viewer.trackedEntityChanged listener.
 *   4. INIT CLEAN         — app loads, all 12 layers present, no console errors,
 *                           [Detection] Initialized + [TrackedReadout] Initialized.
 *
 * Plus two pre-ship-audit (2026-07-01) regressions appended at the end:
 *   H1. CLICK-OWN-PLANE   — the tracked standalone model exposes its pick id,
 *                           and a real mouse click on the tracked plane is a
 *                           NO-OP (no deselect, no camera spike).
 *   M3. AGE-OUT RELEASE   — when the tracked plane's fixes stop arriving
 *                           (3 missed polls via the shim), tracking clears and
 *                           the camera is RELEASED IN PLACE: viewer.trackedEntity
 *                           undefined, NO jump (product rule 2026-07-02 —
 *                           the old ~80 km overview flyTo is gone).
 *
 * And the landing-ghost polish (2026-07-02): a LOW+SLOW (landed) plane that
 * vanishes from the feed is removed after ONE missed poll, while a cruise
 * plane keeps the full 3-poll grace (it absorbs real feed gaps); the tracked
 * readout carries a "· STALE" cue while a tracked plane coasts through its
 * missed-poll grace, and drops it when the plane reappears.
 *
 * And the ground-traffic feature (2026-07-03, product change): present-but-
 * grounded planes render FULL-STRENGTH in the airborne tint pipeline
 * (white / amber-military; the day-1 gray mute was killed the same day) at
 * ×0.8 scale and stay detectable; the on_ground flip restyles the SAME
 * billboard in place (landing/takeoff transition — never a removal); a
 * grounded plane that then vanishes from the feed still fast-culls after one
 * missed poll (both layers; military keys off adsb.lol's alt_baro === "ground").
 * Ground billboards render depth-test-free (disableDepthTestDistance = ∞) so
 * the photoreal tile skin can't bury them up close; takeoff restores the test.
 *
 * And GROUND 3D (2026-07-03, product rule LOCKED: "when I have 3D mode —
 * proximity or all — I want that respected regardless of whether a plane is
 * on the ground or in the air. No distinction."): a synthetic on_ground plane
 * is model-ELIGIBLE and gets a model under the existing cap (both layers); its
 * model matrix height reads the ONE-SHOT cached ground snap — a stubbed
 * scene.sampleHeight (qa-cctv-drift-b9b style) + the per-layer belly offset —
 * never the buried/floating feed altitude, and never re-samples per frame;
 * the TRACKED grounded plane gets the standalone tracked model too (the
 * owner's "tracked SWA143 at 0 kts showed a 2D billboard" case).
 *
 * And arrival-rotation freshness (2026-07-03 ground-polish): camera.moveEnd
 * forces a full rotation pass on the next frame (fly-to settles the
 * pose-signature gate can eat), and a billboard flipping INTO view while the
 * camera idles re-aims the same tick instead of wearing a stale nose for up
 * to ROTATION_REFRESH_MS. Both layers.
 *
 * Run:  npm run test:track       (assumes dev server already up on :4173)
 *       node scripts/track-regression.mjs
 *
 * Exits non-zero if ANY invariant fails. DOES NOT COMMIT anything.
 *
 * Flags:
 *   --url <url>        App URL (default http://localhost:4173)
 *   --headful          Show the browser (debugging)
 *   --keep-open        Leave the browser open after the run (debugging)
 */

import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { classifyAircraft, CLASS_SCALE_3D, CLASS_MODEL_REAL } from '../src/data/aircraftClass.js';
import { ensureGeoidReady, geoidHeight } from '../src/data/geoid.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const getFlag = (name) => argv.includes(name);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APP_URL = getOpt('--url', 'http://localhost:4173');
const APP_ORIGIN = new URL(APP_URL).origin;
const HEADFUL = getFlag('--headful');
const KEEP_OPEN = getFlag('--keep-open');

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
    } catch {
      // Ignore inaccessible candidates and let Puppeteer fall back to its cache.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pretty PASS/FAIL reporting
// ---------------------------------------------------------------------------
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
function skip(name, why) {
  results.push({ name, ok: null, detail: why });
  console.log(`  [\x1b[33mSKIP\x1b[0m] ${name}  — ${why}`);
}

// ---------------------------------------------------------------------------
// Synthetic aircraft (positioned near Austin, the app's load view).
// Commercial ICAOs deliberately NOT in any known-military set so the flights
// layer doesn't suppress them; military hexes are whatever adsb.lol returns and
// the military layer registers them itself on parse.
// ---------------------------------------------------------------------------
const SYNTH = {
  // Austin load view is (-97.7431, 30.2672). Spread a few planes a few km apart.
  flights: [
    // [icao24, callsign, country, time_position, last_contact, lon, lat, baro_alt, on_ground, velocity, true_track]
    { icao: 'aaa001', callsign: 'SYN001', lon: -97.7431, lat: 30.2672, alt: 9000, vel: 230, track: 90 },
    { icao: 'aaa002', callsign: 'SYN002', lon: -97.7600, lat: 30.2800, alt: 9500, vel: 210, track: 45 },
    { icao: 'aaa003', callsign: 'SYN003', lon: -97.7300, lat: 30.2550, alt: 8700, vel: 250, track: 135 },
  ],
  // Two real, well-formed TLEs (ISS + Hubble). SGP4 needs a valid element set;
  // these are static public catalog entries, so the propagated positions are
  // reproducible run to run.
  tle: [
    'ISS (ZARYA)',
    '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9004',
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49814310 12345',
    'HST',
    '1 20580U 90037B   24001.50000000  .00001250  00000-0  67000-4 0  9992',
    '2 20580  28.4700 288.8102 0002613 321.7208 133.2117 15.09299130 12345',
    '',
  ].join('\n'),
  // One dense (Starlink-shell) element set, so dense mode has a real subject
  // to track. Same orbital elements as the ISS entry with a distinct satnum,
  // which keeps SGP4 valid and the propagation reproducible.
  denseTle: [
    'STARLINK-1007',
    '1 44713U 19074A   24001.50000000  .00016717  00000-0  10270-3 0  9004',
    '2 44713  53.0000 247.4627 0006703 130.5360 325.0288 15.06000000 12345',
    '',
  ].join('\n'),
  military: [
    // adsb.lol record fields: hex, flight, lon, lat, alt_baro (ft), track, gs (kt), t, r, ownOp, seen_pos
    { hex: 'bbb101', flight: 'MIL101', lon: -97.7500, lat: 30.2700, altFt: 28000, track: 270, gsKt: 420, t: 'F16', r: 'AF-101' },
    { hex: 'bbb102', flight: 'MIL102', lon: -97.7350, lat: 30.2600, altFt: 26000, track: 315, gsKt: 400, t: 'F18', r: 'AF-102' },
  ],
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n3D Tracking Regression Harness`);
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Mode    : ${HEADFUL ? 'headful' : 'headless'}\n`);

  // Verify the dev server is up before launching a browser.
  try {
    const res = await fetch(APP_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\x1b[31mDev server not reachable at ${APP_URL} (${e.message}).\x1b[0m`);
    console.error(`Start it first:  ./scripts/dev-fresh.sh   (or:  npm run dev)`);
    process.exit(2);
  }

  const chromeExecutable = findChromeExecutable();
  if (chromeExecutable) {
    console.log(`  Browser : ${chromeExecutable}\n`);
  }

  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    // This machine intermittently stalls single CDP calls past the 180 s
    // default under SwiftShader load (same hardening as qa-focus-evidence).
    protocolTimeout: 300_000,
    ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // SwiftShader only in headless: forcing it in headful defeats the whole
      // point of --headful (real GPU). Diagnosed 2026-08-03: under this
      // machine's Chrome 145 SwiftShader, loading the tracked military GLB
      // kills frame production entirely (rAF stops while timers/evals stay
      // alive), wedging any rAF-awaiting evaluation. Same policy as
      // qa-focus-evidence: headful = real GPU.
      ...(HEADFUL ? [] : ['--use-gl=angle', '--use-angle=swiftshader']),
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      // macOS stops frame production for fully-occluded windows, which kills
      // rAF (and thus every rAF-awaiting evaluation) in headful runs whose
      // window opens behind others — the qa-focus-evidence bringToFront
      // lesson, enforced belt-and-braces here.
      '--disable-backgrounding-occluded-windows',
      '--window-size=1280,800',
    ],
  });

  const consoleErrors = [];
  const failedResponses = [];
  const sawLog = { detection: false, readout: false };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === APP_ORIGIN && url.pathname === '/api/openai/hud-summary') {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ summary: 'QA globe ready' }),
        });
        return;
      }
      request.continue();
    });

    page.on('console', (msg) => {
      const text = msg.text();
      const type = msg.type();
      if (text.includes('[Detection] Initialized')) sawLog.detection = true;
      if (text.includes('[TrackedReadout] Initialized')) sawLog.readout = true;
      if (type === 'error') {
        // Ignore benign network resource 404s (e.g. an un-shimmed upstream
        // endpoint with no live data, a missing tile/favicon). Those are
        // environmental noise, not a tracking-invariant regression. Real JS
        // errors (TypeError, unhandled rejection, etc.) are still captured.
        const isBenign404 = /Failed to load resource.*404/i.test(text);
        const sourceUrl = msg.location()?.url || '';
        if (!isBenign404) consoleErrors.push(sourceUrl ? `${text} [${sourceUrl}]` : text);
      }
      // Surface a trace for debugging, but keep it quiet.
      if (process.env.GEV_TEST_VERBOSE) console.log(`    [page:${type}] ${text}`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('response', (response) => {
      if (response.status() >= 500) {
        failedResponses.push(`HTTP ${response.status()} ${response.url()}`);
      }
    });

    // ---- Install the synthetic-fetch shim BEFORE any app code runs ----------
    // Must be in place before the layers' first update() fires fetch(API_URL).
    await page.evaluateOnNewDocument((synth, appOrigin) => {
      // Stash the planes so the page can mutate them later (e.g. to advance
      // positions), and so we can confirm the shim is live.
      window.__SYNTH = synth;
      window.__SYNTH_HITS = { opensky: 0, mil: 0 };

      const realFetch = window.fetch.bind(window);
      const jsonResponse = (obj) =>
        new Response(JSON.stringify(obj), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      window.fetch = (input, init) => {
        const requestUrl = typeof input === 'string' || input instanceof URL
          ? String(input)
          : input?.url;
        const url = new URL(requestUrl, window.location.href);
        const isAppRequest = url.origin === appOrigin;
        // OpenSky (commercial flights): { states: [ state-vector[] ] }
        if (isAppRequest && url.pathname === '/api/opensky') {
          window.__SYNTH_HITS.opensky++;
          // A withheld contact models the ordinary case where the recipient's
          // first authoritative refresh does not yet carry the shared aircraft.
          const withheld = (() => {
            try { return window.sessionStorage.getItem('__gevWithhold') || ''; } catch { return ''; }
          })();
          const states = window.__SYNTH.flights
            .filter((f) => f.icao !== withheld)
            .map((f) => ([
            f.icao,            // 0 icao24
            f.callsign,        // 1 callsign
            'Synthetica',      // 2 origin_country
            Math.floor(Date.now() / 1000), // 3 time_position
            Math.floor(Date.now() / 1000), // 4 last_contact
            f.lon,             // 5 longitude
            f.lat,             // 6 latitude
            f.alt,             // 7 baro_altitude (m)
            f.onGround === true, // 8 on_ground (ground-traffic phase flips this live)
            f.vel,             // 9 velocity (m/s)
            f.track,           // 10 true_track (deg)
            0, null, null, null, false, 0, // padding to match state-vector length
          ]));
          return Promise.resolve(jsonResponse({ time: Math.floor(Date.now() / 1000), states }));
        }
        // Trail backfill (fires on trackById). Stub with valid-but-empty
        // payloads so the deterministic run never 404s against the dev proxy.
        // flights: { path: [ [time, lat, lon, baroAlt, true_track, on_ground] ] }
        if (isAppRequest && url.pathname === '/api/opensky-track') {
          return Promise.resolve(jsonResponse({ path: [] }));
        }
        // military: { timestamp: <epochSec>, trace: [ [secAfter, lat, lon, ...] ] }
        if (isAppRequest && url.pathname === '/api/adsblol/trace') {
          return Promise.resolve(jsonResponse({ timestamp: Math.floor(Date.now() / 1000), trace: [] }));
        }
        // adsbdb enrichment (fires for tracked/model-eligible planes): empty
        // object → typeCode stays null → the synthetic planes' class (and so
        // their 3D scale + ground-snap belly offset) is DETERMINISTIC, never a
        // live-proxy lookup of a fake hex.
        if (isAppRequest && /^\/api\/adsbdb\/(?:type|route)\/[^/]+$/.test(url.pathname)) {
          return Promise.resolve(jsonResponse({}));
        }
        // Contacts enables the optional AIS source alongside aircraft. Keep
        // this tracking harness independent of local AIS credentials while
        // preserving the truthful "awaiting first message" lifecycle.
        if (isAppRequest && url.pathname === '/api/ais-live') {
          return Promise.resolve(jsonResponse({
            status: 'connected',
            rows: [],
            lastMessageAt: null,
          }));
        }
        // CelesTrak TLE groups. Served from a fixed two-satellite catalog so
        // the satellite assertions are deterministic and the run never depends
        // on an upstream that rate-limits (it was answering 403 the night this
        // was written).
        if (isAppRequest && url.pathname.startsWith('/api/celestrak/')) {
          const group = url.pathname.slice('/api/celestrak/'.length);
          // One named group fails on demand. Failing a group the subject is
          // NOT in is the reclassification case: CelesTrak moves satellites
          // between groups, so a subject missing from its old group may have
          // moved into the one that just failed.
          if (window.__SYNTH.failGroup && group === window.__SYNTH.failGroup) {
            return Promise.resolve(new Response('upstream unavailable', { status: 503 }));
          }
          if (group === 'starlink') {
            // A dense load that FAILS is the case that erases the dense
            // request: settling a failure reverts the catalog mode to core.
            if (window.__SYNTH.failDense) {
              return Promise.resolve(new Response('upstream unavailable', { status: 503 }));
            }
            return Promise.resolve(new Response(window.__SYNTH.denseTle, {
              status: 200, headers: { 'Content-Type': 'text/plain' },
            }));
          }
          // EVERY core group serves the same catalog. Dedupe keeps the first
          // (stations) tag, so the catalog is unchanged — but no group is
          // EMPTY, and an empty group counts as failed, which would make an
          // `accepted` refresh (and therefore any release) unreachable here.
          return Promise.resolve(new Response(window.__SYNTH.tle, {
            status: 200, headers: { 'Content-Type': 'text/plain' },
          }));
        }
        // Voice scene context reverse-geocodes the view target and asks Places
        // for nearby names. Answer both with empty results: the entity-context
        // assertions are about the SELECTED contact, and a live lookup would
        // make the run non-hermetic (and bill the owner's Google quota).
        if (url.hostname === 'maps.googleapis.com' && url.pathname.startsWith('/maps/api/geocode')) {
          return Promise.resolve(jsonResponse({ status: 'ZERO_RESULTS', results: [] }));
        }
        if (isAppRequest && url.pathname === '/api/google/nearby-places') {
          return Promise.resolve(jsonResponse({ places: [] }));
        }
        // adsb.lol military: { ac: [ aircraft{} ] }  (must come AFTER /trace check)
        if (isAppRequest && url.pathname === '/api/adsblol/mil') {
          window.__SYNTH_HITS.mil++;
          const ac = window.__SYNTH.military.map((m) => ({
            hex: m.hex,
            flight: m.flight,
            lon: m.lon,
            lat: m.lat,
            alt_baro: m.altFt,
            track: m.track,
            gs: m.gsKt,
            t: m.t,
            r: m.r,
            ownOp: 'SYNTH AF',
            seen_pos: 0,
          }));
          return Promise.resolve(jsonResponse({ msg: 'No error', now: Date.now(), ac }));
        }
        return realFetch(input, init);
      };
    }, SYNTH, APP_ORIGIN);

    console.log('Loading app...');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (HEADFUL) await page.bringToFront();

    // Wait for the app to expose its globals (Cesium viewer + dataManager).
    await page.waitForFunction(
      () => window.__godsEyeView && window.__godsEyeView.viewer && window.__godsEyeView.dataManager,
      { timeout: 60000, polling: 200 }
    );
    console.log('  App globals ready.\n');

    // Small helper: run an expression in the page after the next render frame,
    // so reads happen on a settled frame.
    const evalPage = (fn, ...args) => page.evaluate(fn, ...args);

    // ============================================================
    // INVARIANT 4: INIT CLEAN  (run first — establishes baseline)
    // ============================================================
    console.log('Invariant 4 — init clean');
    // Give the app a moment to finish first-frame init (detection/readout log).
    await page.waitForFunction(
      () => {
        const dm = window.__godsEyeView.dataManager;
        return dm && dm.layers && dm.layers.size >= 12;
      },
      { timeout: 30000, polling: 200 }
    ).catch(() => {});

    const layerInfo = await evalPage(() => {
      const dm = window.__godsEyeView.dataManager;
      return {
        count: dm.layers.size,
        ids: [...dm.layers.keys()],
        hasFlights: dm.layers.has('flights'),
        hasMilitary: dm.layers.has('military'),
      };
    });
    record('init: >=12 layers registered', layerInfo.count >= 12,
      `${layerInfo.count} layers [${layerInfo.ids.join(', ')}]`);
    record('init: flights + military layers present',
      layerInfo.hasFlights && layerInfo.hasMilitary,
      `flights=${layerInfo.hasFlights} military=${layerInfo.hasMilitary}`);

    // Detection + TrackedReadout init logs are emitted during app boot.
    // Give them a beat in case they fire just after globals appear.
    await waitFor(() => sawLog.detection && sawLog.readout, 8000).catch(() => {});
    record('init: [Detection] Initialized logged', sawLog.detection);
    record('init: [TrackedReadout] Initialized logged', sawLog.readout);

    record('init: no console errors during boot', consoleErrors.length === 0,
      consoleErrors.length ? `${consoleErrors.length} error(s): ${consoleErrors.slice(0, 3).join(' | ')}` : 'clean');

    // Independent GLB capability control. Product model absence cannot prove
    // that the browser backend is incapable: that is the condition this
    // harness is meant to catch. Load the already-approved airplane asset
    // directly through Cesium, outside the Flights/Military model pipelines,
    // then remove the control before exercising product behavior.
    const glbControlStarted = await evalPage(async () => {
      window.__qaGlbControl = null;
      window.__qaGlbControlError = null;
      const asset = await fetch('/models/airplane.glb');
      const assetBytes = asset.ok ? (await asset.arrayBuffer()).byteLength : 0;
      if (!asset.ok || assetBytes === 0) {
        throw new Error(`GLB control asset unavailable: HTTP ${asset.status}`);
      }
      const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
      const viewer = window.__godsEyeView.viewer;
      const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
        Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 9000),
      );
      void Cesium.Model.fromGltfAsync({
        url: '/models/airplane.glb',
        modelMatrix,
        scale: 1,
      }).then((model) => {
        model.id = 'qa:independent-glb-control';
        window.__qaGlbControl = viewer.scene.primitives.add(model);
        viewer.scene.requestRender();
      }).catch((error) => {
        window.__qaGlbControlError = String(error?.message || error);
      });
      return true;
    }).catch((error) => {
      throw new Error(`Independent GLB capability control could not start: ${error.message}`);
    });
    const glbBackendCapable = glbControlStarted && await page.waitForFunction(() => {
      const control = window.__qaGlbControl;
      window.__godsEyeView.viewer.scene.requestRender();
      return Boolean(control?.ready);
    }, { timeout: 40000, polling: 250 }).then(() => true).catch(() => false);
    const glbControlDetail = await evalPage((capable) => {
      const viewer = window.__godsEyeView.viewer;
      const control = window.__qaGlbControl;
      const error = window.__qaGlbControlError;
      if (control) viewer.scene.primitives.remove(control);
      delete window.__qaGlbControl;
      delete window.__qaGlbControlError;
      return capable ? 'ready' : (error || 'did not become ready');
    }, glbBackendCapable);
    console.log(`  GLB capability control: ${glbBackendCapable ? 'ready' : 'unavailable'} (${glbControlDetail})`);

    // Hermeticity (round 5, 2026-07-06): the mesh-floor sampler probes the
    // REAL scene once per cell per poll. Under headless GL, Google tiles
    // sometimes stream at the synthetic-plane coords and sometimes don't, so
    // billboard datums varied run-to-run and flaked the ground/arrival
    // groups. Stub sampleHeight to "no tiles anywhere" for the whole run; the
    // ground-3d group REPLACES this with its counting 187.5 stub, restoring
    // the deterministic pre-round-5 datums everywhere else.
    await evalPage(() => {
      window.__godsEyeView.viewer.scene.sampleHeight = () => undefined;
    });

    // ============================================================
    // Enable flights + military layers and feed synthetic data.
    // ============================================================
    console.log('\nEnabling flights + military layers (synthetic feed)...');
    const enabled = await evalPage(async () => {
      const dm = window.__godsEyeView.dataManager;
      // setEnabled→toggle→init→enable→update(immediate fetch, shimmed).
      await dm.setEnabled('flights', true);
      await dm.setEnabled('military', true);
      // Drive 3D through the actual DISPLAY-rail control. This preserves the
      // user-facing ownership seam and proves that one toggle drives both
      // commercial and military layers before model-capacity assertions run.
      //
      // Since 2026-08-22 the toggle DEFAULTS ON, so the former "click it if it
      // is dark" arming step would have become a no-op and this check would
      // have quietly degraded into a restatement of the default. Drive a full
      // round trip instead — OFF, then back ON — so both directions are proven
      // through the real control no matter which way the default points.
      const fl = dm.layers.get('flights').module;
      const mil = dm.layers.get('military').module;
      const models3dButton = document.getElementById('models3d-toggle');
      const models3dOff = { button: null, fl: null, mil: null };
      if (models3dButton) {
        if (!models3dButton.classList.contains('active')) models3dButton.click();
        models3dButton.click(); // → OFF: both layers must follow the one control
        models3dOff.button = models3dButton.classList.contains('active');
        models3dOff.fl = fl.getParams().models3d;
        models3dOff.mil = mil.getParams().models3d;
        models3dButton.click(); // → ON: the state the rest of the run needs
      }
      // Force one more update each so freshly-shimmed data is ingested.
      await fl.update(window.__godsEyeView.viewer);
      await mil.update(window.__godsEyeView.viewer);
      return {
        flEnabled: dm.isEnabled('flights'),
        milEnabled: dm.isEnabled('military'),
        flStats: fl.getStats(),
        milStats: mil.getStats(),
        models3dButtonActive: models3dButton?.classList.contains('active') === true,
        flModels3d: fl.getParams().models3d,
        milModels3d: mil.getParams().models3d,
        models3dOff,
        hits: window.__SYNTH_HITS,
      };
    });
    console.log(`  flights enabled=${enabled.flEnabled} count=${enabled.flStats.count} | military enabled=${enabled.milEnabled} count=${enabled.milStats.count}`);
    console.log(`  shim hits: opensky=${enabled.hits.opensky} mil=${enabled.hits.mil}`);

    const injectionWorked = enabled.flStats.count > 0 && enabled.milStats.count > 0;
    record('inject: synthetic flights ingested (count>0)', enabled.flStats.count > 0,
      `flights count=${enabled.flStats.count}`);
    record('inject: synthetic military ingested (count>0)', enabled.milStats.count > 0,
      `military count=${enabled.milStats.count}`);
    record('DISPLAY-rail 3D toggle drives both aircraft layers, both directions',
      enabled.models3dButtonActive && enabled.flModels3d && enabled.milModels3d
      && enabled.models3dOff.button === false
      && enabled.models3dOff.fl === false && enabled.models3dOff.mil === false,
      `on: button=${enabled.models3dButtonActive} flights=${enabled.flModels3d} military=${enabled.milModels3d}`
      + ` | off: button=${enabled.models3dOff.button} flights=${enabled.models3dOff.fl} military=${enabled.models3dOff.mil}`);

    if (!injectionWorked) {
      skip('jitter / pull-out / orphan (need synthetic planes)',
        'synthetic injection produced 0 planes — see inject failures above');
      finishAndExit();
      return;
    }

    // ============================================================
    // SHARE LINK V2 — real reload restores the same logical plane.
    // ============================================================
    console.log('\nShare Link v2 — tracked aircraft survives a full reload');
    const shareTracked = await evalPage(() => (
      window.__godsEyeView.dataManager.layers
        .get('flights').module.trackById('aaa001', { origin: 'user' })
    ));
    await page.waitForFunction(
      () => {
        const flights = window.__godsEyeView?.dataManager?.layers?.get('flights')?.module;
        // `lo=` alone is NOT discriminating — the 3D-models option already
        // put an `lo` field in the hash before any aircraft was selected.
        // Wait for the tracking assignment itself.
        return location.hash.includes('v=2')
          && /[?&#]lo=[^&]*f\.t\.aaa001/.test(location.hash)
          && flights?.getParams?.().selectedFlightsTrackingId === 'aaa001';
      },
      // Share serialization is driven by the rendered state transition. On a
      // saturated headless GPU, ten seconds can expire before that frame even
      // though tracking is already accepted; keep the assertion identical but
      // give the callback the same 30 s budget as other reload/latch checks.
      { timeout: 30000, polling: 100 },
    );
    const trackedShareUrl = page.url();
    record(
      'share-v2: explicit aircraft selection reaches the generated URL',
      // Pin the ACTUAL tracking assignment (`f.t.<icao>`), not the mere
      // presence of an `lo` field that the 3D-models option already supplies.
      shareTracked
        && /[?&#]lo=[^&]*f\.t\.aaa001/.test(trackedShareUrl)
        && !trackedShareUrl.includes('f.t.aaa002'),
      trackedShareUrl,
    );

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.dataManager?.layers?.size >= 12,
      { timeout: 60000, polling: 200 },
    );
    await page.waitForFunction(
      () => {
        const manager = window.__godsEyeView?.dataManager;
        const tracked = manager?.layers?.get('flights')?.module?.getTrackedInfo?.();
        return manager?.isEnabled?.('flights')
          && tracked?.icao24 === 'aaa001'
          && window.__godsEyeView.viewer.trackedEntity?.gevTrackedId === 'flights:aaa001';
      },
      { timeout: 30000, polling: 100 },
    );
    const shareReload = await evalPage(() => {
      const manager = window.__godsEyeView.dataManager;
      const flights = manager.layers.get('flights').module;
      return {
        flightsEnabled: manager.isEnabled('flights'),
        trackedId: flights.getTrackedInfo()?.icao24 || null,
        durableId: flights.getParams()?.selectedFlightsTrackingId || null,
        viewerTrackedId: window.__godsEyeView.viewer.trackedEntity?.gevTrackedId || null,
      };
    });
    record(
      'share-v2: full reload restores the selected logical aircraft',
      shareReload.flightsEnabled
        && shareReload.trackedId === 'aaa001'
        && shareReload.durableId === 'aaa001',
      JSON.stringify(shareReload),
    );
    record(
      'share-v2: restored aircraft owns the Cesium follow camera',
      shareReload.viewerTrackedId === 'flights:aaa001',
      `viewerTrackedId=${shareReload.viewerTrackedId}`,
    );

    // Prove the URL itself owns the result. Remove the same-origin saved
    // preference, then open the captured link as a clean recipient would.
    await evalPage(() => localStorage.removeItem('gev:layer-state:v2'));
    await page.goto(trackedShareUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.dataManager?.layers?.size >= 12,
      { timeout: 60000, polling: 200 },
    );
    await page.waitForFunction(
      () => {
        const manager = window.__godsEyeView?.dataManager;
        const tracked = manager?.layers?.get('flights')?.module?.getTrackedInfo?.();
        return manager?.isEnabled?.('flights')
          && tracked?.icao24 === 'aaa001'
          && window.__godsEyeView.viewer.trackedEntity?.gevTrackedId === 'flights:aaa001';
      },
      { timeout: 30000, polling: 100 },
    );
    const cleanRecipient = await evalPage(() => {
      const manager = window.__godsEyeView.dataManager;
      const flights = manager.layers.get('flights').module;
      return {
        flightsEnabled: manager.isEnabled('flights'),
        trackedId: flights.getTrackedInfo()?.icao24 || null,
        durableId: flights.getParams()?.selectedFlightsTrackingId || null,
        viewerTrackedId: window.__godsEyeView.viewer.trackedEntity?.gevTrackedId || null,
      };
    });
    record(
      'share-v2: clean recipient magic link restores the selected aircraft',
      cleanRecipient.flightsEnabled
        && cleanRecipient.trackedId === 'aaa001'
        && cleanRecipient.durableId === 'aaa001'
        && cleanRecipient.viewerTrackedId === 'flights:aaa001',
      JSON.stringify(cleanRecipient),
    );
    // ---- Not-yet-arrived shared subject: PENDING, silent, then latches ----
    // Reload-from-local always survived a slow first refresh via the layer's
    // deferred-restore latch. The shared path used to decide on ONE refresh,
    // clear the subject, and post a failure notice seconds into startup.
    await evalPage(() => window.sessionStorage.setItem('__gevWithhold', 'aaa001'));
    // A goto whose URL differs only by hash is a SAME-DOCUMENT navigation: the
    // page would never reload and the app would keep its existing tracking.
    // Leave the document first so this is a real cold boot of the shared link.
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.goto(trackedShareUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.dataManager?.layers?.size >= 12,
      { timeout: 60000, polling: 200 },
    );
    await page.waitForFunction(
      () => document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 60000, polling: 200 },
    );
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const pendingShare = await evalPage(() => ({
      tracked: window.__godsEyeView.dataManager.layers
        .get('flights').module.getTrackedInfo()?.icao24 || null,
      notice: (document.getElementById('global-loading-label')?.textContent || '').trim(),
      noticeShown: !document.getElementById('global-loading-status')?.hidden,
    }));
    record(
      'share-v2: a not-yet-arrived subject is held pending, with no failure notice',
      pendingShare.tracked === null
        && !/unavailable|expired|could not be restored/i.test(
          pendingShare.noticeShown ? pendingShare.notice : '',
        ),
      JSON.stringify(pendingShare),
    );

    // The aircraft now arrives on a later poll; the latch must take it.
    await evalPage(() => window.sessionStorage.removeItem('__gevWithhold'));
    await evalPage(async () => {
      const flights = window.__godsEyeView.dataManager.layers.get('flights').module;
      for (let i = 0; i < 3; i += 1) {
        await flights.update(window.__godsEyeView.viewer);
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    });
    await page.waitForFunction(
      () => window.__godsEyeView?.dataManager?.layers?.get('flights')?.module
        ?.getTrackedInfo?.()?.icao24 === 'aaa001',
      { timeout: 30000, polling: 200 },
    ).catch(() => {});
    const latchedShare = await evalPage(() => ({
      tracked: window.__godsEyeView.dataManager.layers
        .get('flights').module.getTrackedInfo()?.icao24 || null,
      viewerTrackedId: window.__godsEyeView.viewer.trackedEntity?.gevTrackedId || null,
    }));
    record(
      'share-v2: the pending subject latches on when it arrives on a later poll',
      latchedShare.tracked === 'aaa001'
        && latchedShare.viewerTrackedId === 'flights:aaa001',
      JSON.stringify(latchedShare),
    );

    // The captured link intentionally contains only the explicitly owned
    // Flights layer. Restore the harness-only Military companion before the
    // legacy cross-layer invariants continue.
    await evalPage(async () => {
      const manager = window.__godsEyeView.dataManager;
      await manager.setEnabled('military', true);
      await manager.layers.get('military').module.update(window.__godsEyeView.viewer);
    });
    await evalPage(() => {
      window.__godsEyeView.viewer.scene.sampleHeight = () => undefined;
    });

    // ============================================================
    // VOICE ENTITY CONTEXT — a click-selected contact IS "the selected
    // entity". The aircraft layers publish selection on their own awareness
    // lane (the readout card + Contacts subject), and for the whole life of
    // the voice tools they never wrote the SHARED context slot that
    // `get_entity_context` reads. So with a plane plainly selected on screen,
    // `{scope:'selected'}` silently downgraded to `'in_view'` and the model
    // answered "there isn't a plane currently selected" (field session,
    // 2026-08-21). Drives the real tool runner; costs no model turns.
    // ============================================================
    console.log('\nVoice entity context — a click-selected contact answers scope:selected');
    const runnerReady = await evalPage(() => typeof window.__gevVoiceCommands?.runner === 'function');
    if (!runnerReady) {
      skip('voice-context: click-selected aircraft answers scope:selected',
        'voice command runner not exposed on this build');
    } else {
      const flightSelected = await evalPage(async () => {
        const flights = window.__godsEyeView.dataManager.layers.get('flights').module;
        // The exact call the canvas click handler makes on a billboard pick.
        flights.trackById('aaa001', { origin: 'user' });
        const result = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        return {
          scope: result?.scope || null,
          layerId: result?.selected?.layerId || null,
          id: result?.selected?.id || null,
          name: result?.selected?.name || null,
          latitude: result?.selected?.latitude ?? null,
          callsign: result?.selected?.properties?.callsign || null,
        };
      });
      record(
        'voice-context: click-selected aircraft answers scope:selected',
        flightSelected.scope === 'selected'
          && flightSelected.layerId === 'flights'
          && flightSelected.id === 'aaa001',
        JSON.stringify(flightSelected),
      );
      record(
        'voice-context: the selected contact carries its identity and position',
        flightSelected.name === 'SYN001'
          && flightSelected.callsign === 'SYN001'
          && Number.isFinite(flightSelected.latitude),
        JSON.stringify(flightSelected),
      );

      // Selecting a different contact must MOVE the subject, not stack a
      // second one: a frozen record left behind would be narrated later at a
      // position its aircraft has long since left.
      const switchedSubject = await evalPage(async () => {
        const manager = window.__godsEyeView.dataManager;
        manager.layers.get('flights').module.trackById('aaa002', { origin: 'user' });
        const result = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        const store = window.__gevContextStore;
        const flightRecords = [...store.entities.values()].filter((r) => r.layerId === 'flights');
        return {
          scope: result?.scope || null,
          id: result?.selected?.id || null,
          flightRecordIds: flightRecords.map((r) => r.id),
        };
      });
      record(
        'voice-context: switching contacts moves the subject and leaves no stale record',
        switchedSubject.scope === 'selected'
          && switchedSubject.id === 'aaa002'
          && switchedSubject.flightRecordIds.length === 1
          && switchedSubject.flightRecordIds[0] === 'aaa002',
        JSON.stringify(switchedSubject),
      );

      // A military contact is the same click, on the sibling layer.
      const militarySelected = await evalPage(async () => {
        const manager = window.__godsEyeView.dataManager;
        manager.layers.get('flights').module.stopTracking();
        manager.layers.get('military').module.trackById('bbb101', { origin: 'user' });
        const result = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        return {
          scope: result?.scope || null,
          layerId: result?.selected?.layerId || null,
          id: result?.selected?.id || null,
          name: result?.selected?.name || null,
        };
      });
      record(
        'voice-context: click-selected military contact answers scope:selected',
        militarySelected.scope === 'selected'
          && militarySelected.layerId === 'military'
          && militarySelected.id === 'bbb101'
          && militarySelected.name === 'MIL101',
        JSON.stringify(militarySelected),
      );

      // Deselecting must give the slot back — a subject that outlives its
      // selection is the same bug pointed the other way.
      const deselected = await evalPage(async () => {
        const manager = window.__godsEyeView.dataManager;
        manager.layers.get('military').module.stopTracking();
        const result = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        return { scope: result?.scope || null, selected: result?.selected ?? null };
      });
      record(
        'voice-context: deselecting releases the subject back to in_view',
        deselected.scope === 'in_view' && deselected.selected === null,
        JSON.stringify(deselected),
      );

      // ============================================================
      // SATELLITES — same PRD gap as the aircraft layers: a tracked satellite
      // published only its awareness event, so voice could not see it either.
      // ============================================================
      console.log('\nVoice entity context — a tracked satellite is a selected subject');
      const satelliteContext = await evalPage(async () => {
        const manager = window.__godsEyeView.dataManager;
        await manager.setEnabled('satellites', true);
        const satellites = manager.layers.get('satellites').module;
        // Wait for the shimmed stations catalog to build its satrecs.
        for (let i = 0; i < 80; i += 1) {
          if (satellites.getStats?.().count > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const tracked = satellites.trackById(25544, { origin: 'user' });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const selected = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        // Switching subjects must move the slot, not stack a second orbit.
        satellites.trackById(20580, { origin: 'user' });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const switched = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        const satelliteRecordIds = [...window.__gevContextStore.entities.values()]
          .filter((record) => record.layerId === 'satellites')
          .map((record) => record.id);
        // CATALOG REBUILD. The tracked satellite's catalog entry is replaced
        // wholesale by a TLE refresh, so a surviving subject must re-resolve
        // against the new satrec — and a subject that did NOT survive must
        // release the slot rather than linger frozen at its last position.
        satellites.trackById(25544, { origin: 'user' });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await satellites.update(window.__godsEyeView.viewer);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const afterRebuild = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });

        // RECLASSIFICATION: the subject vanishes from the catalog while a
        // DIFFERENT group — one it could have been moved into — failed to
        // load. Its own group loaded fine, so a group-scoped proof would call
        // this a disappearance. It is not: absence is only proven when every
        // potential carrier loaded.
        const fullTle = window.__SYNTH.tle;
        const truncatedTle = fullTle.split('\n').slice(3).join('\n');
        window.__SYNTH.tle = truncatedTle;
        window.__SYNTH.failGroup = 'geo';
        await satellites.update(window.__godsEyeView.viewer);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const afterPartial = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        window.__SYNTH.failGroup = null;
        window.__SYNTH.tle = fullTle;
        // Recover, so the release case below starts from a healthy subject.
        await satellites.update(window.__godsEyeView.viewer);
        await new Promise((resolve) => setTimeout(resolve, 800));

        // Now the subject vanishes from a COMPLETE catalog — proven absence.
        window.__SYNTH.tle = fullTle.split('\n').slice(3).join('\n');
        await satellites.update(window.__godsEyeView.viewer);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const afterSubjectGone = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        window.__SYNTH.tle = fullTle;

        // DENSE CARRIER FAILURE. Track a dense-shell satellite, then let the
        // dense load fail on the next rebuild. Settling that failure reverts
        // the catalog mode to 'core', so anything reading the mode AFTER the
        // await no longer sees that dense was ever a potential carrier — and
        // would delete a subject the dense catalog might have carried.
        satellites.setParams({ catalog: 'dense' });
        for (let i = 0; i < 80; i += 1) {
          if (satellites.getStats?.().count > 2) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const denseTracked = satellites.trackById(44713, { origin: 'user' });
        await new Promise((resolve) => setTimeout(resolve, 600));
        const denseSelected = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        window.__SYNTH.failDense = true;
        await satellites.update(window.__godsEyeView.viewer);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const afterDenseFailure = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        const catalogModeAfterFailure = satellites.getParams?.().catalog ?? null;
        window.__SYNTH.failDense = false;
        satellites.setParams({ catalog: 'core' });
        satellites.stopTracking?.();
        await new Promise((resolve) => setTimeout(resolve, 400));

        satellites.trackById(25544, { origin: 'user' });
        await new Promise((resolve) => setTimeout(resolve, 400));
        satellites.stopTracking?.();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const released = await window.__gevVoiceCommands.runner('get_entity_context', { scope: 'selected' });
        await manager.setEnabled('satellites', false);
        // Following a satellite left the camera in orbit. Hand it back to the
        // synthetic fleet so later groups see the view they were written for.
        manager.layers.get('flights').module.trackById('aaa001', { origin: 'user' });
        await new Promise((resolve) => setTimeout(resolve, 600));
        return {
          tracked,
          scope: selected?.scope ?? null,
          layerId: selected?.selected?.layerId ?? null,
          id: selected?.selected?.id ?? null,
          name: selected?.selected?.name ?? null,
          latitude: selected?.selected?.latitude ?? null,
          switchedId: switched?.selected?.id ?? null,
          satelliteRecordIds,
          releasedScope: released?.scope ?? null,
          releasedSelected: released?.selected ?? null,
          rebuiltScope: afterRebuild?.scope ?? null,
          rebuiltId: afterRebuild?.selected?.id ?? null,
          rebuiltLatitude: afterRebuild?.selected?.latitude ?? null,
          goneScope: afterSubjectGone?.scope ?? null,
          goneSelected: afterSubjectGone?.selected ?? null,
          partialScope: afterPartial?.scope ?? null,
          partialId: afterPartial?.selected?.id ?? null,
          denseTracked,
          denseSelectedId: denseSelected?.selected?.id ?? null,
          denseFailureScope: afterDenseFailure?.scope ?? null,
          denseFailureId: afterDenseFailure?.selected?.id ?? null,
          catalogModeAfterFailure,
        };
      });
      record(
        'voice-context: a tracked satellite answers scope:selected with its identity',
        satelliteContext.tracked === true
          && satelliteContext.scope === 'selected'
          && satelliteContext.layerId === 'satellites'
          && satelliteContext.id === '25544'
          && /ISS/.test(satelliteContext.name || '')
          && Number.isFinite(satelliteContext.latitude),
        JSON.stringify(satelliteContext),
      );
      record(
        'voice-context: switching satellites moves the subject and leaves no stale orbit',
        satelliteContext.switchedId === '20580'
          && satelliteContext.satelliteRecordIds.length === 1
          && satelliteContext.satelliteRecordIds[0] === '20580',
        JSON.stringify(satelliteContext),
      );
      record(
        'voice-context: the subject survives a catalog rebuild under the same id',
        satelliteContext.rebuiltScope === 'selected'
          && satelliteContext.rebuiltId === '25544'
          && Number.isFinite(satelliteContext.rebuiltLatitude),
        JSON.stringify(satelliteContext),
      );
      record(
        'voice-context: a subject missing while ANOTHER potential carrier failed is preserved',
        satelliteContext.partialScope === 'selected' && satelliteContext.partialId === '25544',
        JSON.stringify(satelliteContext),
      );
      record(
        'voice-context: a subject that does not survive the rebuild releases the slot',
        satelliteContext.goneScope === 'in_view' && satelliteContext.goneSelected === null,
        JSON.stringify(satelliteContext),
      );
      record(
        'voice-context: a failed DENSE load preserves its subject, even though the mode reverts',
        satelliteContext.denseTracked === true
          && satelliteContext.denseSelectedId === '44713'
          && satelliteContext.catalogModeAfterFailure === 'core'
          && satelliteContext.denseFailureScope === 'selected'
          && satelliteContext.denseFailureId === '44713',
        JSON.stringify(satelliteContext),
      );
      record(
        'voice-context: deselecting a satellite releases the subject',
        satelliteContext.releasedScope === 'in_view' && satelliteContext.releasedSelected === null,
        JSON.stringify(satelliteContext),
      );

      // ============================================================
      // PANEL === SPOKEN. Not the shared helper as a stand-in: the REAL
      // Contacts pipeline (awareness selects a subject, evaluateSubject fills
      // the snapshot, the panel renders it) against the REAL voice tool. A
      // divergence introduced at the call site itself — not in the helper —
      // has to go red here.
      // ============================================================
      console.log('\nPanel === spoken — one number, through both real call sites');
      const panelVsSpoken = await evalPage(async () => {
        const manager = window.__godsEyeView.dataManager;
        if (!manager.isEnabled('flights')) await manager.setEnabled('flights', true);
        if (!manager.isEnabled('military')) await manager.setEnabled('military', true);
        // Enter Contacts the way the operator does, then select a contact so
        // awareness has a real subject.
        const button = document.getElementById('global-context-flights-btn');
        if (button && !window.__godsEyeView.styleManager.getContextModeState?.().mode) button.click();
        for (let i = 0; i < 80; i += 1) {
          if (window.__godsEyeView.styleManager.getContextModeState?.().mode) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        manager.layers.get('flights').module.trackById('aaa001', { origin: 'user' });
        // Awareness recomputes on its own cadence; wait for a real snapshot.
        const awareness = manager.layers.get('military-awareness')?.module;
        let snapshot = null;
        for (let i = 0; i < 80; i += 1) {
          snapshot = awareness?.getContextSnapshot?.() || null;
          if (snapshot?.cohorts?.length) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (!snapshot?.subject) return { error: 'awareness produced no subject' };
        const countFor = (id) => {
          const cohort = snapshot.cohorts.find((entry) => entry?.id === id);
          return Number.isFinite(cohort?.count) ? cohort.count : null;
        };
        // What the PANEL shows, read from the snapshot it renders.
        const panelAircraft = (countFor('flights') ?? 0) + (countFor('military') ?? 0);
        // What VOICE says, through the real tool runner.
        const spoken = await window.__gevVoiceCommands.runner('analyst_query', {
          layers: ['flights', 'military'],
          scope: { kind: 'radius', km: Math.round((snapshot.radiusM || 250000) / 1000) },
        });
        return {
          subject: snapshot.subject.label || snapshot.subject.id || null,
          panelAircraft,
          spokenCount: spoken?.count ?? null,
          spokenEngine: spoken?.window?.engine ?? null,
          spokenCenteredOn: spoken?.window?.centeredOn ?? null,
        };
      });
      record(
        'panel===spoken: the Contacts panel and the voice count are one number',
        !panelVsSpoken.error
          && panelVsSpoken.spokenEngine === 'contacts-window'
          && panelVsSpoken.spokenCount === panelVsSpoken.panelAircraft,
        JSON.stringify(panelVsSpoken),
      );
      record(
        'panel===spoken: the spoken answer names the subject whose window it read',
        !panelVsSpoken.error && panelVsSpoken.spokenCenteredOn === panelVsSpoken.subject,
        JSON.stringify(panelVsSpoken),
      );
      // Leave Contacts as the vocabulary group expects to find it.
      await evalPage(async () => {
        try { await window.__gevVoiceCommands.runner('set_context_mode', { mode: 'off' }); } catch {}
      });

      // ============================================================
      // CONTEXT VOCABULARY — state output must speak the words the tools
      // accept. The Contacts mode's internal id is 'flights' while
      // `set_context_mode` takes 'contacts', and state surfaces reported the
      // internal id: the model read `mode:'flights'`, concluded Contacts was
      // off, and refused to answer from the Contacts window counts carried in
      // the same payload (field session, 2026-08-21).
      // ============================================================
      console.log('\nContext vocabulary — state output speaks the tools\' own words');
      const manualContacts = await evalPage(async () => {
        const button = document.getElementById('global-context-flights-btn');
        if (!button) return { error: 'Contacts control not found' };
        // The MANUAL path is the one that broke silently — voice never set it.
        button.click();
        for (let i = 0; i < 60; i += 1) {
          if (window.__godsEyeView.styleManager.getContextModeState?.().mode) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const state = await window.__gevVoiceCommands.runner('get_current_view_state');
        return {
          internalMode: window.__godsEyeView.styleManager.getContextModeState?.().mode || null,
          reportedMode: state?.context?.mode ?? null,
          reportedInternal: state?.context?.modeInternal ?? null,
          active: state?.context?.active ?? null,
        };
      });
      record(
        'context-vocab: a manually activated Contacts reports as "contacts", not its internal id',
        manualContacts.internalMode === 'flights'
          && manualContacts.reportedMode === 'contacts'
          && manualContacts.reportedInternal === 'flights'
          && manualContacts.active === true,
        JSON.stringify(manualContacts),
      );

      // Round-trip: whatever state output reports must be a word the tool
      // accepts. Feeding the reported mode straight back must not be rejected.
      const roundTrip = await evalPage(async (reported) => {
        const result = await window.__gevVoiceCommands.runner('set_context_mode', { mode: reported });
        const state = await window.__gevVoiceCommands.runner('get_current_view_state');
        return {
          ok: result?.ok ?? null,
          error: result?.error || null,
          resultMode: result?.mode ?? null,
          resultInternal: result?.modeInternal ?? null,
          stateMode: state?.context?.mode ?? null,
        };
      }, manualContacts.reportedMode);
      record(
        'context-vocab: the reported mode round-trips back through set_context_mode',
        roundTrip.ok === true
          && !roundTrip.error
          && roundTrip.resultMode === 'contacts'
          && roundTrip.resultInternal === 'flights'
          && roundTrip.stateMode === 'contacts',
        JSON.stringify(roundTrip),
      );

      const contextOff = await evalPage(async () => {
        const result = await window.__gevVoiceCommands.runner('set_context_mode', { mode: 'off' });
        const state = await window.__gevVoiceCommands.runner('get_current_view_state');
        return {
          resultMode: result?.mode ?? null,
          stateMode: state?.context?.mode ?? null,
          stateInternal: state?.context?.modeInternal ?? null,
        };
      });
      record(
        'context-vocab: no context reports as "off", never a bare null',
        contextOff.resultMode === 'off'
          && contextOff.stateMode === 'off'
          && contextOff.stateInternal === null,
        JSON.stringify(contextOff),
      );

      // ============================================================
      // ANALYST -> TRACK HANDOFF — the tool instructions tell the model to
      // look a contact up with analyst_query and hand that identity to
      // track_entity. The analyst's `id` is a DISPLAY label (callsign, else
      // registration, else hex) and the lookup matched callsigns and hex
      // only, so a callsign-less contact came back as its tail number and
      // "Nothing matched" — the model then burned the turn on retries (owner
      // field session 2026-08-21, 23:48: three failed track_entity calls
      // before a fallback stuck).
      // ============================================================
      console.log('\nAnalyst handoff — a looked-up contact can actually be tracked');
      const handoff = await evalPage(async () => {
        const manager = window.__godsEyeView.dataManager;
        // This group owns its precondition: earlier groups toggle Contacts,
        // which snapshots and restores layer state around itself.
        if (!manager.isEnabled('military')) await manager.setEnabled('military', true);
        const mil = manager.layers.get('military').module;
        const priorFixture = window.__SYNTH.military.slice();
        window.__SYNTH.military = [...priorFixture, {
          hex: 'bbb777', flight: '', lon: -97.7440, lat: 30.2680,
          altFt: 1800, track: 210, gsKt: 130, t: 'UH60', r: '6606',
        }];
        try {
          await mil.update(window.__godsEyeView.viewer);
          // Scope is deliberately 'anywhere': what is under test is the
          // identity handoff, not spatial filtering, and an earlier group may
          // have left the camera somewhere else entirely.
          const analyst = await window.__gevVoiceCommands.runner('analyst_query', {
            layers: ['military'], scope: { kind: 'anywhere' }, limit: 10,
          });
          const item = (analyst?.items || []).find((entry) => entry.id === '6606') || null;
          const tracked = item
            ? await window.__gevVoiceCommands.runner('track_entity', { query: item.id, layerId: 'military' })
            : null;
          return {
            militaryEnabled: manager.isEnabled('military'),
            militaryCount: mil.getStats?.().count ?? null,
            itemCount: (analyst?.items || []).length,
            itemFound: Boolean(item),
            itemId: item?.id ?? null,
            itemIcao: item?.icao24 ?? null,
            trackOk: tracked?.ok ?? null,
            trackError: tracked?.error ?? null,
            trackedIcao: mil.getTrackedInfo()?.icao24 ?? null,
          };
        } finally {
          window.__SYNTH.military = priorFixture;
          mil.stopTracking();
          await mil.update(window.__godsEyeView.viewer);
        }
      });
      record(
        'analyst-handoff: a callsign-less contact is named by the tail number the app shows',
        handoff.itemFound && handoff.itemId === '6606',
        JSON.stringify(handoff),
      );
      record(
        'analyst-handoff: the identity the analyst returned is trackable, first try',
        handoff.trackOk === true
          && !handoff.trackError
          && handoff.trackedIcao === 'bbb777',
        JSON.stringify(handoff),
      );
      record(
        'analyst-handoff: the result carries the hex key the tracker keys on',
        handoff.itemIcao === 'bbb777',
        JSON.stringify(handoff),
      );

      // Restore the state the downstream invariants were written against:
      // flights following aaa001, military idle.
      await evalPage(() => {
        window.__godsEyeView.dataManager.layers.get('flights').module.trackById('aaa001', { origin: 'user' });
      });
      await page.waitForFunction(
        () => window.__godsEyeView?.dataManager?.layers?.get('flights')?.module
          ?.getTrackedInfo?.()?.icao24 === 'aaa001',
        { timeout: 15000, polling: 100 },
      );
    }

    // NOTE: we do NOT manually reposition the camera. Tracking sets
    // viewer.trackedEntity + a calibrated viewFrom, so the follow camera lands
    // in the few-km band (altitude*1.1+2500, clamped 3–30 km) — far below the
    // MODEL_ALT_CEIL_M = 800 km ceiling, so _modelRegimeActive() is true and the
    // standalone tracked model renders. That's the exact path the invariants
    // protect, so we exercise it rather than a synthetic setView.

    // ============================================================
    // INVARIANT 1: NO JITTER
    //   model visual centre === getDetectableObjects() position, per frame.
    // ============================================================
    console.log('\nInvariant 1 — no jitter (model visual centre === detectable pos)');

    // Install a scene-graph model finder in the page FIRST (used by the wait
    // below). The tracked model is a standalone Cesium.Model added to a
    // PrimitiveCollection under scene.primitives. We locate the shown Model whose
    // matrix translation is nearest the tracked display position.
    await evalPage(() => {
      window.__findTrackedModel = function () {
        const v = window.__godsEyeView.viewer;
        const prims = v.scene.primitives;
        const out = [];
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            const p = coll.get(i);
            if (!p) continue;
            // PrimitiveCollection has .length + .get
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            // A Cesium.Model has a modelMatrix (Matrix4: column-major Float64Array-like)
            if (p.modelMatrix && typeof p.ready !== 'undefined') out.push(p);
          }
        };
        walk(prims);
        // Prefer shown+ready models.
        const shown = out.filter((m) => m.show && m.ready);
        const pool = shown.length ? shown : out;
        if (!pool.length) return null;
        // If tracking, pick the model nearest the tracked display position.
        const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
        // Prefer the tracked model's explicit H1 pick id. A neighboring fleet
        // model can temporarily be nearer while the follow camera/model matrix
        // settles after the cross-layer switch sequence, causing this probe to
        // report the neighbor's id even though the correct tracked model is up.
        const trackedInfo = fl.getTrackedInfo();
        const exactPickModel = trackedInfo
          ? pool.find((model) => String(model.id) === trackedInfo.icao24)
          : null;
        if (exactPickModel) return exactPickModel;
        const ent = window.__godsEyeView.viewer.trackedEntity;
        let tracked = null;
        if (ent && typeof ent.gevDisplayPosition === 'function') tracked = ent.gevDisplayPosition();
        if (!tracked) return pool[0];
        let best = null, bestD = Infinity;
        for (const m of pool) {
          const mm = m.modelMatrix;
          const dx = mm[12] - tracked.x, dy = mm[13] - tracked.y, dz = mm[14] - tracked.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; best = m; }
        }
        // The tracked model rides AT the display position. While the tracked
        // GLB is still loading, the nearest ready model is some OTHER plane's
        // fleet model km away — returning it made the model-up waits resolve
        // spuriously and H1 read a neighbor's pick id. Anything beyond 1 km
        // is "tracked model not up yet", not a match.
        return bestD < 1000 * 1000 ? best : null;
      };
    });

    // Track a synthetic commercial plane. Tracking sets viewer.trackedEntity +
    // viewFrom, so the follow camera lands in the few-km band and the standalone
    // 3D model renders (model regime active below the 800 km ceiling).
    const trackedIcao = SYNTH.flights[0].icao;
    await evalPage((icao) => {
      window.__godsEyeView.dataManager.layers.get('flights').module.trackById(icao);
    }, trackedIcao);
    await sleep(1500); // let the follow camera settle + the GLB load kick off

    // Wait until the tracked Cesium.Model primitive exists, is ready & shown.
    const modelUp = await page.waitForFunction((icao) => {
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      const ti = fl.getTrackedInfo();
      if (!ti || ti.icao24 !== icao) return false;
      const found = window.__findTrackedModel ? window.__findTrackedModel() : null;
      return !!(found && found.ready && found.show && String(found.id) === icao);
    }, { timeout: 60000, polling: 250 }, trackedIcao).then(() => true).catch(() => false);
    record('3D: tracked commercial model becomes ready through the DISPLAY toggle', modelUp,
      modelUp ? `ready+shown id=${trackedIcao}` : 'tracked product model never became ready+shown');

    let jitterResult;
    if (!modelUp) {
      // Model didn't come up — still test the underlying invariant: the tracked
      // entity's exposed display position (what the model uses) must equal the
      // getDetectableObjects() position. This is the exact shared-source contract.
      jitterResult = await sampleFrames(page, 30, (icao) => {
        const dm = window.__godsEyeView.dataManager;
        const fl = dm.layers.get('flights').module;
        const ent = window.__godsEyeView.viewer.trackedEntity;
        const disp = ent && typeof ent.gevDisplayPosition === 'function' ? ent.gevDisplayPosition() : null;
        const dets = fl.getDetectableObjects({ maxCount: 1000 });
        const me = dets.find((d) => d.id === icao || d.id === (fl.getTrackedInfo() && fl.getTrackedInfo().callsign));
        if (!disp || !me || !me.position) return null;
        const dx = disp.x - me.position.x, dy = disp.y - me.position.y, dz = disp.z - me.position.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      }, trackedIcao);
      console.log('  (3D model did not render under SwiftShader; testing the shared display-position contract directly)');
    } else {
      // Full check: independently transform airplane.glb's measured AABB centre
      // through the actual 3D model matrix, then compare it with detection.
      // glTF [x,y,z] → Cesium-local [x,-z,y]. The effective rendered
      // computedScale is separate from modelMatrix and includes any
      // minimumPixelSize enlargement, so include it just as the renderer does.
      jitterResult = await sampleFrames(page, 30, (icao) => {
        const dm = window.__godsEyeView.dataManager;
        const fl = dm.layers.get('flights').module;
        const ti = fl.getTrackedInfo();
        const model = window.__findTrackedModel();
        if (!model) return null;
        const mm = model.modelMatrix;
        const scale = Number.isFinite(model.computedScale)
          ? model.computedScale
          : (Number.isFinite(model.scale) ? model.scale : 1);
        // airplane.glb is now bounding-box centred with transforms applied.
        const x = 0 * scale;
        const y = 0 * scale;
        const z = 0 * scale;
        const visual = {
          x: mm[0] * x + mm[4] * y + mm[8] * z + mm[12],
          y: mm[1] * x + mm[5] * y + mm[9] * z + mm[13],
          z: mm[2] * x + mm[6] * y + mm[10] * z + mm[14],
        };
        const dets = fl.getDetectableObjects({ maxCount: 1000 });
        const me = dets.find((d) => d.skipLabel) // tracked entry is skipLabel:true
          || dets.find((d) => d.id === (ti && ti.callsign))
          || dets.find((d) => d.id === icao);
        if (!me || !me.position) return null;
        const dx = visual.x - me.position.x;
        const dy = visual.y - me.position.y;
        const dz = visual.z - me.position.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      }, trackedIcao);
    }

    // Tolerance: the model and detectable both read _cachedDRPosition, so the
    // delta should be ~0. A regression (model recomputing dead-reckon on a later
    // frameNumber) produced a visible front-back jitter = tens to hundreds of m.
    // Allow 5 m for float noise / partial-frame sampling.
    const JITTER_TOL_M = 5;
    const samples = jitterResult.values.filter((v) => v != null);
    if (samples.length < 5) {
      skip('jitter: model visual centre === detectable pos', `only ${samples.length} usable samples (positions unavailable)`);
    } else {
      const maxDelta = Math.max(...samples);
      record('jitter: max|visual centre − detectable| ≈ 0 over frames', maxDelta <= JITTER_TOL_M,
        `max=${maxDelta.toFixed(3)} m over ${samples.length} frames (tol ${JITTER_TOL_M} m, mode=${modelUp ? 'model-matrix' : 'display-contract'})`);
    }

    // ============================================================
    // INVARIANT 2: NO PULL-OUT on a track switch
    //   tracking B while tracking A must not fly to ~80 km overview.
    // ============================================================
    console.log('\nInvariant 2 — no pull-out on track switch');
    // We're currently tracking SYN001. Record camera height, then switch to
    // SYN002 and watch the camera height across frames. A pull-out = the
    // deselect flyTo to an ~80 km overview; it should be skipped on a switch.
    const planeA = SYNTH.flights[0].icao;
    const planeB = SYNTH.flights[1].icao;

    // Ensure we are tracking A and have a settled (low) follow height first.
    await evalPage((icao) => {
      window.__godsEyeView.dataManager.layers.get('flights').module.trackById(icao);
    }, planeA);
    await sleep(1500);

    const heightBefore = await evalPage(() => window.__godsEyeView.viewer.camera.positionCartographic.height);

    // Switch to B and immediately start sampling camera height every frame.
    const switchSamples = await page.evaluate(async (icao, frames) => {
      const v = window.__godsEyeView.viewer;
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      const heights = [];
      const onTick = () => { heights.push(v.camera.positionCartographic.height); };
      const remove = v.scene.postRender.addEventListener(onTick);
      fl.trackById(icao); // the SWITCH — must NOT trigger the deselect pull-out flyTo
      await new Promise((res) => {
        let n = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stop();
          res();
        };
        const stop = v.scene.postRender.addEventListener(() => {
          if (++n >= frames) {
            finish();
            return;
          }
          v.scene.requestRender();
        });
        const timer = setTimeout(finish, Math.max(15000, frames * 1500));
        v.scene.requestRender();
      });
      remove();
      return heights;
    }, planeB, 45);

    const maxHeight = Math.max(heightBefore, ...switchSamples);
    // The follow camera for these planes sits a few km up (altitude*1.1+2500,
    // clamped 3-30 km). The "pull-out" bug flew to ~80 km. Fail if the camera
    // ever climbs past 50 km — comfortably above the legit follow band, well
    // below the 80 km overview.
    const PULLOUT_CEIL_M = 50000;
    record('pull-out: camera stays in follow band on switch (no ~80 km spike)',
      maxHeight < PULLOUT_CEIL_M,
      `maxHeight=${(maxHeight / 1000).toFixed(1)} km (before=${(heightBefore / 1000).toFixed(1)} km, ceil ${PULLOUT_CEIL_M / 1000} km)`);

    // Confirm the switch actually took effect (we are now tracking B).
    const nowTrackingB = await evalPage((icao) => {
      const ti = window.__godsEyeView.dataManager.layers.get('flights').module.getTrackedInfo();
      return !!(ti && ti.icao24 === icao);
    }, planeB);
    record('pull-out: track switch actually landed on plane B', nowTrackingB,
      nowTrackingB ? 'tracking B' : 'switch did not land');

    // ============================================================
    // INVARIANT 3: NO CROSS-LAYER ORPHAN
    //   track military, then commercial → military.getTrackedInfo()===null,
    //   and the reverse.
    // ============================================================
    console.log('\nInvariant 3 — no cross-layer orphan');
    const milHex = SYNTH.military[0].hex;
    const comIcao = SYNTH.flights[2].icao;

    // (a) military first, then commercial → military must clear.
    const cross1 = await evalPage(async (hex, icao) => {
      const dm = window.__godsEyeView.dataManager;
      const mil = dm.layers.get('military').module;
      const fl = dm.layers.get('flights').module;
      mil.trackById(hex);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const milTrackedBefore = !!mil.getTrackedInfo();
      fl.trackById(icao); // tracking commercial flips viewer.trackedEntity → military listener fires
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        milTrackedBefore,
        milTrackedAfter: !!mil.getTrackedInfo(),
        flTrackedAfter: !!fl.getTrackedInfo(),
      };
    }, milHex, comIcao);
    record('orphan: military clears when commercial is tracked',
      cross1.milTrackedBefore && cross1.milTrackedAfter === false && cross1.flTrackedAfter === true,
      `mil before=${cross1.milTrackedBefore} mil after=${cross1.milTrackedAfter} fl after=${cross1.flTrackedAfter}`);

    // (b) commercial first, then military → commercial must clear.
    const cross2 = await evalPage(async (hex, icao) => {
      const dm = window.__godsEyeView.dataManager;
      const mil = dm.layers.get('military').module;
      const fl = dm.layers.get('flights').module;
      fl.trackById(icao);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const flTrackedBefore = !!fl.getTrackedInfo();
      mil.trackById(hex);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        flTrackedBefore,
        flTrackedAfter: !!fl.getTrackedInfo(),
        milTrackedAfter: !!mil.getTrackedInfo(),
      };
    }, milHex, comIcao);
    record('orphan: commercial clears when military is tracked',
      cross2.flTrackedBefore && cross2.flTrackedAfter === false && cross2.milTrackedAfter === true,
      `fl before=${cross2.flTrackedBefore} fl after=${cross2.flTrackedAfter} mil after=${cross2.milTrackedAfter}`);

    // No console errors should have accumulated during the tracking exercises.
    record('no console errors during tracking exercises', consoleErrors.length === 0,
      consoleErrors.length ? `${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')}` : 'clean');

    // ============================================================
    // REGRESSION H1 (pre-ship audit 2026-07-01): clicking the very plane
    // you're tracking (3D on) must be a NO-OP — no deselect, no 80 km
    // pull-out. The tracked standalone model previously carried NO pick id,
    // so scene.pick read the click as empty space → the deselect flyTo.
    // ============================================================
    console.log('\nRegression H1 — click on the tracked plane is a no-op');
    const h1Icao = SYNTH.flights[0].icao;
    await evalPage((icao) => {
      window.__godsEyeView.dataManager.layers.get('flights').module.trackById(icao);
    }, h1Icao);
    await sleep(1500); // follow camera settles; tracked GLB load kicks off

    // (i) The tracked standalone model must expose its pick id (= the icao).
    const h1ModelUp = await page.waitForFunction((icao) => {
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      const ti = fl.getTrackedInfo();
      if (!ti || ti.icao24 !== icao) return false;
      const found = window.__findTrackedModel ? window.__findTrackedModel() : null;
      return !!(found && found.ready && found.show && String(found.id) === icao);
    }, { timeout: 60000, polling: 250 }, h1Icao).then(() => true).catch(() => false);

    if (h1ModelUp) {
      const modelPickId = await evalPage(() => {
        const m = window.__findTrackedModel();
        return m && m.id !== undefined && m.id !== null ? String(m.id) : null;
      });
      record('H1: tracked standalone model exposes its pick id', modelPickId === h1Icao,
        `model.id=${JSON.stringify(modelPickId)} (want "${h1Icao}")`);
    } else if (!glbBackendCapable) {
      skip('H1: tracked standalone model exposes its pick id',
        `independent GLB control unavailable (${glbControlDetail})`);
    } else {
      record('H1: tracked standalone model exposes its pick id', false,
        'independent GLB control rendered, but the product tracked model did not');
    }

    // (ii) Synthetic click at the tracked plane's screen position. Search a
    // small grid around the projected display position for a point where
    // scene.pick actually returns the tracked plane (its model's icao pick id
    // or the tracked entity) so the click is deterministic — a miss would be
    // a LEGIT empty-space deselect, not the H1 signature.
    const h1ClickPoint = await evalPage(() => {
      const v = window.__godsEyeView.viewer;
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      const ti = fl.getTrackedInfo();
      if (!ti) return null;
      const ent = v.trackedEntity;
      const disp = ent && typeof ent.gevDisplayPosition === 'function' ? ent.gevDisplayPosition() : null;
      const pos = disp || ti.position;
      if (!pos) return null;
      const center = v.scene.cartesianToCanvasCoordinates(pos);
      if (!center) return null;
      const isTrackedPick = (picked) => {
        if (!picked) return null;
        if (picked.id === ent) return 'entity';
        const raw = typeof picked.id === 'string' ? picked.id : (picked.primitive && picked.primitive.id);
        return raw === ti.icao24 ? 'icao-pick' : null;
      };
      const offsets = [[0, 0]];
      for (const r of [3, 6, 10, 16, 24]) {
        for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          offsets.push([dx, dy]);
        }
      }
      for (const [dx, dy] of offsets) {
        const pt = { x: center.x + dx, y: center.y + dy };
        let picked = null;
        try { picked = v.scene.pick(pt); } catch { picked = null; }
        const via = isTrackedPick(picked);
        if (via) return { x: pt.x, y: pt.y, via };
      }
      return { x: center.x, y: center.y, via: null };
    });

    if (!h1ClickPoint || !h1ClickPoint.via) {
      skip('H1: click on tracked plane keeps tracking (no deselect)',
        'scene.pick could not resolve the tracked plane at its screen position (GL backend picking)');
      skip('H1: click on tracked plane does not pull the camera out',
        'scene.pick could not resolve the tracked plane at its screen position (GL backend picking)');
    } else {
      const h1HeightBefore = await evalPage(() => window.__godsEyeView.viewer.camera.positionCartographic.height);
      // Trusted mouse click through the browser event pipeline → the layer's
      // ScreenSpaceEventHandler LEFT_CLICK path (the exact H1 code path).
      await page.mouse.click(h1ClickPoint.x, h1ClickPoint.y);
      const h1Heights = await page.evaluate(async (frames) => {
        const v = window.__godsEyeView.viewer;
        const heights = [];
        await new Promise((res) => {
          let n = 0;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stop();
            res();
          };
          const stop = v.scene.postRender.addEventListener(() => {
            heights.push(v.camera.positionCartographic.height);
            if (++n >= frames) {
              finish();
              return;
            }
            v.scene.requestRender();
          });
          const timer = setTimeout(finish, Math.max(15000, frames * 1500));
          v.scene.requestRender();
        });
        return heights;
      }, 45);
      const h1StillTracking = await evalPage((icao) => {
        const ti = window.__godsEyeView.dataManager.layers.get('flights').module.getTrackedInfo();
        return !!(ti && ti.icao24 === icao) && !!window.__godsEyeView.viewer.trackedEntity;
      }, h1Icao);
      record('H1: click on tracked plane keeps tracking (no deselect)', h1StillTracking,
        `picked via ${h1ClickPoint.via}; still tracking=${h1StillTracking}`);
      const h1MaxHeight = Math.max(h1HeightBefore, ...h1Heights);
      record('H1: click on tracked plane does not pull the camera out', h1MaxHeight < PULLOUT_CEIL_M,
        `maxHeight=${(h1MaxHeight / 1000).toFixed(1)} km (before=${(h1HeightBefore / 1000).toFixed(1)} km, ceil ${PULLOUT_CEIL_M / 1000} km)`);
    }

    // ============================================================
    // REGRESSION M3 (rewritten 2026-07-02 — deliberate behavior change):
    // when the TRACKED plane ages out (3 missed polls), tracking must clear
    // and the camera must be RELEASED IN PLACE — viewer.trackedEntity
    // undefined and NO jump (the old contract flew an ~80 km overview; the
    // owner field-ruled that wrong: "it randomly zooms way up and loses my
    // context"). The M3 ordering fix stays: tracking is cleared BEFORE the
    // removal loop deletes the plane's state, so we never sit mid-follow
    // with stale tracking state.
    // ============================================================
    console.log('\nRegression M3 — tracked plane age-out releases the camera in place');
    const m3Icao = SYNTH.flights[0].icao;
    await evalPage((icao) => {
      window.__godsEyeView.dataManager.layers.get('flights').module.trackById(icao);
    }, m3Icao);
    await sleep(1200); // settle in the low follow band

    const m3 = await evalPage(async (icao) => {
      const v = window.__godsEyeView.viewer;
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      const beforeTracking = !!fl.getTrackedInfo();
      // Simulate the age-out via the shim: the plane stops arriving.
      window.__SYNTH.flights = window.__SYNTH.flights.filter((f) => f.icao !== icao);
      // MISSING_POLL_LIMIT = 3 consecutive absent polls → removal + clear.
      // Capture the camera pose right BEFORE the removing poll — the follow
      // camera drifts with the coasting plane until the instant of release,
      // so this is the "where the user was looking" reference.
      await fl.update(v);
      await fl.update(v);
      const c0 = v.camera.positionCartographic;
      const atAgeOut = {
        lonDeg: (c0.longitude * 180) / Math.PI,
        latDeg: (c0.latitude * 180) / Math.PI,
        height: c0.height,
      };
      await fl.update(v); // third miss → removal + clear + in-place release
      return {
        beforeTracking,
        atAgeOut,
        stillTrackedAfter: !!fl.getTrackedInfo(),
        viewerStillTracking: !!v.trackedEntity,
      };
    }, m3Icao);

    record('M3: tracking cleared after the tracked plane ages out (getTrackedInfo null)',
      m3.beforeTracking && !m3.stillTrackedAfter,
      `before=${m3.beforeTracking} trackedAfter=${m3.stillTrackedAfter}`);
    record('M3: camera released after age-out (viewer.trackedEntity undefined)',
      !m3.viewerStillTracking,
      `viewerTracked=${m3.viewerStillTracking}`);

    // The camera must NOT move after the release: no overview flyTo, no
    // snap — it stays where the follow left it. Sample heights across frames
    // (any transient flyTo would show up here), then read the settled pose.
    const m3Heights = await page.evaluate(async (frames) => {
      const v = window.__godsEyeView.viewer;
      const heights = [];
      await new Promise((res) => {
        let n = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stop();
          res();
        };
        const stop = v.scene.postRender.addEventListener(() => {
          heights.push(v.camera.positionCartographic.height);
          if (++n >= frames) {
            finish();
            return;
          }
          v.scene.requestRender();
        });
        const timer = setTimeout(finish, Math.max(15000, frames * 1500));
        v.scene.requestRender();
      });
      return heights;
    }, 90);
    await sleep(800); // any (regressed) 0.6 s flyTo would have finished by now
    const m3Final = await evalPage(() => {
      const c = window.__godsEyeView.viewer.camera.positionCartographic;
      return {
        lonDeg: (c.longitude * 180) / Math.PI,
        latDeg: (c.latitude * 180) / Math.PI,
        height: c.height,
      };
    });
    // Tolerances: the release must hold the camera within ~2 km of where it
    // was at age-out time (the follow band sits a few km up; the old overview
    // flyTo climbed +80 km, orders of magnitude outside this budget).
    const M3_STAY_TOL_M = 2000;
    const m3AltDeltaM = Math.max(
      Math.abs(m3Final.height - m3.atAgeOut.height),
      ...m3Heights.map((h) => Math.abs(h - m3.atAgeOut.height)),
    );
    const m3HorizDeltaM = haversineMeters(
      m3.atAgeOut.latDeg, m3.atAgeOut.lonDeg, m3Final.latDeg, m3Final.lonDeg,
    );
    record('M3: camera stayed in place after age-out — altitude Δ < 2 km',
      m3AltDeltaM < M3_STAY_TOL_M,
      `Δalt=${(m3AltDeltaM / 1000).toFixed(2)} km (tol ${M3_STAY_TOL_M / 1000} km; ageOut=${(m3.atAgeOut.height / 1000).toFixed(1)} km, final=${(m3Final.height / 1000).toFixed(1)} km)`);
    record('M3: camera stayed in place after age-out — horizontal Δ < 2 km',
      m3HorizDeltaM < M3_STAY_TOL_M,
      `Δhoriz=${(m3HorizDeltaM / 1000).toFixed(2)} km (tol ${M3_STAY_TOL_M / 1000} km)`);

    // ============================================================
    // CHANGE 2a (2026-07-02): landing-ghost fast cull. A plane whose last
    // fix is LOW + SLOW (landed — the feed's ground flag lags the actual
    // landing) is removed after ONE missed poll, not the 3-poll grace; a
    // cruise plane that misses a poll keeps the full grace (it absorbs real
    // feed gaps — owner-confirmed important). Both layers.
    // ============================================================
    console.log('\nChange 2a — landing-ghost fast cull (1 missed poll; cruise grace intact)');
    const fastCull = await evalPage(async () => {
      const v = window.__godsEyeView.viewer;
      const dm = window.__godsEyeView.dataManager;
      const fl = dm.layers.get('flights').module;
      const mil = dm.layers.get('military').module;
      const has = (mod, id) => mod.getAllPositions(2000).some((p) => p.id === id);

      // Landed commercial plane: 120 m baro, 18 m/s (~35 kt) — under both
      // fast-cull gates (LANDED_ALT_MAX_M=150 m, LANDED_SPEED_MAX_MPS=23).
      window.__SYNTH.flights.push({ icao: 'aaa044', callsign: 'SYN044', lon: -97.7420, lat: 30.2660, alt: 120, vel: 18, track: 180 });
      // Landed military plane: 300 ft (~91 m) baro, 20 kt (~10 m/s).
      window.__SYNTH.military.push({ hex: 'bbb103', flight: 'MIL103', lon: -97.7480, lat: 30.2680, altFt: 300, track: 90, gsKt: 20, t: 'C130', r: 'AF-103' });
      await fl.update(v);
      await mil.update(v);
      const ingested = { fl: has(fl, 'aaa044'), mil: has(mil, 'bbb103') };

      // Both landed planes AND the cruise control (aaa002: 9500 m, 210 m/s)
      // vanish from the feed in the SAME poll.
      const cruise = window.__SYNTH.flights.find((f) => f.icao === 'aaa002');
      window.__SYNTH.flights = window.__SYNTH.flights.filter((f) => f.icao !== 'aaa044' && f.icao !== 'aaa002');
      window.__SYNTH.military = window.__SYNTH.military.filter((m) => m.hex !== 'bbb103');
      await fl.update(v);  // missed poll #1
      await mil.update(v); // missed poll #1
      const afterOneMiss = {
        landedGone: !has(fl, 'aaa044'),
        milLandedGone: !has(mil, 'bbb103'),
        cruiseStillThere: has(fl, 'aaa002'),
      };
      // Put the cruise plane back so any later polls aren't disturbed.
      if (cruise) window.__SYNTH.flights.push(cruise);
      await fl.update(v);
      return { ingested, afterOneMiss };
    });
    record('fast-cull: landed low+slow synthetics ingested (both layers)',
      fastCull.ingested.fl && fastCull.ingested.mil,
      `flights=${fastCull.ingested.fl} military=${fastCull.ingested.mil}`);
    record('fast-cull: landed plane removed after ONE missed poll (flights)',
      fastCull.afterOneMiss.landedGone,
      `gone=${fastCull.afterOneMiss.landedGone} (grace skipped, was 3 polls)`);
    record('fast-cull: landed plane removed after ONE missed poll (military)',
      fastCull.afterOneMiss.milLandedGone,
      `gone=${fastCull.afterOneMiss.milLandedGone} (grace skipped, was 3 polls)`);
    record('fast-cull: cruise plane keeps the 3-poll grace (present after 1 miss)',
      fastCull.afterOneMiss.cruiseStillThere,
      `present=${fastCull.afterOneMiss.cruiseStillThere}`);

    // ============================================================
    // CHANGE 2b (2026-07-02): honest readout. While the TRACKED plane is in
    // its missed-poll grace (rendered but absent from the latest poll), the
    // tracked label/readout must carry the "· STALE" cue — and drop it the
    // moment the plane reappears in the feed.
    // ============================================================
    console.log('\nChange 2b — tracked readout STALE cue during missed-poll grace');
    const staleCheck = await evalPage(async () => {
      const v = window.__godsEyeView.viewer;
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      const labelText = () => {
        const ent = v.trackedEntity;
        if (!ent) return null;
        // Post overlay-unification the tracked text lives in the host
        // presentation model (entities are asserted native-label-free);
        // the native read stays as a fallback so this probe still fails
        // loudly if BOTH surfaces are ever absent.
        const model = ent.gevLabelModel;
        if (model) return [model.title, ...(model.details || [])].filter(Boolean).join('\n');
        if (!ent.label || !ent.label.text) return null;
        const t = ent.label.text;
        return typeof t === 'string' ? t : (t.getValue ? String(t.getValue(v.clock.currentTime)) : null);
      };
      // Track a cruise plane that IS in the feed (aaa003: 8700 m, 250 m/s —
      // normal grace, so one missed poll leaves it rendered-but-stale).
      fl.trackById('aaa003');
      await fl.update(v); // plane present → fresh label
      const freshLabel = labelText();
      const syn3 = window.__SYNTH.flights.find((f) => f.icao === 'aaa003');
      window.__SYNTH.flights = window.__SYNTH.flights.filter((f) => f.icao !== 'aaa003');
      await fl.update(v); // missed poll #1 → grace → label refreshed with cue
      const staleLabel = labelText();
      if (syn3) window.__SYNTH.flights.push(syn3);
      await fl.update(v); // plane back → label rebuilt without the cue
      const recoveredLabel = labelText();
      fl.stopTracking(); // leave nothing tracked
      return { freshLabel, staleLabel, recoveredLabel };
    });
    record('stale-readout: tracked label carries STALE cue during grace',
      !!staleCheck.staleLabel && staleCheck.staleLabel.includes('STALE')
        && !!staleCheck.freshLabel && !staleCheck.freshLabel.includes('STALE'),
      `fresh="${staleCheck.freshLabel && staleCheck.freshLabel.split('\n')[0]}" stale="${staleCheck.staleLabel && staleCheck.staleLabel.split('\n')[0]}"`);
    record('stale-readout: STALE cue clears when the plane reappears',
      !!staleCheck.recoveredLabel && !staleCheck.recoveredLabel.includes('STALE'),
      `recovered="${staleCheck.recoveredLabel && staleCheck.recoveredLabel.split('\n')[0]}"`);

    // ============================================================
    // CHANGE 3 (2026-07-03): ground traffic is a FEATURE. Present-but-
    // grounded planes render FULL-STRENGTH in the airborne tint pipeline
    // (white / amber-military — validated behavior, same-day reversal of the
    // day-1 gray 50%-alpha muted style: "just leave them as white … in NYC
    // I can barely see them") at ×0.8 scale; "on the ground" reads from
    // scale + no trail, never from a fade, so the 45%-alpha stale fade
    // stays unambiguous. The on_ground flip restyles the SAME billboard in
    // place (landing/takeoff transition, never a removal); a grounded plane
    // that then VANISHES from the feed still fast-culls after ONE missed
    // poll. Military mirror keys off adsb.lol's alt_baro === "ground".
    // ============================================================
    console.log('\nChange 3 — ground traffic: full-alpha style, in-place transitions, fast cull');
    const ground = await evalPage(async () => {
      const v = window.__godsEyeView.viewer;
      const dm = window.__godsEyeView.dataManager;
      const fl = dm.layers.get('flights').module;
      const mil = dm.layers.get('military').module;
      const findBB = (id) => {
        let found = null;
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            let p;
            try { p = coll.get(i); } catch { continue; }
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.image !== undefined && p.alignedAxis !== undefined && p.id === id) found = p;
          }
        };
        walk(v.scene.primitives);
        return found;
      };
      const snap = (id) => {
        const bb = findBB(id);
        if (!bb) return null;
        const c = bb.color;
        return {
          show: bb.show, scale: bb.scale, alpha: c.alpha, red: c.red, green: c.green, blue: c.blue,
          // Infinity doesn't survive puppeteer's JSON transport — encode it.
          ddtd: bb.disableDepthTestDistance === Number.POSITIVE_INFINITY ? 'inf' : bb.disableDepthTestDistance,
        };
      };

      // 1. On-ground planes ingest + render full-strength (both layers).
      window.__SYNTH.flights.push({ icao: 'aaa066', callsign: 'GND066', lon: -97.7425, lat: 30.2665, alt: 150, vel: 7, track: 45, onGround: true });
      window.__SYNTH.military.push({ hex: 'bbb166', flight: 'MILGND1', lon: -97.7490, lat: 30.2690, altFt: 'ground', track: 120, gsKt: 12, t: 'C130', r: 'AF-166' });
      await fl.update(v);
      await mil.update(v);
      const groundSnap = snap('aaa066');
      const milGroundSnap = snap('bbb166');
      const detectable = fl.getDetectableObjects({ maxCount: 1000 }).some((d) => d.id === 'GND066');

      // 2. Takeoff: the flag flips false — same billboard, airborne style.
      const gnd = window.__SYNTH.flights.find((f) => f.icao === 'aaa066');
      gnd.onGround = false; gnd.alt = 900; gnd.vel = 75;
      await fl.update(v);
      const airSnap = snap('aaa066');

      // 3. Landing: the flag flips back true — ground scale again, still in place.
      gnd.onGround = true; gnd.alt = 150; gnd.vel = 9;
      await fl.update(v);
      const groundAgainSnap = snap('aaa066');

      // 4. Feed-dropped grounded planes (re-pinned round 7, owner field data
      //    "parked planes churn/never heal"): the fast cull now requires
      //    AIRBORNE history this session. aaa066 flew (step 2) then landed
      //    then dropped → the landing-ghost fast-cull still fires after ONE
      //    missed poll. bbb166 was BORN grounded (parked class) → it rides
      //    the normal MISSING_POLL_LIMIT grace and must SURVIVE the first
      //    missed poll, keeping its identity/floor state across feed flaps.
      window.__SYNTH.flights = window.__SYNTH.flights.filter((f) => f.icao !== 'aaa066');
      window.__SYNTH.military = window.__SYNTH.military.filter((m) => m.hex !== 'bbb166');
      await fl.update(v);
      await mil.update(v);
      return {
        groundSnap, milGroundSnap, detectable, airSnap, groundAgainSnap,
        droppedGone: !snap('aaa066'),
        milDroppedGone: !snap('bbb166'),
      };
    });
    const fmtSnap = (s) => (s ? `show=${s.show} scale=${s.scale.toFixed(3)} rgba=(${s.red.toFixed(2)},${s.green.toFixed(2)},${s.blue.toFixed(2)},${s.alpha.toFixed(2)})` : 'missing');
    // Ground style (validated behavior 2026-07-03): FULL-ALPHA airborne tint —
    // white in the flights layer, amber (#FFB800) in the military layer —
    // never the 45%-alpha stale fade, never the retired gray mute. The
    // ground cue is the ×0.8 scale (klass default ⇒ base 1.0).
    const isFullWhite = (s) => !!s && s.show && s.alpha === 1 && s.red === 1 && s.green === 1 && s.blue === 1;
    const isFullAmber = (s) => !!s && s.show && s.alpha === 1 && s.red === 1 && s.blue === 0 && Math.abs(s.green - 0xB8 / 255) < 0.02;
    record('ground: on-ground plane renders full-alpha white at ground scale + detectable (flights)',
      isFullWhite(ground.groundSnap) && Math.abs(ground.groundSnap.scale - 0.8) < 1e-6 && ground.detectable,
      `${fmtSnap(ground.groundSnap)} detectable=${ground.detectable}`);
    record('ground: military mirror — alt_baro "ground" renders full-alpha amber',
      isFullAmber(ground.milGroundSnap),
      fmtSnap(ground.milGroundSnap));
    record('ground: takeoff flip restyles in place (white, full alpha, full scale)',
      isFullWhite(ground.airSnap) && Math.abs(ground.airSnap.scale - 1) < 1e-6,
      fmtSnap(ground.airSnap));
    record('ground: landing flip returns to ground scale in place (no removal, still full alpha)',
      isFullWhite(ground.groundAgainSnap) && Math.abs(ground.groundAgainSnap.scale - 0.8) < 1e-6,
      fmtSnap(ground.groundAgainSnap));
    record('ground: landing ghost fast-culls after ONE missed poll; born-parked contact survives the flap (round 7)',
      ground.droppedGone && !ground.milDroppedGone,
      `flights(landed ghost) gone=${ground.droppedGone} military(born parked) gone=${ground.milDroppedGone} (want true/false)`);
    // Fix 2 (2026-07-03 field test): ground planes VANISHED when zooming into
    // airports — grounded altitudes sit at/below the photoreal tile skin, so the
    // depth test buried the billboard up close (log-depth imprecision let it win
    // from orbit). RE-PINNED for round 5 (product invariant 2026-07-06: "I just
    // want the planes and their lines to ALWAYS be visible... evenly
    // applied"): EVERY billboard — grounded, airborne, before and after a
    // ground flip — renders with disableDepthTestDistance = +Infinity. The
    // old grounded-only rule kept leaving classes of contacts buried (Austin
    // QNH-below-field traffic not yet flagged on_ground). Far-side contacts
    // are removed by the fleet tick's horizon occluder, which never depended
    // on the depth test. A real-machine eyeball should confirm: zooming from
    // orbit to street level, NO aircraft icon ever vanishes into the mesh.
    record('ground: depth test disabled for EVERY contact (always visible), incl. across ground flips',
      ground.groundSnap?.ddtd === 'inf' && ground.milGroundSnap?.ddtd === 'inf'
        && ground.airSnap?.ddtd === 'inf' && ground.groundAgainSnap?.ddtd === 'inf',
      `flights=${ground.groundSnap?.ddtd} mil=${ground.milGroundSnap?.ddtd} takeoff=${ground.airSnap?.ddtd} landing=${ground.groundAgainSnap?.ddtd}`);

    // ============================================================
    // GROUND 3D (2026-07-03, product rule LOCKED): "when I have 3D mode —
    // proximity or all — I want that respected regardless of whether a plane
    // is on the ground or in the air. No distinction."
    //  (a) a synthetic on_ground plane is model-ELIGIBLE (not skipped),
    //  (b) it gets a model under the existing cap (both layers),
    //  (c) the model matrix height = stubbed scene.sampleHeight + the layer's
    //      belly offset — the one-shot cached ground snap — NOT the buried/
    //      floating feed altitude (flights alt 150 m / military "ground" → 0 m),
    //  (d) the TRACKED grounded plane gets the standalone tracked model,
    //  (e) the snap is ONE-SHOT cached: sample count stays flat across frames.
    // Height probe: |modelMatrix translation| − |billboard position| — at one
    // lat/lon a geodetic height change moves the point along the ellipsoid
    // normal, whose angle to the radial at Austin's latitude costs < 0.001%.
    //
    // RETARGETED 2026-08-03 (weld). (c) still pins exactly what it always did —
    // the MODEL rides the sampled skin while the BILLBOARD stays at the reported
    // altitude — and that split is by design and unchanged. What changed is the
    // CONSUMER anchor: detection brackets/labels and the tracked card used to
    // follow the billboard, so on a grounded plane they sat ~100 m below the
    // aircraft you can see and rose only as the coarse ground-floor cell warmed
    // ("the buoy"), sometimes never converging. They now follow whatever owns the
    // visual. So do NOT read the non-zero Δ below as "the anchor is the
    // billboard" — it is the model-vs-billboard split, and the weld group that
    // follows pins the anchor itself.
    // ============================================================
    console.log('\nGround 3D — grounded planes are model-eligible + snapped to the sampled skin');
    const GROUND3D_STUB_H = 187.5; // stubbed tile-skin height (m, ellipsoid)
    // Expected belly offsets (m): native origin-above-lowest-vertex × MODEL_SCALE
    // × CLASS_SCALE_3D[klass] — constants match the layers' MODEL_BELLY_OFFSET_NATIVE
    // / MODEL_SCALE pairs, which modelScale.test.mjs locks against the GLBs.
    // Class is computed with the REAL classifier on the synthetic feed fields.
    const g3dFlKlass = classifyAircraft({ typeCode: null, category: null });
    const g3dMilKlass = classifyAircraft({ typeCode: 'C130', category: undefined });
    const g3dFlOffset = 6.719 * 1 * (CLASS_SCALE_3D[g3dFlKlass] || 1); // airplane.glb, flights
    // Hangar fleet (2026-08-16): military C130 → turboprop → the real atr72.glb,
    // whose belly offset is the registry's measured bellyM (meters, scale 1) —
    // NOT the jet.glb 5.631 × class formula. Pinned by modelScale.test.mjs.
    const g3dMilOffset = CLASS_MODEL_REAL[g3dMilKlass]?.bellyM
      ?? 5.631 * 1 * (CLASS_SCALE_3D[g3dMilKlass] || 1); // jet.glb fallback classes
    // Height-datum fix (Task 6): the flights-layer billboard for a grounded synthetic
    // (no geo_altitude in this stub feed, no warm terrain-height cache in a headless
    // run) now renders at baroM + geoidHeight(lat, lon) rather than the raw baro
    // value verbatim — pickRenderAltitudeM's documented visual-fallback branch.
    // Height-datum fix (Task 7): militaryFlights.js now runs the pickRenderAltitudeM
    // chain too, but DELIBERATELY passes surfaceM=null for the on-ground billboard
    // (brief item 3, "don't double-correct"): a grounded plane's MODEL already rides
    // groundSnap.js's one-shot tileset sample, and its billboard is depth-test-free,
    // so re-correcting the billboard to the ellipsoidal surface would (a) double-
    // correct the same grounded plane and (b) — because military ground rows carry
    // NO baro ("alt_baro":"ground") — jump the billboard 0 -> ~surface between polls,
    // dragging the model's ground-snap input past groundSnap's 50 m move threshold
    // and forcing a re-sample (breaks the ONE-SHOT invariant asserted below).
    // So bbb177 (on-ground, no alt_geom in the stub feed, no numeric alt_baro,
    // surfaceM forced null) makes pickRenderAltitudeM return its null sentinel and
    // the military layer falls through to its SAME pre-Task-7 default (`altitudeM` —
    // 0 m for an on-ground record with no sticky prior). Expected value unchanged
    // (0 m), but now the documented Task-7 code path rather than "untouched by Task 7".
    await ensureGeoidReady();
    const g3dFlGeoidN = geoidHeight(30.2668, -97.7445); // aaa077's lat/lon (Austin)

    const g3dSetup = await evalPage(() => {
      const gev = window.__godsEyeView;
      const scene = gev.viewer.scene;
      const dm = gev.dataManager;
      // 3D models on (QA param) — the product rule under test.
      dm.layers.get('flights').module.setParams({ models3d: true });
      dm.layers.get('military').module.setParams({ models3d: true });
      // Force the ground snap's tiles-ready gate open (b9b pattern): headless the
      // Google tileset never finishes streaming, so tilesLoaded stays false.
      let tilesForced = false;
      try {
        if (gev.tileset) {
          Object.defineProperty(gev.tileset, 'tilesLoaded', { value: true, configurable: true });
          tilesForced = gev.tileset.tilesLoaded === true;
        } else {
          tilesForced = true; // no tileset → groundSnap treats tiles as ready
        }
      } catch { tilesForced = false; }
      // Deterministic sampleHeight stub + call counter (headless has no real skin).
      window.__g3dSampleCalls = 0;
      scene.sampleHeight = function () {
        window.__g3dSampleCalls += 1;
        return 187.5;
      };
      return { tilesForced };
    });
    record('ground-3d: sampleHeight stub installed + tiles-ready forced', g3dSetup.tilesForced,
      JSON.stringify(g3dSetup));

    // Ingest one grounded plane per layer, then park the camera 8 km above them
    // (inside the model regime + add radius; on-screen so they win cap slots).
    const g3dIngest = await evalPage(async () => {
      const v = window.__godsEyeView.viewer;
      const dm = window.__godsEyeView.dataManager;
      const fl = dm.layers.get('flights').module;
      const mil = dm.layers.get('military').module;
      window.__SYNTH.flights.push({ icao: 'aaa077', callsign: 'GND077', lon: -97.7445, lat: 30.2668, alt: 150, vel: 0, track: 45, onGround: true });
      window.__SYNTH.military.push({ hex: 'bbb177', flight: 'MILGND7', lon: -97.7470, lat: 30.2685, altFt: 'ground', track: 120, gsKt: 0, t: 'C130', r: 'AF-177' });
      await fl.update(v);
      await mil.update(v);
      const findBB = (id) => {
        let found = null;
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            let p;
            try { p = coll.get(i); } catch { continue; }
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.image !== undefined && p.alignedAxis !== undefined && p.id === id) found = p;
          }
        };
        walk(v.scene.primitives);
        return found;
      };
      const flBB = findBB('aaa077');
      const milBB = findBB('bbb177');
      if (!flBB || !milBB) return { error: `ground billboards missing (fl=${!!flBB} mil=${!!milBB})` };
      const radius = (pos) => Math.hypot(pos.x, pos.y, pos.z);
      // Park the camera 8 km radially above the flights plane (both in view nadir-ish).
      const p = flBB.position;
      const r = Math.hypot(p.x, p.y, p.z);
      const k = (r + 8000) / r;
      v.camera.cancelFlight();
      v.camera.setView({
        destination: { x: p.x * k, y: p.y * k, z: p.z * k },
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      return { flBBRadius: radius(flBB.position), milBBRadius: radius(milBB.position) };
    });
    if (g3dIngest.error) {
      record('ground-3d: grounded synthetics ingested', false, g3dIngest.error);
    } else {
      record('ground-3d: grounded synthetics ingested', true,
        `bb radii fl=${g3dIngest.flBBRadius.toFixed(1)} mil=${g3dIngest.milBBRadius.toFixed(1)}`);

      // In-page model finder by pick id (fleet AND tracked standalone models carry it).
      await evalPage(() => {
        window.__g3dFindModel = function (id) {
          const v = window.__godsEyeView.viewer;
          let found = null;
          const walk = (coll) => {
            const n = coll.length;
            for (let i = 0; i < n; i++) {
              let p;
              try { p = coll.get(i); } catch { continue; }
              if (!p) continue;
              if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
              if (p.modelMatrix && typeof p.ready !== 'undefined' && p.id === id) found = p;
            }
          };
          walk(v.scene.primitives);
          return found;
        };
      });

      // (a)+(b): both grounded planes become models under the cap (the old code
      // `continue`d past them in the eligibility pre-pass — no model would EVER
      // appear). Wait for ready+shown so the handoff assert below is meaningful.
      const g3dModelsUp = await page.waitForFunction(() => {
        const fm = window.__g3dFindModel('aaa077');
        const mm = window.__g3dFindModel('bbb177');
        return !!(fm && fm.ready && fm.show && mm && mm.ready && mm.show);
      }, { timeout: 40000, polling: 250 }).then(() => true).catch(() => false);
      if (!glbBackendCapable && !g3dModelsUp) {
        skip('ground-3d: grounded planes are model-eligible and modeled (both layers)',
          `independent GLB control unavailable (${glbControlDetail}); grounded GLB readiness is not observable`);
      } else {
        record('ground-3d: grounded planes are model-eligible and modeled (both layers)', g3dModelsUp,
          g3dModelsUp ? 'fleet models up (ready+shown)' : 'models never became ready+shown');
      }

      if (g3dModelsUp) {
        // (c) + handoff + (e): heights snapped, billboards handed off, snap one-shot.
        const g3dState = await evalPage(() => {
          const v = window.__godsEyeView.viewer;
          const findBB = (id) => {
            let found = null;
            const walk = (coll) => {
              const n = coll.length;
              for (let i = 0; i < n; i++) {
                let p;
                try { p = coll.get(i); } catch { continue; }
                if (!p) continue;
                if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
                if (p.image !== undefined && p.alignedAxis !== undefined && p.id === id) found = p;
              }
            };
            walk(v.scene.primitives);
            return found;
          };
          const modelRadius = (id) => {
            const m = window.__g3dFindModel(id);
            return m ? Math.hypot(m.modelMatrix[12], m.modelMatrix[13], m.modelMatrix[14]) : null;
          };
          return {
            flModelRadius: modelRadius('aaa077'),
            milModelRadius: modelRadius('bbb177'),
            flBBShown: findBB('aaa077')?.show ?? null,
            milBBShown: findBB('bbb177')?.show ?? null,
            sampleCalls: window.__g3dSampleCalls,
          };
        });
        // Expected radial delta = (stub + offset) − billboard's rendered altitude.
        // Flights billboard altitude is baroM + geoidN (height-datum fix, Task 6 —
        // no geo_altitude/warm terrain-cache in this synthetic run, so the
        // baro-fallback branch of pickRenderAltitudeM applies). Military (Task 7)
        // runs pickRenderAltitudeM too but forces surfaceM=null for on-ground
        // billboards (don't double-correct the grounded model's tileset snap — see
        // the block above), and this synthetic has no alt_geom/alt_baro, so its
        // billboard stays at the pre-Task-7 "ground" -> 0 m default.
        const flWantDelta = (GROUND3D_STUB_H + g3dFlOffset) - (150 + g3dFlGeoidN);
        const milWantDelta = (GROUND3D_STUB_H + g3dMilOffset) - 0; // "ground" (no alt_geom/alt_baro, surfaceM forced null) → 0 m default
        const flDelta = g3dState.flModelRadius - g3dIngest.flBBRadius;
        const milDelta = g3dState.milModelRadius - g3dIngest.milBBRadius;
        const HEIGHT_TOL_M = 1.0;
        record(`ground-3d: flights model height = sampled skin + belly offset (${g3dFlKlass})`,
          Math.abs(flDelta - flWantDelta) <= HEIGHT_TOL_M,
          `Δradial=${flDelta.toFixed(2)} m want=${flWantDelta.toFixed(2)} m (stub ${GROUND3D_STUB_H} + offset ${g3dFlOffset.toFixed(2)} − alt ${(150 + g3dFlGeoidN).toFixed(2)} [150 baro + ${g3dFlGeoidN.toFixed(2)} geoidN])`);
        record(`ground-3d: military model height = sampled skin + belly offset (${g3dMilKlass})`,
          Math.abs(milDelta - milWantDelta) <= HEIGHT_TOL_M,
          `Δradial=${milDelta.toFixed(2)} m want=${milWantDelta.toFixed(2)} m (stub ${GROUND3D_STUB_H} + offset ${g3dMilOffset.toFixed(2)} − alt 0)`);
        record('ground-3d: billboard→model handoff holds on the ground (icons hidden once models render)',
          g3dState.flBBShown === false && g3dState.milBBShown === false,
          `fl bb.show=${g3dState.flBBShown} mil bb.show=${g3dState.milBBShown}`);

        // ============================================================
        // WELD (2026-08-03): the detection anchor follows the RENDERED aircraft.
        // With a model owning the visual, getDetectableObjects must return the
        // model's actual rendered translation, not the billboard position — the
        // two are ~100 m apart on a grounded plane. Sampled every frame for 20
        // frames because the failure this replaces was TEMPORAL: the bracket used
        // to converge slowly (or never) as the coarse floor cell warmed, so a
        // single-frame probe could pass while the live behaviour still drifted.
        // ============================================================
        const WELD_TOL_M = 2.0;
        // This guard proves the display and visual accessors have not collapsed
        // into the same position. Do not reuse WELD_TOL_M here: the measured
        // split includes wall-clock dead reckoning and can validly be only the
        // 1.51 m airliner belly offset on a faster runtime.
        const ACCESSOR_SEPARATION_EPSILON_M = 0.25;
        const weld = await page.evaluate(async (frames) => {
          const gev = window.__godsEyeView;
          const v = gev.viewer;
          const dm = gev.dataManager;
          const targets = [
            { layer: 'flights', id: 'aaa077', center: [0, 0, 0] },
            { layer: 'military', id: 'bbb177', center: [0, 0, 0] },
          ];
          const out = {};
          for (const t of targets) out[t.layer] = { maxDelta: 0, samples: 0, missing: 0 };
          await new Promise((res) => {
            let n = 0;
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              stop();
              res();
            };
            const stop = v.scene.postRender.addEventListener(() => {
              for (const t of targets) {
                const rec = out[t.layer];
                const mod = dm.layers.get(t.layer)?.module;
                const model = window.__g3dFindModel(t.id);
                const objects = mod?.getDetectableObjects?.({
                  mode: 'DENSE', maxCount: 5000, seed: 0,
                }) || [];
                const object = objects.find((o) => o && o.sourceId === t.id);
                if (!object || !object.position || !model || !model.show) {
                  rec.missing++;
                  continue;
                }
                const matrix = model.modelMatrix;
                const scale = Number.isFinite(model.computedScale)
                  ? model.computedScale
                  : (Number.isFinite(model.scale) ? model.scale : 1);
                const x = t.center[0] * scale;
                const y = t.center[1] * scale;
                const z = t.center[2] * scale;
                const visual = {
                  x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
                  y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
                  z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
                };
                const d = Math.hypot(
                  object.position.x - visual.x,
                  object.position.y - visual.y,
                  object.position.z - visual.z,
                );
                if (d > rec.maxDelta) rec.maxDelta = d;
                rec.samples++;
              }
              if (++n >= frames) {
                finish();
                return;
              }
              v.scene.requestRender();
            });
            const timer = setTimeout(finish, Math.max(15000, frames * 1500));
            v.scene.requestRender();
          });
          return out;
        }, 20);
        for (const layer of ['flights', 'military']) {
          const w = weld[layer] || { samples: 0, missing: -1, maxDelta: Infinity };
          record(`weld: ${layer} grounded detection anchor === rendered model visual centre (20 frames)`,
            w.samples >= 15 && w.missing === 0 && w.maxDelta <= WELD_TOL_M,
            `samples=${w.samples} missing=${w.missing} maxΔ=${w.maxDelta.toFixed(3)} m (tol ${WELD_TOL_M} m)`);
        }

        // (e) one-shot: run ~1.2 s of frames — the count must not grow (a per-frame
        // sampler would add dozens). TWO bounded one-shot sources (re-pinned
        // 2 → 4 for the validated round-4 mesh-floor design, 2026-07-06):
        // groundSnap's model snap (one per grounded plane) and the mesh-floor
        // CELL probe (one per unique ~111 m cell; the two synthetic grounded
        // planes occupy distinct cells). FLATNESS across frames is the
        // load-bearing invariant — the absolute count just pins the fixtures.
        const callsBefore = g3dState.sampleCalls;
        await page.evaluate(async (frames) => {
          const v = window.__godsEyeView.viewer;
          await new Promise((res) => {
            let n = 0;
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              stop();
              res();
            };
            const stop = v.scene.postRender.addEventListener(() => {
              if (++n >= frames) {
                finish();
                return;
              }
              v.scene.requestRender();
            });
            const timer = setTimeout(finish, Math.max(15000, frames * 1500));
            v.scene.requestRender();
          });
        }, 60);
        await sleep(400);
        const callsAfter = await evalPage(() => window.__g3dSampleCalls);
        // Bounded-shape pin (round 5): with the boot-wide "no tiles" stub,
        // every synthetic contact's cell is unlatched until this group's
        // 187.5 stub lands, so the absolute count varies with how many
        // synthetics earlier groups left alive. The INVARIANT is that
        // sampling is per-poll-bounded and one-shot per cell — a per-frame
        // sampler would add ~60+ over the frame loop; a mid-window poll
        // legitimately adds a few cells for moving contacts.
        record('ground-3d: ground snap + mesh-floor probes are one-shot/per-poll bounded (no per-frame sampling)',
          callsBefore >= 4 && (callsAfter - callsBefore) <= 8,
          `sampleHeight calls: after models up=${callsBefore} (≥4: snap + mesh cell per grounded plane), growth over ~60 frames=${callsAfter - callsBefore} (per-frame would be ~60+)`);

        // (d) TRACKED grounded plane → the standalone tracked model (the owner's
        // "tracked SWA143 at 0 kts stayed a 2D cyan billboard" case).
        await evalPage(() => {
          window.__godsEyeView.dataManager.layers.get('flights').module.trackById('aaa077');
        });
        const g3dTrackedUp = await page.waitForFunction(() => {
          const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
          const ti = fl.getTrackedInfo();
          if (!ti || ti.icao24 !== 'aaa077') return false;
          const m = window.__g3dFindModel('aaa077');
          return !!(m && m.ready && m.show);
        }, { timeout: 25000, polling: 250 }).then(() => true).catch(() => false);
        let trackedDetail = 'tracked model never became ready+shown';
        let trackedHeightOk = false;
        if (g3dTrackedUp) {
          const trackedRadius = await evalPage(() => {
            const m = window.__g3dFindModel('aaa077');
            return m ? Math.hypot(m.modelMatrix[12], m.modelMatrix[13], m.modelMatrix[14]) : null;
          });
          const tDelta = trackedRadius - g3dIngest.flBBRadius;
          trackedHeightOk = Math.abs(tDelta - flWantDelta) <= HEIGHT_TOL_M;
          trackedDetail = `tracked model up; Δradial=${tDelta.toFixed(2)} m want=${flWantDelta.toFixed(2)} m`;
        }
        record('ground-3d: TRACKED grounded plane gets the standalone tracked model, ground-snapped',
          g3dTrackedUp && trackedHeightOk, trackedDetail);

        // WELD (tracked): the tracked CARD anchors to the model you can see.
        // `gevVisualPosition` is a SEPARATE accessor from `gevDisplayPosition` on
        // purpose — the latter carries the follow-camera anti-jitter contract and
        // must keep returning the cached dead-reckoned value the camera settled
        // on. So this asserts both halves: the visual accessor is welded to the
        // rendered model, AND the display accessor still reports the (different)
        // dead-reckoned position rather than having been quietly repurposed.
        if (g3dTrackedUp) {
          const trackedWeld = await evalPage(() => {
            const ent = window.__godsEyeView.viewer.trackedEntity;
            const m = window.__g3dFindModel('aaa077');
            if (!m) return { error: 'no tracked model' };
            const matrix = m.modelMatrix;
            const scale = Number.isFinite(m.computedScale)
              ? m.computedScale
              : (Number.isFinite(m.scale) ? m.scale : 1);
            // airplane.glb is now bounding-box centred with transforms applied.
            const x = 0 * scale;
            const y = 0 * scale;
            const z = 0 * scale;
            const anchor = {
              x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
              y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
              z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
            };
            const at = (p) => (p ? Math.hypot(
              p.x - anchor.x, p.y - anchor.y, p.z - anchor.z,
            ) : null);
            const visual = typeof ent?.gevVisualPosition === 'function' ? ent.gevVisualPosition() : null;
            const display = typeof ent?.gevDisplayPosition === 'function' ? ent.gevDisplayPosition() : null;
            return {
              hasVisualAccessor: typeof ent?.gevVisualPosition === 'function',
              visualDelta: at(visual),
              displayDelta: at(display),
            };
          });
          const visualOk = trackedWeld.hasVisualAccessor
            && Number.isFinite(trackedWeld.visualDelta)
            && trackedWeld.visualDelta <= WELD_TOL_M;
          record('weld: TRACKED card anchor === rendered tracked model visual centre',
            visualOk,
            trackedWeld.error
              || `visualΔ=${Number(trackedWeld.visualDelta).toFixed(3)} m (tol ${WELD_TOL_M} m), accessor=${trackedWeld.hasVisualAccessor}`);
          // Separation guard: if displayDelta ever collapses to visualDelta, the
          // anti-jitter accessor has been repurposed and the follow camera is at
          // risk. Skipped (not failed) when the DR cache is momentarily invalid.
          const displayDelta = trackedWeld.displayDelta;
          record('weld: gevDisplayPosition still reports the dead-reckoned position (anti-jitter intact)',
            !Number.isFinite(displayDelta) || displayDelta > ACCESSOR_SEPARATION_EPSILON_M,
            Number.isFinite(displayDelta)
              ? `displayΔ=${displayDelta.toFixed(3)} m (must stay > ${ACCESSOR_SEPARATION_EPSILON_M} m — the ground-snap split)`
              : 'display accessor returned null this frame (DR cache invalid) — separation not evaluated');
        }
      }

      // Cleanup: untrack, restore sampleHeight, drop the grounded synthetics
      // (grounded fast-cull removes them after ONE missed poll).
      await evalPage(async () => {
        const v = window.__godsEyeView.viewer;
        const dm = window.__godsEyeView.dataManager;
        const fl = dm.layers.get('flights').module;
        const mil = dm.layers.get('military').module;
        fl.stopTracking();
        delete v.scene.sampleHeight; // restore the prototype implementation
        window.__SYNTH.flights = window.__SYNTH.flights.filter((f) => f.icao !== 'aaa077');
        window.__SYNTH.military = window.__SYNTH.military.filter((m) => m.hex !== 'bbb177');
        await fl.update(v);
        await mil.update(v);
      });
    }

    // ============================================================
    // CHANGE 4 (2026-07-03): arrival rotation freshness. Field test: "planes
    // look weird when you first come to them — rotations are weird". Two
    // repaired holes, both layers:
    //   (a) SETTLE PASS — camera.moveEnd forces a full rotation pass on the
    //       next frame (the pose-signature gate can eat a fly-to's settle:
    //       the final easing frames land inside one 10 m/0.06° quantization
    //       bucket, leaving mid-flight noses for up to ROTATION_REFRESH_MS).
    //   (b) REVEAL PASS — a billboard flipping INTO view while the camera
    //       idles gets its rotation refreshed the same tick (it used to
    //       reappear wearing its stale/creation-north nose for up to 1 s).
    // Staged deterministically: park the camera nadir over the synthetic
    // cluster, let rotations settle, TAMPER a billboard's rotation, then
    // trigger each path with the camera idle. The idle-drift catch-up
    // (ROTATION_REFRESH_MS = 1 s) can coincidentally mask a regression in a
    // ~300 ms SwiftShader frame window, so a regression shows as an
    // intermittent (not guaranteed) failure — never a false failure.
    // ============================================================
    console.log('\nChange 4 — arrival rotation: moveEnd settle pass + horizon-reveal pass');
    const arrival = await evalPage(async () => {
      const v = window.__godsEyeView.viewer;
      const dm = window.__godsEyeView.dataManager;
      // 3D models OFF for this phase: a model-handed-off billboard is hidden
      // and skips rotation updates entirely — the probes need live billboards
      // (this is also the app's default state the field report came from).
      dm.layers.get('flights').module.setParams({ models3d: false });
      dm.layers.get('military').module.setParams({ models3d: false });
      const findBB = (id) => {
        let found = null;
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            let p;
            try { p = coll.get(i); } catch { continue; }
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.image !== undefined && p.alignedAxis !== undefined && p.id === id) found = p;
          }
        };
        walk(v.scene.primitives);
        return found;
      };
      const nextFrames = (n) => new Promise((res) => {
        let count = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rm();
          res();
        };
        const rm = v.scene.postRender.addEventListener(() => {
          if (++count >= n) {
            finish();
            return;
          }
          v.scene.requestRender();
        });
        const timer = setTimeout(finish, Math.max(10000, n * 1500));
        v.scene.requestRender();
      });
      // Park the camera straight above the flights cluster (lift a live
      // billboard's position radially — no Cesium global needed in-page) so
      // every probe plane projects on-screen, then let rotations settle at
      // the new pose (the setView pose change forces a pass on the next tick).
      // aaa002 — aaa001 was evicted for good by the M3 age-out phase.
      const anchor = findBB('aaa002');
      if (!anchor) return { error: 'anchor aaa002 missing' };
      const p = anchor.position;
      const r = Math.hypot(p.x, p.y, p.z);
      const k = (r + 25000) / r;
      v.camera.cancelFlight();
      v.camera.setView({
        destination: { x: p.x * k, y: p.y * k, z: p.z * k },
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await nextFrames(3);
      const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
      const probe = async (id) => {
        const bb = findBB(id);
        if (!bb || !bb.show) return { error: `${id} missing/hidden` };
        const r0 = bb.rotation; // settled reference (camera idle; DR drift is sub-degree over the probe)
        // (a) settle pass: tamper, then raise moveEnd with the camera IDLE —
        // the pose signature is unchanged, so only the moveEnd hook can fix
        // this before the 1 s catch-up.
        bb.rotation = r0 + 1.5;
        v.camera.moveEnd.raiseEvent();
        await nextFrames(2);
        const afterMoveEnd = bb.rotation;
        // (b) reveal pass: tamper + hide — the next fleet tick must flip it
        // visible AND correct the nose in that same tick (camera still idle,
        // no moveEnd raised). Diagnostic fields (round 5): record WHICH frame
        // the flip landed on (flipFrame; -1 = never within the extended
        // window) and whether a 3D model owns this id — distinguishes "tick
        // slow under load" from "occluder says hidden" from "model handoff".
        bb.rotation = r0 + 1.5;
        bb.show = false;
        let flipFrame = -1;
        for (let f = 1; f <= 6; f++) {
          await nextFrames(1);
          if (bb.show && flipFrame === -1) flipFrame = f;
          if (f >= 2 && flipFrame !== -1) break;
        }
        const hasModel = !!(window.__g3dFindModel && window.__g3dFindModel(id));
        return {
          r0, dMoveEnd: angDiff(afterMoveEnd, r0), dReveal: angDiff(bb.rotation, r0),
          shown: bb.show, flipFrame, hasModel,
        };
      };
      return { flights: await probe('aaa002'), military: await probe('bbb101') };
    });
    const fmtArr = (a) => (!a ? `no result (${arrival?.error || 'phase error'})` : a.error ? a.error
      : `settle-err=${(a.dMoveEnd * 180 / Math.PI).toFixed(1)}° reveal-err=${(a.dReveal * 180 / Math.PI).toFixed(1)}° shown=${a.shown} flipFrame=${a.flipFrame} hasModel=${a.hasModel}`);
    const TAMPER_DEG = 1.5 * 180 / Math.PI; // ≈ 86° — an uncorrected nose stays this far off
    // Reveal budget re-pinned 2 → 4 frames (round 5): the diagnostic probe
    // shows the military flip consistently lands on frame 2 — the exact edge
    // of the old budget — so any load hiccup flaked it (flights lands frame
    // 1). The regression this protects against is a reveal that waits for
    // the 1 s idle catch-up (~30-60 frames) or never re-aims; 4 frames still
    // catches that with a wide margin, with zero-headroom flakes gone.
    const arrOk = (a) => !!a && !a.error && a.shown
      && (a.flipFrame === -1 ? false : a.flipFrame <= 4)
      && a.dMoveEnd * 180 / Math.PI < 10 && a.dReveal * 180 / Math.PI < 10;
    record(`arrival: moveEnd + reveal both re-aim within 4 frames, flights (tamper was ${TAMPER_DEG.toFixed(0)}°)`,
      arrOk(arrival.flights), fmtArr(arrival.flights));
    record(`arrival: moveEnd + reveal both re-aim within 4 frames, military (tamper was ${TAMPER_DEG.toFixed(0)}°)`,
      arrOk(arrival.military), fmtArr(arrival.military));

    // ============================================================
    // DISPLAY FLOOR (2026-08-19): a grounded contact must never render below
    // the floor of the cell it is DISPLAYED over.
    //
    // `renderAltitudeM` is picked once per poll from the floor of the FIX's
    // coarse cell, but what renders is the dead-reckoned position — which
    // drifts across cells for the whole 30 s segment and, while a ground
    // contact coasts on a stale feed, for hundreds of metres more. On a graded
    // apron (KAUS spans ~119–140 m ellipsoidal) the sprite ends up under the
    // mesh it taxied over; qa-floor-verify measured −15.5 m and reported
    // VERDICT: FAIL on main.
    //
    // Staged so ONLY the display path can produce the lift: the contact's own
    // fix cell is left COLD and the seeded floor is planted on the cells the
    // display has drifted onto. A poll-path fix would read the fix cell and
    // find nothing there, so a pass here cannot come from anywhere else.
    // ============================================================
    console.log('\nDisplay floor — grounded contacts never render below the cell they drifted onto');
    const DISPLAY_FLOOR_LIFT_M = 1.5; // GROUND_FLOOR_LIFT_M
    const DF_LAT = 30.2600, DF_LON = -97.7500;
    const DF_SEED_M = 400; // identity-probe floor for the fix cell

    const dfSetup = await evalPage(async () => {
      const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
      const v = window.__godsEyeView.viewer;
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      // Hermetic: the ground-3d group's cleanup restored the REAL sampleHeight,
      // which would let the mesh sampler latch whatever headless GL streams.
      //
      // `__dfSkinM` is the switch, and it is load-bearing rather than tidy. A
      // permanently-missing stub means groundSnap can never resolve, and a
      // grounded MODEL cannot be placed without a ground height — so every
      // grounded-model assertion in this group becomes unreachable and reports
      // as a skip about GLB backends instead of as the contract it is. null is
      // the group default (the honest "no tiles here" the earlier scenarios
      // need, and the COLD case in its own right); a number opens a
      // DETERMINISTIC skin for the scenarios that need a model to draw.
      window.__dfSkinM = null;
      v.scene.sampleHeight = () => (window.__dfSkinM == null ? undefined : window.__dfSkinM);
      fl.setParams({ models3d: false }); // billboards own the visual (T7 gate open)
      window.__dfFindBB = (id) => {
        let found = null;
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            let p; try { p = coll.get(i); } catch { continue; }
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.image !== undefined && p.alignedAxis !== undefined && p.id === id) found = p;
          }
        };
        walk(v.scene.primitives);
        return found;
      };
      window.__dfCarto = (pos) => {
        const c = Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84);
        return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude), h: c.height };
      };
      // The fleet pass is rate-limited, so counting raw frames under-waits.
      window.__dfSettle = (ms) => new Promise((res) => {
        let done = false;
        const tick = () => { if (done) return; v.scene.requestRender(); setTimeout(tick, 30); };
        tick();
        setTimeout(() => { done = true; res(); }, ms);
      });
      // Cesium Models in the scene, split by visibility (duck-typed the same
      // way the harness excludes them from height probes).
      //
      // Pass an `icao` to count ONLY that contact's model. Both the fleet loader
      // and the standalone tracked loader stamp `model.id` with the icao (the
      // pick identity click-to-track depends on), and the fleet pass never
      // models the tracked contact — so an id match for the tracked icao is
      // unambiguously ITS model. Counting every model in the scene instead let
      // an unrelated fleet, military, or control model satisfy "the model owns
      // the visual" while the contact under test never rendered at all.
      // `rendering` is the pair the production handoff consults (`ready &&
      // show`): a model registered with Cesium's default `show === true` the
      // instant its glTF resolves is NOT yet the visual.
      window.__dfCountModels = (icao) => {
        let shown = 0;
        let hidden = 0;
        let rendering = 0;
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            let p; try { p = coll.get(i); } catch { continue; }
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.activeAnimations !== undefined && p.minimumPixelSize !== undefined) {
              if (icao !== undefined && p.id !== icao) continue;
              if (p.show) {
                shown += 1;
                if (p.ready === true) rendering += 1;
              } else hidden += 1;
            }
          }
        };
        walk(v.scene.primitives);
        return { shown, hidden, rendering };
      };
      // Ellipsoid height of the point a contact's MODEL is actually drawn at.
      // The counters above answer "is a model the visual"; this answers "and is
      // it standing on the ground", which is the half a rendering count cannot
      // see — a model placed at the raw feed altitude renders exactly as
      // enthusiastically as one placed on the tile skin, ~240 m underground.
      window.__dfModelHeight = (icao) => {
        let h = null;
        const walk = (coll) => {
          const n = coll.length;
          for (let i = 0; i < n; i++) {
            let p; try { p = coll.get(i); } catch { continue; }
            if (!p) continue;
            if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
            if (p.activeAnimations !== undefined && p.minimumPixelSize !== undefined
              && p.id === icao && p.modelMatrix) {
              const m = p.modelMatrix;
              // Cesium's default is the IDENTITY matrix — translation (0,0,0),
              // the Earth's centre, which `Cartographic.fromCartesian` refuses.
              // An admitted-but-never-placed model reads as "no height", which
              // is the truth about it.
              if (m[12] || m[13] || m[14]) {
                const c = Cesium.Cartographic.fromCartesian(
                  new Cesium.Cartesian3(m[12], m[13], m[14]), Cesium.Ellipsoid.WGS84,
                );
                h = c ? c.height : null;
              }
            }
          }
        };
        walk(v.scene.primitives);
        return h;
      };
      // Tracked-contact model regime (2026-08-20). The tracked contact's model
      // is NOT governed by the DISPLAY-rail 3D toggle — that toggle owns the
      // FLEET's draw-call budget. The tracked model is default-on and driven by
      // camera distance, entering below TRACKED_MODEL_ENTER_ALT_M and handing
      // back to the billboard only above TRACKED_MODEL_EXIT_ALT_M (the
      // anti-flap band). The CAMERA is therefore what decides whether a model
      // or a billboard is the visual for a tracked contact, which is exactly
      // what the display floor stands aside for — so these pins drive the
      // camera explicitly instead of the toggle.
      //
      // Read the thresholds from the app's own policy module so a later retune
      // of the swap distance moves these pins with it rather than stranding
      // them on stale numbers.
      const reg = await import('/src/data/trackedModelRegime.js');
      window.__dfRegime = {
        enter: reg.TRACKED_MODEL_ENTER_ALT_M,
        exit: reg.TRACKED_MODEL_EXIT_ALT_M,
      };
      // Zooming while following is safe: the tracked-camera framer positions
      // the camera ONCE per selection and is deliberately read-only on normal
      // frames (EntityView is the sole continuous writer, and the only
      // correction is a minimum-range clamp that guards zooming IN, not out),
      // so a programmatic zoom persists instead of being fought every frame.
      window.__dfCamH = () => v.camera.positionCartographic.height;
      // Both walkers bail on a STALLED step as well as on reaching the target:
      // the controller enforces a minimum range when following, so a zoom-in
      // that has bottomed out would otherwise spin the full iteration budget.
      window.__dfZoomAbove = async (targetH) => {
        let last = window.__dfCamH();
        for (let i = 0; i < 80 && window.__dfCamH() <= targetH; i++) {
          v.camera.zoomOut(Math.max(15000, (targetH - window.__dfCamH()) * 0.9));
          await window.__dfSettle(100);
          const now = window.__dfCamH();
          if (i > 0 && Math.abs(now - last) < 1) break;
          last = now;
        }
        return window.__dfCamH();
      };
      window.__dfZoomBelow = async (targetH) => {
        let last = window.__dfCamH();
        for (let i = 0; i < 80 && window.__dfCamH() >= targetH; i++) {
          v.camera.zoomIn(Math.max(250, (window.__dfCamH() - targetH) * 0.5));
          await window.__dfSettle(100);
          const now = window.__dfCamH();
          if (i > 0 && Math.abs(now - last) < 1) break;
          last = now;
        }
        return window.__dfCamH();
      };
      // Wait for THIS contact's tracked model to actually RENDER (loaded AND
      // shown) — ownership means drawing, not existing, and it means the model
      // that carries this icao's pick id, not whichever model happened to be up.
      window.__dfAwaitTrackedModel = async (icao, ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline && window.__dfCountModels(icao).rendering === 0) {
          await window.__dfSettle(500);
        }
        return window.__dfCountModels(icao);
      };
      // Vite serves an edited source file as `…/groundFloor.js?t=<hmr stamp>`;
      // importing the PLAIN path then hands back a second, unrelated module
      // instance whose cells the app never reads. Offer the URL the app itself
      // loaded first, then the plain path (clean, never-hot-reloaded server).
      const seen = performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => /\/src\/data\/groundFloor\.js(\?|$)/.test(n));
      window.__dfCandidates = [...new Set([...seen.reverse(), '/src/data/groundFloor.js'])];
      return { candidates: window.__dfCandidates.length };
    });
    record('display-floor: groundFloor module URL candidates found', dfSetup.candidates > 0,
      JSON.stringify(dfSetup));

    // Identity probe. Seed a contact's FIX cell BEFORE its first fix arrives,
    // then poll: the grounded surfaceM chain reads cachedGroundFloor, so the
    // sprite renders at the seeded floor if and only if the app shares this
    // module instance. (It must be the FIRST fix — the display runs `now − 30 s`,
    // which for a new contact extrapolates history[0].) This exercises the POLL
    // path only; the clamp under test reads the DISPLAY cell, which stays cold
    // here, so a broken fix cannot fake a pass.
    const dfIdentity = await evalPage(async (lat, lon, seedM) => {
      const v = window.__godsEyeView.viewer;
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      const tried = [];
      for (let i = 0; i < window.__dfCandidates.length; i++) {
        const url = window.__dfCandidates[i];
        let gf;
        try { gf = await import(/* @vite-ignore */ url); } catch { tried.push({ url, h: null }); continue; }
        if (typeof gf.reportMeshFloorCell !== 'function') { tried.push({ url, h: null }); continue; }
        gf.setMeshFloorPreferred(true);
        gf._clearMeshFloorCellsForTest();
        gf.reportMeshFloorCell(lat, lon, seedM);
        // A fresh icao per attempt: a contact that already exists keeps the
        // history[0] the warm-up dead-reckon renders, so it could never show a
        // floor seeded afterwards.
        const icao = `aaa09${i}`;
        window.__SYNTH.flights.push({ icao, callsign: `TAXI9${i}`, lon, lat, alt: 150, vel: 12, track: 90, onGround: true });
        await fl.update(v);
        await window.__dfSettle(400);
        const bb = window.__dfFindBB(icao);
        const h = bb ? window.__dfCarto(bb.position).h : null;
        tried.push({ url, h });
        gf._clearMeshFloorCellsForTest();
        if (Number.isFinite(h) && Math.abs(h - seedM) < 5) {
          window.__dfGf = gf; window.__dfIcao = icao;
          return { picked: { url, h }, tried };
        }
        window.__SYNTH.flights = window.__SYNTH.flights.filter((f) => f.icao !== icao);
      }
      return { picked: null, tried };
    }, DF_LAT, DF_LON, DF_SEED_M);
    const identityOk = !!dfIdentity.picked;
    record('display-floor: harness reached the app\'s own groundFloor module instance',
      identityOk,
      identityOk
        ? `a ${DF_SEED_M} m fix-cell seed put the sprite at ${Number(dfIdentity.picked.h).toFixed(1)} m (${dfIdentity.picked.url})`
        : `no candidate module was the app's: ${JSON.stringify(dfIdentity.tried)}`);

    if (!identityOk) {
      skip('display-floor: drift clamp (harness could not seed the shared floor cache)',
        'the identity probe above failed — assertions would be meaningless');
    } else {
      const dfDrift = await evalPage(async (lat, lon) => {
        const v = window.__godsEyeView.viewer;
        const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
        const gf = window.__dfGf;
        const icao = window.__dfIcao;
        const cell = (x) => Number(x.toFixed(3));
        // Fix cell COLD from here on. The contact keeps the seeded render
        // altitude in its history, and its DISPLAYED position sits one render
        // delay of taxi behind the fix — several cells away.
        gf._clearMeshFloorCellsForTest();
        // Airborne control at the same coordinates, ingested while every cell
        // is cold so its own fix-time clamp finds nothing: it drifts over the
        // same cells and must NOT be lifted.
        const airIcao = 'aaa095';
        window.__SYNTH.flights.push({ icao: airIcao, callsign: 'AIR95', lon, lat, alt: 150, vel: 12, track: 90 });
        await new Promise((r) => setTimeout(r, 1200)); // fix epochs are second-resolution
        await fl.update(v);
        await window.__dfSettle(400);

        const bb = window.__dfFindBB(icao);
        if (!bb) return { error: `${icao} billboard missing` };
        const d0 = window.__dfCarto(bb.position);
        const driftedCells = cell(d0.lat) !== cell(lat) || cell(d0.lon) !== cell(lon);
        const driftM = Math.hypot((d0.lat - lat) * 111320,
          (d0.lon - lon) * 111320 * Math.cos(lat * Math.PI / 180));
        // Plant a floor 30 m above where the sprite is DISPLAYED, across the
        // 3×3 cell block it can move within during the assertion window.
        const seeded = d0.h + 30;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            gf.reportMeshFloorCell(cell(d0.lat) + dy * 0.001, cell(d0.lon) + dx * 0.001, seeded);
          }
        }
        // The fleet clamp runs on its throttled render pass. Under a loaded QA
        // machine a fixed 1.2 s sleep can sample just before that pass, so wait
        // for the observable clamp with a hard deadline instead of weakening
        // the assertion or assuming one scheduler cadence.
        const clampDeadline = Date.now() + 5000;
        let bb2 = null;
        let d1 = null;
        do {
          await window.__dfSettle(250);
          bb2 = window.__dfFindBB(icao);
          d1 = bb2 ? window.__dfCarto(bb2.position) : null;
        } while (Date.now() < clampDeadline && (!d1 || d1.h < seeded + 1));
        const air = window.__dfFindBB(airIcao);
        const a1 = air ? window.__dfCarto(air.position) : null;
        return {
          driftedCells, driftM, seeded,
          beforeH: d0.h,
          afterH: d1 ? d1.h : null,
          floorUnderSprite: d1 ? gf.cachedGroundFloor(d1.lat, d1.lon) : null,
          fixCellMesh: gf.cachedMeshFloor(lat, lon),
          fixCellFloor: gf.cachedGroundFloor(lat, lon),
          airborneH: a1 ? a1.h : null,
          airborneFound: !!air,
        };
      }, DF_LAT, DF_LON);

      record('display-floor: the displayed position really has drifted off the fix cell',
        dfDrift.driftedCells === true,
        dfDrift.error || `displayed ${Number(dfDrift.driftM).toFixed(0)} m from the fix (render delay × taxi speed)`);

      const clampOk = Number.isFinite(dfDrift.afterH) && Number.isFinite(dfDrift.floorUnderSprite)
        && dfDrift.afterH >= dfDrift.floorUnderSprite + DISPLAY_FLOOR_LIFT_M - 0.5;
      record('display-floor: a grounded sprite never renders below the cell it drifted onto',
        clampOk,
        dfDrift.error || `${Number(dfDrift.beforeH).toFixed(1)} m → ${Number(dfDrift.afterH).toFixed(1)} m against a ${Number(dfDrift.floorUnderSprite).toFixed(1)} m floor (needs >= floor + ${DISPLAY_FLOOR_LIFT_M} m)`);

      // Discriminator: the poll path had nothing to read, so the lift can only
      // have come from the display path.
      const fixCellCold = dfDrift.fixCellMesh == null
        && (dfDrift.fixCellFloor == null || dfDrift.fixCellFloor < dfDrift.seeded - 10);
      record('display-floor: the lift came from the display path (fix cell still cold)',
        fixCellCold,
        `fix cell mesh=${dfDrift.fixCellMesh} floor=${dfDrift.fixCellFloor} vs seeded ${Number(dfDrift.seeded).toFixed(1)} m`);

      // Grounded-only: an AIRBORNE contact drifting over the same seeded cells
      // keeps its reported altitude — the fix-time clamp owns airborne heights.
      record('display-floor: an AIRBORNE contact over the same cells is not lifted',
        dfDrift.airborneFound === true && Number.isFinite(dfDrift.airborneH)
          && dfDrift.airborneH < dfDrift.seeded - 10,
        `airborne renders at ${Number(dfDrift.airborneH).toFixed(1)} m (seeded floor ${Number(dfDrift.seeded).toFixed(1)} m)`);

      // ---- Corridor wiring, WITHOUT pre-seeding ----------------------------
      // The scenario above plants the floor by hand, so it still passes if the
      // corridor collection is deleted, aimed at the wrong end, or starved.
      // This one seeds NOTHING: the contact's DISPLAY cell can only get a floor
      // if the poll actually collects the ground it is rendering over and warms
      // it through the real DEM resolve. A control cell the same distance away,
      // which no corridor covers, must stay cold.
      const dfCorridor = await evalPage(async (lat, lon) => {
        const v = window.__godsEyeView.viewer;
        const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
        const gf = window.__dfGf;
        const cell = (x) => Number(x.toFixed(3));
        gf._clearMeshFloorCellsForTest(); // DEM only — sampleHeight is stubbed off
        const key = (c) => `${c.lat},${c.lon}`;
        // Control: the same distance from the fix, perpendicular to the track,
        // so it is equally "near the airport" but on no contact's path.
        const controlCell = { lat: cell(lat + 0.02), lon: cell(lon) };
        // ~250 m PAST the fix along the track (090). The display sits behind the
        // fix and is extrapolating toward it, so this ground is only reachable
        // if the corridor follows the direction of travel instead of stopping
        // at the fix — the coasting-away defect, observable without waiting for
        // a real coast.
        const aheadCell = {
          lat: cell(lat),
          lon: cell(lon + 250 / (111320 * Math.cos(lat * Math.PI / 180))),
        };
        // Snapshot the whole neighbourhood BEFORE this contact exists. The
        // display cell's identity is only knowable after a second fix has aged
        // the display head off the fix — and by then the corridor has already
        // run and (correctly) warmed it, so a read at that point can never show
        // it cold. `_clearMeshFloorCellsForTest()` does not help: the DEM half
        // of `cachedGroundFloor` lives in terrainHeights' own cache. So the
        // cold state is captured up front and looked up afterwards. A display
        // cell outside this grid reports `out-of-snapshot`, which fails the
        // assertion rather than passing it quietly.
        const coldBefore = new Map();
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -8; dx <= 8; dx++) {
            const c = { lat: cell(lat + dy * 0.001), lon: cell(lon + dx * 0.001) };
            coldBefore.set(key(c), gf.cachedGroundFloor(c.lat, c.lon));
          }
        }
        const startCold = {
          control: gf.cachedGroundFloor(controlCell.lat, controlCell.lon),
        };
        // Baro 0 puts it at the geoid (~-27 m here), ~150 m under the real
        // Austin surface, so any lift is unambiguous.
        window.__SYNTH.flights.push({ icao: 'aaa097', callsign: 'COAST97', lon, lat, alt: 0, vel: 12, track: 90, onGround: true });
        await fl.update(v);
        await window.__dfSettle(600);
        // AGE A SECOND FIX before sampling. With a single fix the display has
        // no path to run and renders AT the fix, which would make the whole
        // scenario vacuous — ordinary fix-cell warming could then satisfy the
        // display-cell assertion below. The second fix (epochs are
        // second-resolution) gives the `now − 30 s` display head a segment to
        // extrapolate back along, putting it ~360 m of taxi behind the fix.
        await new Promise((r) => setTimeout(r, 1200));
        await fl.update(v);
        await window.__dfSettle(600);
        const bb0 = window.__dfFindBB('aaa097');
        if (!bb0) return { error: 'aaa097 billboard missing' };
        const d0 = window.__dfCarto(bb0.position);
        const displayCell = { lat: cell(d0.lat), lon: cell(d0.lon) };
        const fixCell = { lat: cell(lat), lon: cell(lon) };
        startCold.display = coldBefore.has(key(displayCell))
          ? coldBefore.get(key(displayCell))
          : 'out-of-snapshot';
        // Give the fire-and-forget DEM resolve time to land, then let a couple
        // more polls run the corridor again.
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 1400));
          await fl.update(v);
          await window.__dfSettle(600);
        }
        // The production clamp deliberately keeps a sticky floor cell across
        // the first 15% of a boundary crossing. A newly warmed adjacent cell
        // can therefore become readable a frame before the moving sprite is
        // far enough into it to adopt it. Wait for the observable clamp, as the
        // seeded-floor case above does, instead of sampling that valid
        // hysteresis window as a product failure.
        const clampDeadline = Date.now() + 5000;
        let bb1 = null;
        let d1 = null;
        let spriteFloor = null;
        do {
          await window.__dfSettle(250);
          bb1 = window.__dfFindBB('aaa097');
          d1 = bb1 ? window.__dfCarto(bb1.position) : null;
          spriteFloor = d1 ? gf.cachedGroundFloor(d1.lat, d1.lon) : null;
        } while (Date.now() < clampDeadline
          && (!Number.isFinite(d1?.h) || !Number.isFinite(spriteFloor)
            || d1.h < spriteFloor + 1));
        return {
          startCold,
          displayCell,
          fixCell,
          sameCellAsFix: displayCell.lat === fixCell.lat && displayCell.lon === fixCell.lon,
          displayFloor: gf.cachedGroundFloor(displayCell.lat, displayCell.lon),
          controlFloor: gf.cachedGroundFloor(controlCell.lat, controlCell.lon),
          aheadCell,
          aheadFloor: gf.cachedGroundFloor(aheadCell.lat, aheadCell.lon),
          spriteH: d1 ? d1.h : null,
          spriteFloor,
          beforeH: d0.h,
        };
      }, 30.3000, -97.8000);

      // The whole scenario is only meaningful if the cell being warmed is one
      // the ordinary fix-cell batch could NOT have produced. Two conditions
      // make that true, and both are asserted here rather than assumed: the
      // display head really left the fix cell (the second fix aged it there),
      // and that cell was COLD when the measurement started.
      record('display-floor/corridor: the display cell is not the fix cell, and started cold',
        dfCorridor.sameCellAsFix === false && dfCorridor.startCold?.display == null,
        dfCorridor.error
          || `display ${JSON.stringify(dfCorridor.displayCell)} vs fix ${JSON.stringify(dfCorridor.fixCell)}, started at ${dfCorridor.startCold?.display} — the fix-cell collection cannot reach the display cell`);

      record('display-floor/corridor: polling warms the ground the contact is DISPLAYED over',
        Number.isFinite(dfCorridor.displayFloor),
        dfCorridor.error
          || `display-cell floor = ${dfCorridor.displayFloor} (nothing was pre-seeded — only corridor collection can produce this)`);

      // The beyond-fix probe carries its own arithmetic precondition: a cell
      // that collapsed onto the fix cell would be warmed by the fix batch and
      // prove nothing about the direction of travel.
      const distinctAheadCell = dfCorridor.aheadCell?.lat !== dfCorridor.fixCell?.lat
        || dfCorridor.aheadCell?.lon !== dfCorridor.fixCell?.lon;
      record('display-floor/corridor: the corridor reaches PAST the fix, along the direction of travel',
        distinctAheadCell && Number.isFinite(dfCorridor.aheadFloor),
        dfCorridor.error
          || `cell ~250 m beyond the fix (${JSON.stringify(dfCorridor.aheadCell)}, distinct from fix ${JSON.stringify(dfCorridor.fixCell)}: ${distinctAheadCell}) floor = ${dfCorridor.aheadFloor} — a fix-aimed corridor never offers it`);

      record('display-floor/corridor: an off-path control cell stays cold (not ambient warming)',
        dfCorridor.controlFloor == null,
        `control cell floor = ${dfCorridor.controlFloor}`);

      record('display-floor/corridor: the sprite rides the corridor-warmed floor',
        Number.isFinite(dfCorridor.spriteH) && Number.isFinite(dfCorridor.spriteFloor)
          && dfCorridor.spriteH >= dfCorridor.spriteFloor + DISPLAY_FLOOR_LIFT_M - 0.5,
        dfCorridor.error
          || `${Number(dfCorridor.beforeH).toFixed(1)} m → ${Number(dfCorridor.spriteH).toFixed(1)} m on a ${Number(dfCorridor.spriteFloor).toFixed(1)} m floor`);

      // ---- Tracked contact gets the same floor ----------------------------
      // The fleet pass skips the tracked icao and the tracked entity draws from
      // _trackedDisplayPosition, so selecting a correctly floored grounded
      // billboard used to swap it for an unfloored cyan target under the mesh.
      const dfTracked = await evalPage(async () => {
        const v = window.__godsEyeView.viewer;
        const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
        const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
        const gf = window.__dfGf;
        const cell = (x) => Number(x.toFixed(3));
        const bbBefore = window.__dfFindBB('aaa097');
        if (!bbBefore) return { error: 'aaa097 billboard missing' };
        const d0 = window.__dfCarto(bbBefore.position);
        // Plant a floor well ABOVE where it currently renders, across the block
        // it can move within, so an UNFLOORED tracked entity is unmistakable.
        const seeded = d0.h + 40;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            gf.reportMeshFloorCell(cell(d0.lat) + dy * 0.001, cell(d0.lon) + dx * 0.001, seeded);
          }
        }
        const fleetClampDeadline = Date.now() + 5000;
        let bbLifted = null;
        let fleetH = null;
        do {
          await window.__dfSettle(250);
          bbLifted = window.__dfFindBB('aaa097');
          fleetH = bbLifted ? window.__dfCarto(bbLifted.position).h : null;
        } while (Date.now() < fleetClampDeadline
          && (!Number.isFinite(fleetH) || fleetH < seeded + 1));
        if (!fl.trackById('aaa097')) return { error: 'trackById(aaa097) failed' };
        await window.__dfSettle(1500);
        // Read the tracked entity's rendered height plus the floor under it and
        // the sensor value the data APIs report, at whatever regime the camera
        // is currently in.
        const readTracked = () => {
          const pos = v.trackedEntity?.position?.getValue(Cesium.JulianDate.now());
          if (!pos) return null;
          const c = window.__dfCarto(pos);
          const info = fl.getTrackedInfo();
          const subject = fl.getTrackedSubject();
          return {
            h: c.h,
            floor: gf.cachedGroundFloor(c.lat, c.lon),
            reportedAltM: info?.altitudeM,
            subjectH: subject?.position ? window.__dfCarto(subject.position).h : null,
            camH: window.__dfCamH(),
            // THIS contact's model, not any model in the scene: the ownership
            // side of the assertion has to be about aaa097 or it proves nothing
            // about who drew aaa097.
            models: window.__dfCountModels('aaa097'),
          };
        };

        // --- Regime IN, COLD ground: the model is WITHHELD ------------------
        // trackById re-frames the camera to the close follow range, so the
        // tracked model regime is already active. `__dfSkinM` is still null, so
        // groundSnap has never resolved for this contact: there is no evidence
        // of where the ground is, and a depth-tested glTF placed at the feed
        // altitude (baro 0 → ~-27 m at Austin) renders ~240 m INSIDE the mesh.
        // The only honest answer is not to draw it — which also means the
        // billboard is still the visual and must still be FLOORED.
        await window.__dfSettle(2500);
        const coldModels = window.__dfCountModels('aaa097');
        // `shown` as well as `rendering`: a model parked at scale 0 with
        // show=true would satisfy "nothing renders" while still being a shown
        // primitive claiming the visual, which is the shape this rejects.

        const coldTracked = readTracked();
        const coldModelH = window.__dfModelHeight('aaa097');

        // --- Regime IN, WARM ground: the model takes over, ON the floor ------
        // Open a deterministic tile skin AT the planted floor. groundSnap
        // resolves, the model is placed on it (plus the class belly offset) and
        // takes the visual; the display clamp must then STAND ASIDE (T7),
        // leaving the ENTITY at its raw dead-reckon while the MODEL carries the
        // ground truth. Both halves are asserted — a rendering count alone
        // cannot tell a model standing on the apron from one buried under it.
        //
        // The open skin is HANDED to the retained-model scenario below, which
        // closes it once its own model is up. Every other way out of this block
        // — an early error return, a throw — has to close it here instead: a
        // skin left open lets a live sample latch into the floor cells the
        // planted seeds below are about to own, and the damage would then
        // surface as a failure in an unrelated scenario.
        window.__dfSkinM = seeded;
        let handOffSkin = false;
        try {
        const modelsIn = await window.__dfAwaitTrackedModel('aaa097', 20000);
        const warmModelH = window.__dfModelHeight('aaa097');
        // Scene-wide count, used only to tell two very different states apart:
        // NO model rendered at all (this browser has no usable GLB backend — a
        // legitimate skip) versus models rendered but none of them carried
        // aaa097's pick id (a real defect, and the case the old scene-wide
        // probe reported as a pass).
        const anyModelsIn = window.__dfCountModels();
        await window.__dfSettle(600);
        const zoomedIn = readTracked();
        if (!zoomedIn) return { error: 'tracked entity has no position (zoomed in)' };

        // --- Regime OUT: camera above the exit ceiling ----------------------
        // Climb past the anti-flap band and the model hands the visual back to
        // the billboard — which MUST be floored, or a tracked grounded contact
        // renders buried at any distance the operator pulls out to. This is the
        // coverage the toggle used to reach; the zoom regime reaches it now.
        const achievedOut = await window.__dfZoomAbove(window.__dfRegime.exit + 5000);
        await window.__dfSettle(1500);
        const zoomedOut = readTracked();
        if (!zoomedOut) return { error: 'tracked entity has no position (zoomed out)' };

        const out = {
          rawH: d0.h,
          seeded,
          fleetH,
          enter: window.__dfRegime.enter,
          exit: window.__dfRegime.exit,
          modelsRenderingIn: modelsIn.rendering,
          anyModelsRenderingIn: anyModelsIn.rendering,
          achievedOut,
          coldModelsRendering: coldModels.rendering,
          coldModelsShown: coldModels.shown,
          coldModelH,
          coldEntityH: coldTracked ? coldTracked.h : null,
          coldFloor: coldTracked ? coldTracked.floor : null,
          warmModelH,
          zoomedIn,
          zoomedOut,
        };
        fl.stopTracking();
        await window.__dfSettle(400);
        handOffSkin = true;
        return out;
        } finally {
          if (!handOffSkin) window.__dfSkinM = null;
        }
      });

      record('display-floor: the fleet billboard lifts onto the planted floor (control for the tracked check)',
        !dfTracked.error && Number.isFinite(dfTracked.fleetH)
          && dfTracked.fleetH >= dfTracked.seeded + DISPLAY_FLOOR_LIFT_M - 0.5,
        dfTracked.error
          || `billboard ${Number(dfTracked.rawH).toFixed(1)} m → ${Number(dfTracked.fleetH).toFixed(1)} m (floor ${Number(dfTracked.seeded).toFixed(1)} m)`);

      // The tracked contact is floored exactly when the BILLBOARD is what the
      // operator sees, and stands aside exactly when the MODEL is. "Exactly
      // when" needs BOTH halves, so both are asserted: floored on the way out,
      // NOT floored on the way in. Since the tracked model became zoom-driven
      // (2026-08-20), the camera is what picks between the two, so this pin
      // drives both sides of the hysteresis band in one scenario.
      //
      // The negative half is what a height read alone cannot establish —
      // groundSnap can land at the same number as the clamp — so it is paired
      // with an OWNERSHIP probe rather than inferred from height. The probe is
      // aaa097's OWN model (exact pick id) in the `ready && show` state
      // `_modelOwnsVisual` consults: rendering while zoomed in, not rendering
      // while zoomed out. That distinguishes the two sources by WHO DREW IT,
      // which is the actual contract:
      //  - IN: aaa097's model renders ⇒ `_floorGroundedDisplayPosition` returns
      //    early, so the tracked ENTITY sits at its raw dead-reckon (baro 0,
      //    ~150 m under the planted floor) while groundSnap positions the model.
      //  - OUT: no model of aaa097 renders ⇒ the billboard is the visual and
      //    MUST be lifted, or a tracked grounded contact renders buried at
      //    whatever distance the operator has pulled out to.
      const dfIn = dfTracked.zoomedIn || {};
      const dfOut = dfTracked.zoomedOut || {};
      const dfOutFloored = Number.isFinite(dfOut.h) && Number.isFinite(dfOut.floor)
        && dfOut.h >= dfOut.floor + DISPLAY_FLOOR_LIFT_M - 0.5;
      const dfInStandsAside = Number.isFinite(dfIn.h) && Number.isFinite(dfIn.floor)
        && dfIn.h < dfIn.floor + DISPLAY_FLOOR_LIFT_M - 0.5;
      const dfInModelOwns = dfIn.models?.rendering > 0;
      const dfOutBillboardOwns = dfOut.models?.rendering === 0;
      const dfRegimeName = 'display-floor/regime: the TRACKED grounded contact is floored exactly when the billboard is the visual';

      // COLD ground, camera IN: the gate. A grounded model with no resolved
      // ground is not drawn at all, and the billboard it did not replace is
      // still floored. Before this pin the same run reported "1 aaa097 model(s)
      // rendering, entity left at -26.8 m under a 215.1 m floor" as a PASS —
      // the model was rendering 242 m under the apron and nothing said so.
      const dfColdFloored = Number.isFinite(dfTracked.coldEntityH)
        && Number.isFinite(dfTracked.coldFloor)
        && dfTracked.coldEntityH >= dfTracked.coldFloor + DISPLAY_FLOOR_LIFT_M - 0.5;
      record('display-floor/gate: with NO resolved ground the grounded model is withheld and the billboard is floored',
        !dfTracked.error && dfTracked.coldModelsRendering === 0
          && dfTracked.coldModelsShown === 0 && dfColdFloored,
        dfTracked.error
          || `cold skin: ${dfTracked.coldModelsRendering} aaa097 model(s) rendering / ${dfTracked.coldModelsShown} shown (placed height ${dfTracked.coldModelH == null ? 'none — never placed' : Number(dfTracked.coldModelH).toFixed(1) + ' m'}), billboard at ${Number(dfTracked.coldEntityH).toFixed(1)} m on a ${Number(dfTracked.coldFloor).toFixed(1)} m floor`);

      // WARM ground, camera IN: the placement. The model is not merely visible,
      // it is standing ON the floor — within one class belly offset above it,
      // never under it. MAX_BELLY_M clears the largest offset any class adds
      // (widebody b789, 7.81 m in CLASS_MODEL_REAL); the floor itself is the
      // hard lower bound, and a model placed at the raw feed altitude is ~240 m
      // under it.
      const MAX_BELLY_M = 12;
      const dfWarmOnFloor = Number.isFinite(dfTracked.warmModelH)
        && dfTracked.warmModelH >= dfTracked.seeded
        && dfTracked.warmModelH <= dfTracked.seeded + MAX_BELLY_M;
      record('display-floor/placement: a resolved grounded model stands ON the floor, not under it and not hidden',
        !dfTracked.error && dfTracked.modelsRenderingIn > 0 && dfWarmOnFloor,
        dfTracked.error
          || `warm skin: ${dfTracked.modelsRenderingIn} aaa097 model(s) rendering at ${Number(dfTracked.warmModelH).toFixed(1)} m on a ${Number(dfTracked.seeded).toFixed(1)} m floor (belly headroom ${MAX_BELLY_M} m; raw feed altitude was ${Number(dfTracked.rawH).toFixed(1)} m)`);

      // Skip only when NO model rendered anywhere — that is a browser without a
      // usable GLB backend. Models rendering while none of them is aaa097's is
      // a defect, and falls through to the record below so it reports RED.
      if (!dfTracked.error && !dfTracked.modelsRenderingIn && !dfTracked.anyModelsRenderingIn) {
        skip(dfRegimeName,
          'no tracked model rendered in this browser — the zoomed-in half has no model to own the visual');
      } else {
        record(dfRegimeName,
          !dfTracked.error
            && dfInModelOwns && dfInStandsAside
            && dfOutBillboardOwns && dfOutFloored
            && Number.isFinite(dfIn.camH) && dfIn.camH < dfTracked.enter
            && Number.isFinite(dfOut.camH) && dfOut.camH > dfTracked.exit,
          dfTracked.error
            || `IN @ ${(dfIn.camH / 1000).toFixed(0)} km (< ${(dfTracked.enter / 1000).toFixed(0)} km enter): ${dfIn.models?.rendering} aaa097 model(s) rendering, entity left at ${Number(dfIn.h).toFixed(1)} m under a ${Number(dfIn.floor).toFixed(1)} m floor (groundSnap owns it); `
              + `OUT @ ${(dfOut.camH / 1000).toFixed(0)} km (> ${(dfTracked.exit / 1000).toFixed(1)} km exit): ${dfOut.models?.rendering} aaa097 model(s) rendering, billboard owns it again, ${Number(dfIn.h).toFixed(1)} m → ${Number(dfOut.h).toFixed(1)} m on a ${Number(dfOut.floor).toFixed(1)} m floor`);
      }

      // The visual/data split is INTENTIONAL: pixels are floored, measurements
      // are not. Pinned so a later "floor everything" pass has to argue with it.
      // Asserted in BOTH regimes — who owns the visual must never change what a
      // query, the cockpit altimeter, or a proximity count reports.
      record('display-floor/regime: data APIs report sensor truth in BOTH regimes, floored or not',
        !dfTracked.error
          && Number.isFinite(dfIn.reportedAltM) && Math.abs(dfIn.reportedAltM) < 1
          && Number.isFinite(dfOut.reportedAltM) && Math.abs(dfOut.reportedAltM) < 1
          && Math.abs(dfOut.reportedAltM - dfOut.h) > 100,
        dfTracked.error
          || `getTrackedInfo().altitudeM = ${dfIn.reportedAltM} zoomed in / ${dfOut.reportedAltM} zoomed out (feed baro), while the floored visual reads ${Number(dfOut.h).toFixed(1)} m — the split is deliberate`);

      // ---- F4: a RETAINED-but-hidden tracked model must not suppress the floor
      // Climbing past the tracked model's EXIT ceiling leaves `_trackedModel`
      // alive with show=false (the driver hides it, it is not destroyed), and
      // the tracked billboard becomes the visual again. Gating the clamp on
      // model EXISTENCE put the burial straight back in exactly that state.
      //
      // This scenario also pins the toggle contract itself. The DISPLAY-rail
      // "3D" toggle stays OFF for the whole block on purpose: it governs the
      // FLEET's draw-call budget only, and the tracked contact must still take
      // its model on zoom without the operator arming anything.
      const dfRetained = await evalPage(async () => {
        const v = window.__godsEyeView.viewer;
        const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
        const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
        const gf = window.__dfGf;
        const cell = (x) => Number(x.toFixed(3));
        // This scenario INHERITS the open deterministic skin from the block
        // above and closes it partway through, once its own model is up. The
        // close is repeated in a finally because the skip return between here
        // and there would otherwise hand an open skin to the seeded scenarios
        // that follow; closing an already-closed skin is inert.
        try {
        // Toggle OFF throughout — the tracked model must not need it.
        fl.setParams({ models3d: false });
        const toggleOff = fl.getParams().models3d === false;
        if (!fl.trackById('aaa097')) return { error: 'trackById(aaa097) failed' };
        await window.__dfSettle(600);
        // Below the ENTER ceiling (trackById re-frames to the close follow
        // range): the tracked model arrives on zoom alone, toggle still off.
        const belowH = await window.__dfZoomBelow(window.__dfRegime.enter - 20000);
        const withModel = await window.__dfAwaitTrackedModel('aaa097', 20000);
        // Same split as the regime scenario: a browser with no usable GLB
        // backend skips; models rendering under someone else's pick id must
        // reach the assertions and fail there.
        if (!withModel.rendering && !window.__dfCountModels().rendering) {
          fl.stopTracking();
          return { skipped: 'no tracked model rendered in this browser' };
        }
        // While the model IS the visual the clamp must stand aside (T7).
        const entWith = v.trackedEntity?.position?.getValue(Cesium.JulianDate.now());
        const withModelH = entWith ? window.__dfCarto(entWith).h : null;
        // Close the deterministic skin again for the rest of the group. The
        // model is up on a snap that is already cached, so it stays up until the
        // regime hides it; what this prevents is a live sample latching into the
        // floor cells that the planted seeds below are about to own.
        window.__dfSkinM = null;
        // Now climb past the EXIT ceiling: the model object is RETAINED but
        // hidden, and the billboard is the visual again.
        const aboveH = await window.__dfZoomAbove(window.__dfRegime.exit + 5000);
        await window.__dfSettle(1500);
        // aaa097's own model only: "retained but hidden" is a claim about THIS
        // contact's primitive, and an unrelated model in the scene must not be
        // able to answer it either way.
        const afterOut = window.__dfCountModels('aaa097');
        const ent = v.trackedEntity?.position?.getValue(Cesium.JulianDate.now());
        const c = ent ? window.__dfCarto(ent) : null;
        // Plant a floor above wherever it now renders so "floored" is decisive.
        // Mesh cells latch ONE-SHOT, so the earlier scenario's seed would win
        // this block silently — clear first, then plant.
        gf._clearMeshFloorCellsForTest();
        const seeded = (c ? c.h : 0) + 35;
        if (c) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              gf.reportMeshFloorCell(cell(c.lat) + dy * 0.001, cell(c.lon) + dx * 0.001, seeded);
            }
          }
        }
        // The viewer is request-render driven. Directly seeding the test seam
        // does not itself schedule a frame, so explicitly request one before
        // reading the CallbackProperty again. Production floor warming already
        // runs inside the app's render/update lifecycle; this keeps the harness
        // from mistaking a cached same-frame position for a failed clamp.
        v.scene.requestRender();
        await window.__dfSettle(900);
        const ent2 = v.trackedEntity?.position?.getValue(Cesium.JulianDate.now());
        const c2 = ent2 ? window.__dfCarto(ent2) : null;
        const out = {
          toggleOff,
          enter: window.__dfRegime.enter,
          exit: window.__dfRegime.exit,
          belowH,
          aboveH,
          modelsRenderingBelow: withModel.rendering,
          withModelH,
          hiddenModelsAbove: afterOut.hidden,
          shownModelsAbove: afterOut.shown,
          beforeSeedH: c ? c.h : null,
          seeded,
          afterSeedH: c2 ? c2.h : null,
        };
        // Hand the camera back to the CLOSE follow range before releasing. The
        // LOADING scenario below needs BOTH an active tracked regime and a
        // fleet model for this contact, and the fleet only admits models within
        // MODEL_PROX_ADD_M of the camera — parking just inside the enter
        // ceiling satisfies the regime but sits outside that add radius, which
        // silently starved the fleet half into a skip.
        await window.__dfZoomBelow(belowH + 500);
        fl.stopTracking();
        await window.__dfSettle(300);
        return out;
        } finally {
          window.__dfSkinM = null;
        }
      });

      if (dfRetained.skipped) {
        skip('display-floor: retained-but-hidden tracked model still floors the billboard',
          dfRetained.skipped);
      } else {
        record('display-floor/T7: while the tracked MODEL is the visual, the clamp stands aside',
          !dfRetained.error && dfRetained.modelsRenderingBelow > 0,
          dfRetained.error
            || `${dfRetained.modelsRenderingBelow} aaa097 model(s) rendering at ${(dfRetained.belowH / 1000).toFixed(0)} km with the 3D toggle OFF; entity at ${Number(dfRetained.withModelH).toFixed(1)} m (ground-snap owns it)`);

        // The toggle contract after auto-3D (2026-08-20): the DISPLAY-rail "3D"
        // switch owns the FLEET only. The tracked contact's model is default-on
        // and decided purely by camera distance, so with the toggle OFF it is
        // SHOWN below the enter ceiling and handed back above the exit ceiling —
        // and handed back by HIDING, not destroying, which is the retained state
        // the floor pin below depends on.
        record('display-floor/regime: the 3D toggle governs the FLEET only — the tracked model follows the zoom',
          !dfRetained.error && dfRetained.toggleOff === true
            && dfRetained.modelsRenderingBelow > 0
            && dfRetained.belowH < dfRetained.enter
            && dfRetained.shownModelsAbove === 0
            && dfRetained.hiddenModelsAbove > 0
            && dfRetained.aboveH > dfRetained.exit,
          dfRetained.error
            || `toggle OFF throughout: at ${(dfRetained.belowH / 1000).toFixed(0)} km (< ${(dfRetained.enter / 1000).toFixed(0)} km enter) ${dfRetained.modelsRenderingBelow} aaa097 model(s) rendering; at ${(dfRetained.aboveH / 1000).toFixed(0)} km (> ${(dfRetained.exit / 1000).toFixed(1)} km exit) ${dfRetained.shownModelsAbove} shown / ${dfRetained.hiddenModelsAbove} retained-hidden`);

        record('display-floor: a retained-but-hidden tracked model does NOT suppress the floor',
          Number.isFinite(dfRetained.afterSeedH)
            && dfRetained.afterSeedH >= dfRetained.seeded + DISPLAY_FLOOR_LIFT_M - 0.5,
          `${Number(dfRetained.beforeSeedH).toFixed(1)} m → ${Number(dfRetained.afterSeedH).toFixed(1)} m on a ${Number(dfRetained.seeded).toFixed(1)} m floor (${dfRetained.hiddenModelsAbove} model object(s) still retained, hidden by the zoom regime)`);
      }

      // ---- F3: the LOADING window is billboard-owned, not model-owned ------
      // A fleet model is registered with Cesium's default show=true the instant
      // its glTF resolves, but the handoff waits for `ready`; and a tracked
      // model is null for the whole load even though the regime is already
      // active. Both windows leave the BILLBOARD as the visual, so both must
      // stay floored — ownership means actually rendering.
      const dfLoading = await evalPage(async () => {
        const v = window.__godsEyeView.viewer;
        const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
        const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
        const gf = window.__dfGf;
        const cell = (x) => Number(x.toFixed(3));
        const floorAround = (c, seeded) => {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              gf.reportMeshFloorCell(cell(c.lat) + dy * 0.001, cell(c.lon) + dx * 0.001, seeded);
            }
          }
        };
        const out = {};

        // (a) FLEET: reach the real admitted-but-not-ready window. A fleet model
        // is registered in `_models` with Cesium's default show=true the moment
        // its glTF resolves, while the billboard handoff waits for `ready` — so
        // for a tick the model claims the visual it is not drawing. That window
        // is ~one fleet tick wide, so hold the state open by shadowing the two
        // flags on the instance (the same defineProperty trick the ground-3d
        // group uses on `tilesLoaded`).
        const findFleetModel = (id) => {
          let found = null;
          const walk = (coll) => {
            const len = coll.length;
            for (let i = 0; i < len; i++) {
              let p; try { p = coll.get(i); } catch { continue; }
              if (!p) continue;
              if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
              if (p.activeAnimations !== undefined && p.minimumPixelSize !== undefined && p.id === id) found = p;
            }
          };
          walk(v.scene.primitives);
          return found;
        };
        fl.setParams({ models3d: true });
        const fleetDeadline = Date.now() + 20000;
        let fleetModel = null;
        while (Date.now() < fleetDeadline && !(fleetModel = findFleetModel('aaa097'))) {
          await window.__dfSettle(500);
        }
        if (!fleetModel) {
          fl.setParams({ models3d: false });
          return { skipped: 'no fleet model for aaa097 in this browser' };
        }
        // Accessors with SWALLOWING setters, not data properties: the fleet tick
        // assigns `model.show = false` for a not-ready model, and assigning to a
        // non-writable own property throws in strict mode — which lands inside
        // Cesium's render loop and stops rendering for the rest of the run.
        Object.defineProperty(fleetModel, 'ready', { get: () => false, set: () => {}, configurable: true });
        Object.defineProperty(fleetModel, 'show', { get: () => true, set: () => {}, configurable: true });
        const bb = window.__dfFindBB('aaa097');
        if (!bb) return { error: 'aaa097 billboard missing' };
        bb.show = true; // the handoff would not have hidden it: the model is not ready
        const d0 = window.__dfCarto(bb.position);
        gf._clearMeshFloorCellsForTest();
        // Earlier display-floor scenarios deliberately leave this contact's
        // sticky-cell/rebuild cache populated. Reset that test-owned cache
        // before planting a different artificial floor in the same area, so
        // this case measures loading ownership instead of prior-scenario
        // hysteresis.
        fl._clearDisplayFloorStateForTest();
        const seededFleet = d0.h + 45;
        floorAround(d0, seededFleet);
        // reportMeshFloorCell is a direct test seam and does not schedule a
        // Cesium frame. Force the CallbackProperty to re-evaluate before the
        // assertion, matching the request-render fix in the retained-model
        // scenario above.
        v.scene.requestRender();
        await window.__dfSettle(900);
        const bbAfter = window.__dfFindBB('aaa097');
        out.fleetModelReady = fleetModel.ready;
        out.fleetModelShow = fleetModel.show;
        out.fleetBillboardVisible = !!bbAfter?.show;
        out.fleetSeeded = seededFleet;
        out.fleetH = bbAfter ? window.__dfCarto(bbAfter.position).h : null;
        delete fleetModel.ready;
        delete fleetModel.show;
        fl.setParams({ models3d: false });
        await window.__dfSettle(400);

        // (b) TRACKED, regime ACTIVE but no model yet. Turning 3D on while
        // tracking makes `_trackedModelRegimeActive()` true immediately; the
        // GLB load takes frames, and the tracked billboard is the visual until
        // it finishes. Sample within that window.
        if (!fl.trackById('aaa097')) return { ...out, error: 'trackById(aaa097) failed' };
        await window.__dfSettle(500);
        const entBefore = v.trackedEntity?.position?.getValue(Cesium.JulianDate.now());
        const cBefore = entBefore ? window.__dfCarto(entBefore) : null;
        gf._clearMeshFloorCellsForTest();
        fl._clearDisplayFloorStateForTest();
        const seededTracked = (cBefore ? cBefore.h : 0) + 45;
        if (cBefore) floorAround(cBefore, seededTracked);
        // Release the tracked model so the next regime activation must load
        // from scratch, then flip the regime on and sample IMMEDIATELY.
        fl.setParams({ models3d: false });
        await window.__dfSettle(400);
        fl.stopTracking();
        await window.__dfSettle(300);
        fl.trackById('aaa097');
        fl.setParams({ models3d: true });
        v.scene.requestRender();
        await new Promise((r) => setTimeout(r, 120)); // inside the load window
        const countRendering = () => {
          let n = 0;
          const walk = (coll) => {
            const len = coll.length;
            for (let i = 0; i < len; i++) {
              let p; try { p = coll.get(i); } catch { continue; }
              if (!p) continue;
              if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
              if (p.activeAnimations !== undefined && p.minimumPixelSize !== undefined
                && p.show && p.ready) n += 1;
            }
          };
          walk(v.scene.primitives);
          return n;
        };
        out.renderingModelsDuringLoad = countRendering();
        const entLoad = v.trackedEntity?.position?.getValue(Cesium.JulianDate.now());
        out.trackedSeeded = seededTracked;
        out.trackedLoadH = entLoad ? window.__dfCarto(entLoad).h : null;
        fl.setParams({ models3d: false });
        fl.stopTracking();
        await window.__dfSettle(300);
        return out;
      });

      if (dfLoading.skipped) {
        skip('display-floor/loading: fleet model loading window', dfLoading.skipped);
      } else {
        record('display-floor/loading: a fleet model that is shown-but-not-ready does not own the visual',
          !dfLoading.error && dfLoading.fleetModelShow === true && dfLoading.fleetModelReady === false
            && dfLoading.fleetBillboardVisible === true
            && Number.isFinite(dfLoading.fleetH)
            && dfLoading.fleetH >= dfLoading.fleetSeeded + DISPLAY_FLOOR_LIFT_M - 0.5,
          dfLoading.error
            || `model show=${dfLoading.fleetModelShow} ready=${dfLoading.fleetModelReady}, billboard visible=${dfLoading.fleetBillboardVisible} at ${Number(dfLoading.fleetH).toFixed(1)} m on a ${Number(dfLoading.fleetSeeded).toFixed(1)} m floor`);
      }

      record('display-floor/loading: tracked regime active with no rendering model stays floored',
        !dfLoading.error && dfLoading.renderingModelsDuringLoad === 0
          && Number.isFinite(dfLoading.trackedLoadH)
          && dfLoading.trackedLoadH >= dfLoading.trackedSeeded + DISPLAY_FLOOR_LIFT_M - 0.5,
        dfLoading.error
          || `rendering models during load=${dfLoading.renderingModelsDuringLoad}, entity at ${Number(dfLoading.trackedLoadH).toFixed(1)} m on a ${Number(dfLoading.trackedSeeded).toFixed(1)} m floor`);

      // ---- F5: a taxi-invalidated snap HOLDS, bounded by drift -------------
      // The gate above ("no evidence ⇒ no model") is right for a contact that
      // has NEVER resolved. Applied to one that HAS, it produces a new defect:
      // taxiing past groundSnap's 50 m resample threshold drops the cache, and
      // if the resample misses — tiles streaming, OSM fallback — the backoff is
      // 2–30 s, so the aircraft pops from 3D back to 2D and back again while it
      // rolls. The last MEASUREMENT is held through that instead, bounded by how
      // far the contact can have moved from where it was taken. Same answer the
      // billboard chain gives (`_heldDisplayFloorM`), a quarter of the distance,
      // because a held floor only ever RAISES a sprite while a held snap IS the
      // model's placement.
      //
      // Driven through the app's OWN handoff and its OWN groundSnap instance —
      // real Cesium primitive, real cache, real backoff. Only the position is
      // supplied by the harness rather than by the poll, which is exactly what a
      // taxi is; waiting out the 30 s render delay for the feed to move the
      // display would measure the same thing half a minute later.
      const dfHold = await evalPage(async () => {
        const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
        const v = window.__godsEyeView.viewer;
        const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
        // `.module` is the layer OBJECT (the default export), not the module
        // namespace, so the handoff seam is not on it. Reach the namespace the
        // same way this group reaches groundFloor's: offer the URL the app
        // itself loaded (Vite serves an edited file as `…?t=<hmr stamp>`, and
        // the plain path would hand back a second, unrelated instance whose
        // module state the app never touches), then prove identity by requiring
        // its default export to BE the live layer object.
        let ns = null;
        const urls = [...new Set([
          ...performance.getEntriesByType('resource').map((e) => e.name)
            .filter((n) => /\/src\/data\/flights\.js(\?|$)/.test(n)).reverse(),
          '/src/data/flights.js',
        ])];
        for (const url of urls) {
          let mod; try { mod = await import(/* @vite-ignore */ url); } catch { continue; }
          if (mod?.default === fl && typeof mod._driveFleetModelHandoffForTest === 'function') {
            ns = mod;
            break;
          }
        }
        if (!ns) return { skipped: `the app's own flights module was not reachable (tried ${urls.length})` };
        const bb = window.__dfFindBB('aaa097');
        if (!bb) return { error: 'aaa097 billboard missing' };
        const base = window.__dfCarto(bb.position);
        const basePos = Cesium.Cartesian3.fromDegrees(base.lon, base.lat, base.h);
        // Offered skin: unmistakably not the feed altitude, for the case where
        // this contact's cache is cold and a real sample has to fire.
        const skin = base.h + 60;

        // 1. Open a deterministic skin and let the REAL fleet tick admit, place
        //    and show the model — the arrival path this scenario then interrupts.
        //    (This contact's snap may already be warm from an earlier scenario,
        //    in which case the cache answers and the offered skin never fires.
        //    Either way what the model stands on is a MEASUREMENT, which is the
        //    only property the hold below is about.)
        window.__dfSkinM = skin;
        fl.setParams({ models3d: true });
        const up = await window.__dfAwaitTrackedModel('aaa097', 20000);
        if (!up.rendering) {
          window.__dfSkinM = null;
          fl.setParams({ models3d: false });
          return { skipped: 'no fleet model rendered for aaa097 in this browser' };
        }
        // The model-availability warm-up above may reuse aaa097's snap from an
        // earlier display-floor case. That makes this scenario order-dependent:
        // a later cell can correctly contradict that unrelated measurement and
        // turn the intended outage hold into a different product rule. Start
        // this case with its own snap and no independent mesh evidence; the
        // next handoff must therefore measure the open deterministic skin.
        fl._clearGroundSnapStateForTest();
        window.__dfGf._clearMeshFloorCellsForTest();
        // Re-drive at the position this scenario will measure taxi distance
        // from. With the scenario-owned caches cold, this fills the snap from
        // the deterministic skin above rather than inheriting earlier state.
        const freshOwns = ns._driveFleetModelHandoffForTest({ icao24: 'aaa097', position: basePos, course: 90 });
        const freshH = window.__dfModelHeight('aaa097');

        // 2. The tiles go away and the contact taxis ~96 m — past the 50 m
        //    resample threshold, inside the hold bound. Every resample from here
        //    misses, so this is the whole backoff window in one call.
        window.__dfSkinM = null;
        const taxiPos = Cesium.Cartesian3.fromDegrees(base.lon + 0.001, base.lat, base.h);
        // What independent evidence says about each spot. A held snap now loses
        // to a MEASURED floor at the contact's current cell that disagrees with
        // it (groundSnap.HELD_SNAP_CONTRADICTION_M), so if this group has
        // planted a floor at the taxi cell, that is what decides the outcome —
        // and the numbers have to be visible or the failure is unreadable.
        const gfns = window.__dfGf;
        const baseCarto = window.__dfCarto(basePos);
        const taxiCarto = window.__dfCarto(taxiPos);
        const baseMeshM = gfns?.cachedMeshFloor?.(baseCarto.lat, baseCarto.lon) ?? null;
        const taxiMeshM = gfns?.cachedMeshFloor?.(taxiCarto.lat, taxiCarto.lon) ?? null;
        const heldOwns = ns._driveFleetModelHandoffForTest({ icao24: 'aaa097', position: taxiPos, course: 90 });
        const heldH = window.__dfModelHeight('aaa097');
        const heldBb = !!window.__dfFindBB('aaa097')?.show;

        // 3. ~385 m out the memory stops describing anywhere this contact has
        //    been. It is released rather than stretched, and the gate takes over.
        const farPos = Cesium.Cartesian3.fromDegrees(base.lon + 0.004, base.lat, base.h);
        const releasedOwns = ns._driveFleetModelHandoffForTest({ icao24: 'aaa097', position: farPos, course: 90 });
        const releasedBb = !!window.__dfFindBB('aaa097')?.show;

        fl.setParams({ models3d: false });
        await window.__dfSettle(300);
        return {
          freshOwns,
          freshH,
          heldOwns,
          heldH,
          heldBb,
          baseMeshM,
          taxiMeshM,
          releasedOwns,
          releasedBb,
          taxiM: Cesium.Cartesian3.distance(
            Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(basePos, new Cesium.Cartesian3()),
            Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(taxiPos, new Cesium.Cartesian3()),
          ),
          farM: Cesium.Cartesian3.distance(
            Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(basePos, new Cesium.Cartesian3()),
            Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(farPos, new Cesium.Cartesian3()),
          ),
        };
      });

      if (dfHold.skipped) {
        skip('display-floor/hold: a taxi-invalidated ground snap holds the model through the resample backoff',
          dfHold.skipped);
      } else {
        // The taxi has to actually cross the threshold, or the rest proves
        // nothing: > 50 m invalidates, < 250 m is still inside the bound.
        record('display-floor/hold: the taxi really does invalidate, and the far step really does exceed the bound',
          !dfHold.error && dfHold.taxiM > 50 && dfHold.taxiM < 250 && dfHold.farM > 250,
          dfHold.error || `taxi ${Number(dfHold.taxiM).toFixed(1)} m (> 50 m invalidate, < 250 m bound), far step ${Number(dfHold.farM).toFixed(1)} m (> 250 m bound)`);

        record('display-floor/hold: a taxi-invalidated ground snap holds the model through the resample backoff',
          !dfHold.error && dfHold.freshOwns === true && dfHold.heldOwns === true
            && dfHold.heldBb === false
            && dfHold.taxiMeshM == null
            && Number.isFinite(dfHold.heldH) && Number.isFinite(dfHold.freshH)
            && Math.abs(dfHold.heldH - dfHold.freshH) < 0.5,
          dfHold.error || `fresh owns=${dfHold.freshOwns} on a MEASURED floor at ${Number(dfHold.freshH).toFixed(1)} m; tiles gone + ${Number(dfHold.taxiM).toFixed(1)} m taxi → owns=${dfHold.heldOwns} at ${Number(dfHold.heldH).toFixed(1)} m, billboard shown=${dfHold.heldBb} (want owns=true, bb=false: no 3D→2D pop). Independent mesh floor: base=${dfHold.baseMeshM == null ? 'cold' : Number(dfHold.baseMeshM).toFixed(1)} m, taxi=${dfHold.taxiMeshM == null ? 'cold' : Number(dfHold.taxiMeshM).toFixed(1)} m`);

        record('display-floor/hold: past the drift bound the hold is released and the model is withheld',
          !dfHold.error && dfHold.releasedOwns === false && dfHold.releasedBb === true,
          dfHold.error || `${Number(dfHold.farM).toFixed(1)} m from the sample: model owns=${dfHold.releasedOwns}, billboard back at shown=${dfHold.releasedBb}`);
      }


    }

    // Cleanup: drop the synthetics and the seeded cells so nothing leaks into
    // the run-wide console/HTTP checks below.
    await evalPage(async () => {
      const v = window.__godsEyeView.viewer;
      const fl = window.__godsEyeView.dataManager.layers.get('flights').module;
      window.__SYNTH.flights = window.__SYNTH.flights.filter((f) => !/^aaa09/.test(f.icao));
      fl.stopTracking();
      window.__dfGf?._clearMeshFloorCellsForTest();
      delete v.scene.sampleHeight;
      await fl.update(v);
    });



    // Harness hardening (2026-07-06): the two earlier console-error checks run
    // BEFORE the ground/ground-3d/arrival groups — an exception thrown in
    // those later scenarios (e.g. inside a fleet tick) was invisible and
    // surfaced only as inexplicable downstream assertion failures. Catch-all.
    record('no console errors across the FULL run (late groups included)', consoleErrors.length === 0,
      consoleErrors.length
        ? `${consoleErrors.length}: ${consoleErrors.slice(-3).join(' | ')}`
        : 'clean');
    record('no HTTP 5xx responses across the FULL run', failedResponses.length === 0,
      failedResponses.length
        ? `${failedResponses.length}: ${failedResponses.slice(-3).join(' | ')}`
        : 'clean');

    finishAndExit();
  } finally {
    if (!KEEP_OPEN) {
      await browser.close();
    } else {
      console.log('\n--keep-open set; leaving browser running. Ctrl-C to exit.');
    }
  }

  function finishAndExit() {
    const failed = results.filter((r) => r.ok === false);
    const passed = results.filter((r) => r.ok === true);
    const skipped = results.filter((r) => r.ok === null);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  RESULT: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
    console.log(`${'─'.repeat(60)}\n`);
    process.exitCode = failed.length > 0 ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Frame sampler: run `sampleFn` once per render frame for `count` frames,
// in the page, collecting its numeric return (or null).
// ---------------------------------------------------------------------------
async function sampleFrames(page, count, sampleFn, ...args) {
  const { values, timedOut } = await page.evaluate(async (fnStr, n, extra) => {
    const fn = new Function('return (' + fnStr + ')')();
    const v = window.__godsEyeView.viewer;
    const out = [];
    let timedOut = false;
    await new Promise((resolve) => {
      let i = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        remove();
        resolve();
      };
      const remove = v.scene.postRender.addEventListener(() => {
        try { out.push(fn(...extra)); } catch (e) { out.push(null); }
        if (++i >= n) {
          finish();
          return;
        }
        // Cesium runs with requestRenderMode enabled, so one request produces
        // one postRender callback. Drive every sample explicitly instead of
        // waiting forever after the first frame.
        v.scene.requestRender();
      });
      const timer = setTimeout(() => {
        timedOut = true;
        finish();
      }, Math.max(15000, n * 1500));
      v.scene.requestRender();
    });
    return { values: out, timedOut };
  }, sampleFn.toString(), count, args);
  return { values, timedOut };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Great-circle surface distance (m) between two lat/lon points (small-angle safe). */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Poll a node-side predicate.
function waitFor(pred, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

main().catch((err) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', err && err.stack ? err.stack : err);
  process.exit(2);
});
