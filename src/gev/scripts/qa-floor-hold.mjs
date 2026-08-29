#!/usr/bin/env node
/**
 * scripts/qa-floor-hold.mjs — a grounded contact holds its floor through a
 * terrain-proxy outage (field incident, 2026-08-21).
 *
 * Reproduces the incident end to end against the RENDERED mesh:
 *
 *   phase A  the terrain proxy is healthy. A GROUNDED contact reporting no
 *            altitude at all (the AXEL21 profile — a few knots, alt unknown)
 *            settles onto its resolved floor.
 *   phase B  every `/api/terrain/heights` request answers 504 — the same
 *            "[terrain-heights-proxy] refresh incomplete" the server logged —
 *            and the contact taxis into cells that were never warmed.
 *
 * The contact must stay ON the mesh through phase B. Without the hold it falls
 * to the geoid, which at an inland field is ~150 m of burial.
 *
 *   node scripts/qa-floor-hold.mjs                       # real GPU (ANGLE/Metal)
 *   node scripts/qa-floor-hold.mjs --headful             # watch it
 *   QA_BASE_URL=http://localhost:4257 node scripts/qa-floor-hold.mjs
 *
 * GPU BACKEND MATTERS. `scene.sampleHeight` answers on both backends, but
 * software rasterization streams a coarser LOD. Measured directly, one probe
 * point on the Austin apron read ~20.9 m under swiftshader against ~168.4 m
 * under Metal — a backend comparison at one point, not to be confused with the
 * same-backend run-to-run spread (122.1 m vs 20.6 m on a cell centre) that
 * retired the hold chain's unvalidated tier. The
 * default is the real GPU. Under `--angle=swiftshader` the rendered-mesh oracle
 * is reported as unavailable rather than trusted, and the run falls back to the
 * bare-earth DEM (fetched server-side, so the simulated outage cannot reach
 * it) — a weaker but still decisive check, since the geoid sits ~150 m below it.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const APP_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
const argv = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const ANGLE = String(argv.angle || 'metal');
const HEADFUL = !!argv.headful;
// Austin airport apron by default — the site qa-floor-verify pins, where the
// mesh sits ~150 m above the geoid and burial is unmistakable.
const SITE = {
  lat: Number.isFinite(Number(argv.lat)) ? Number(argv.lat) : 30.1975,
  lon: Number.isFinite(Number(argv.lon)) ? Number(argv.lon) : -97.6660,
};
const ICAO = 'aa0f01';
const OUT_DIR = 'qa-shots/floorhold';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${detail ? `  — ${detail}` : ''}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const chrome = (() => { try { return puppeteer.executablePath(); } catch { return undefined; } })();
const browser = await puppeteer.launch({
  headless: HEADFUL ? false : 'new',
  executablePath: chrome,
  args: ['--use-gl=angle', `--use-angle=${ANGLE}`, '--enable-webgl',
    '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.evaluateOnNewDocument((site, icao) => {
  window.__CONTACT = { icao, lat: site.lat, lon: site.lon };
  window.__TERRAIN = { ok: 0, failed: 0 };
  window.__TERRAIN_FAIL = false;
  const realFetch = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  window.fetch = (input, init) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let url; try { url = new URL(raw, window.location.href); } catch { return realFetch(input, init); }
    const app = url.origin === window.location.origin;
    if (app && url.pathname === '/api/terrain/heights') {
      if (window.__TERRAIN_FAIL) {
        window.__TERRAIN.failed += 1;
        return Promise.resolve(new Response('upstream timeout', { status: 504 }));
      }
      window.__TERRAIN.ok += 1;
      return realFetch(input, init);
    }
    if (app && url.pathname === '/api/opensky') {
      const c = window.__CONTACT;
      const t = Math.floor(Date.now() / 1000);
      // baro_altitude (7) and geo_altitude (13) both null, on_ground true.
      return Promise.resolve(json({
        time: t,
        states: [[c.icao, 'AXEL21', 'Synthetica', t, t, c.lon, c.lat,
          null, true, 1.5, 90, 0, null, null, null, false, 0]],
      }));
    }
    if (app && url.pathname === '/api/opensky-track') return Promise.resolve(json({ path: [] }));
    if (app && /^\/api\/adsbdb\//.test(url.pathname)) return Promise.resolve(json({}));
    return realFetch(input, init);
  };
}, SITE, ICAO);

console.log(`\nFloor hold through a terrain outage\n  App  : ${APP_URL}\n  GPU  : ANGLE/${ANGLE}\n  Site : ${SITE.lat}, ${SITE.lon}\n`);
await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
  { timeout: 150000 });
await sleep(12000); // let the boot fly-to settle before pinning

await page.evaluate((site) => { window.__SITE = site; }, SITE);
const pin = () => page.evaluate(() => {
  const v = window.__godsEyeView.viewer;
  const C = v.camera.positionCartographic.constructor;
  v.camera.cancelFlight();
  v.camera.setView({
    destination: v.scene.globe.ellipsoid.cartographicToCartesian(
      C.fromDegrees(window.__SITE.lon, window.__SITE.lat - 0.008, 900),
    ),
    orientation: { heading: 0, pitch: -0.45, roll: 0 },
  });
  v.camera.moveEnd.raiseEvent();
});
await pin();
await page.evaluate(async () => { await window.__godsEyeView.dataManager.toggle('flights'); });

/** Reads the contact's rendered height and the rendered mesh beneath it. */
const measure = () => page.evaluate(async (icao) => {
  const v = window.__godsEyeView.viewer;
  const C = v.camera.positionCartographic.constructor;
  const sprites = []; const models = []; let bb = null;
  const walk = (coll) => {
    for (let i = 0; i < coll.length; i++) {
      let p; try { p = coll.get(i); } catch { continue; }
      if (!p) continue;
      if (typeof p.length === 'number' && typeof p.get === 'function') { walk(p); continue; }
      if (p.image !== undefined && p.alignedAxis !== undefined) {
        sprites.push(p); if (p.id === icao) bb = p;
      } else if (p.boundingSphere && p.modelMatrix) models.push(p);
    }
  };
  try { walk(v.scene.primitives); } catch { /* mid-teardown */ }
  if (!bb?.position) return { error: 'contact billboard not found' };
  const carto = C.fromCartesian(bb.position);
  const lat = carto.latitude * 180 / Math.PI;
  const lon = carto.longitude * 180 / Math.PI;
  // `sampleHeight` runs an offscreen PICK pass, so it needs the scene to be
  // rendering. This app parks its render loop when idle (the wave-2 governor),
  // and a probe fired against a parked scene — or one whose tiles are still
  // streaming after a camera move — reads `undefined`. Pump a frame through the
  // app's own governor hook before each attempt, exactly as the fly_route
  // harness does, and accept the coarse cell centre as a fallback point.
  const pump = () => new Promise((resolve) => {
    try { window.__godsEyeView.requestRender?.(); } catch { /* no governor */ }
    try { v.scene.requestRender(); } catch { /* explicit-render off */ }
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  let mesh = null;
  for (let attempt = 0; attempt < 10 && mesh == null; attempt += 1) {
    await pump();
    for (const [pLat, pLon] of [[lat, lon], [+lat.toFixed(3), +lon.toFixed(3)]]) {
      for (const exclude of [[...sprites, ...models], []]) {
        try {
          const h = v.scene.sampleHeight(C.fromDegrees(pLon, pLat, 0), exclude);
          if (Number.isFinite(h)) { mesh = h; break; }
        } catch { /* mid-stream */ }
      }
      if (mesh != null) break;
    }
    if (mesh == null) await new Promise((r) => setTimeout(r, 1200));
  }
  return {
    spriteH: carto.height, meshH: mesh, shown: bb.show === true,
    lat: +lat.toFixed(5), lon: +lon.toFixed(5), terrain: { ...window.__TERRAIN },
  };
}, ICAO);

/** Bare-earth ground truth, fetched SERVER-SIDE so the page's simulated outage
 *  cannot touch it. The photoreal mesh sits ABOVE bare earth, so this is the
 *  weaker of the two oracles — but the geoid is ~150 m below it, so burial is
 *  still unmistakable. */
const truth = new Map();
async function demTruth(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (truth.has(key)) return truth.get(key);
  let h = null;
  try {
    const res = await fetch(`${APP_URL}/api/terrain/heights?points=${lon.toFixed(5)},${lat.toFixed(5)}`);
    if (res.ok) {
      const v = Number((await res.json())?.results?.[0]?.ellipsoid);
      if (Number.isFinite(v)) h = v;
    }
  } catch { /* the oracle is best-effort too */ }
  truth.set(key, h);
  return h;
}

const samples = [];
async function sample(phase, note) {
  const m = await measure();
  if (m.error) { console.log(`  ${phase} ${note}: ${m.error}`); return null; }
  const dem = await demTruth(m.lat, m.lon);
  const row = {
    phase, note, ...m, demH: dem,
    meshClearM: m.meshH != null ? +(m.spriteH - m.meshH).toFixed(2) : null,
    demClearM: dem != null ? +(m.spriteH - dem).toFixed(2) : null,
  };
  samples.push(row);
  console.log(`  ${phase} ${note}: @${m.lat},${m.lon} sprite=${m.spriteH.toFixed(1)}`
    + ` mesh=${m.meshH?.toFixed?.(1) ?? 'n/a'} (${row.meshClearM})`
    + ` DEM=${dem?.toFixed?.(1) ?? 'n/a'} (${row.demClearM})`
    + ` terrain=${JSON.stringify(m.terrain)}`);
  return row;
}

console.log('\nphase A — terrain healthy, warming cells (3 polls)');
for (let i = 0; i < 3; i++) { await sleep(32000); await pin(); }
await sample('A', 'warm');
fs.writeFileSync(path.join(OUT_DIR, `hold-A-warm-${ANGLE}.png`), await page.screenshot({ type: 'png' }));

console.log('\nphase B — every terrain request answers 504 from here');
await page.evaluate(() => { window.__TERRAIN_FAIL = true; });
for (let i = 1; i <= 4; i++) {
  await page.evaluate(() => { window.__CONTACT.lon += 0.0016; }); // ~150 m east per poll
  await sleep(32000);
  await pin();
  await sample('B', `poll+${i}`);
}
fs.writeFileSync(path.join(OUT_DIR, `hold-B-outage-${ANGLE}.png`), await page.screenshot({ type: 'png' }));
await browser.close();

console.log('');
const outage = samples.filter((s) => s.phase === 'B');
const meshRows = outage.filter((s) => s.meshClearM != null);
const demRows = outage.filter((s) => s.demClearM != null);
record('the terrain proxy really went down mid-run',
  outage.length > 0 && outage[outage.length - 1].terrain.failed > 0,
  `${outage[outage.length - 1]?.terrain?.failed ?? 0} requests answered 504`);
record('the contact stayed visible throughout', outage.every((s) => s.shown === true));
if (meshRows.length) {
  const worst = Math.min(...meshRows.map((s) => s.meshClearM));
  record('the contact never rendered below the RENDERED MESH', worst >= -0.5,
    `worst clearance ${worst} m across ${meshRows.length} samples`);
} else {
  record('rendered-mesh oracle available', false,
    `sampleHeight never answered on ANGLE/${ANGLE} — falling back to the bare-earth DEM`);
}
if (demRows.length) {
  const worst = Math.min(...demRows.map((s) => s.demClearM));
  record('the contact never fell to the geoid (bare-earth DEM oracle)', worst >= -2,
    `worst clearance ${worst} m above bare earth; the geoid here is ~150 m below it`);
}
fs.writeFileSync(path.join(OUT_DIR, `hold-${ANGLE}.json`), JSON.stringify(samples, null, 2));
console.log(`\n  evidence: ${OUT_DIR}/hold-*-${ANGLE}.png, ${OUT_DIR}/hold-${ANGLE}.json`);

const failed = results.filter((r) => r.ok === false).length;
console.log(`\n  RESULT: ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
