// scripts/qa-floor-verify.mjs — live floor verification at AUS (round 5).
// Pins the camera at Austin airport, enables flights, waits ~3 polls, then
// measures every nearby contact's ACTUAL visible anchor against the rendered
// mesh (sprite- and model-excluded scene.sampleHeight probes). Model-owned
// contacts deliberately keep their hidden billboard at the raw sensor datum,
// so getNearby().position is not a render-height oracle for those contacts.
// Caught the mesh-latch coarse-LOD poison and the taxiing cold-cell regression
// on 2026-07-06.
// Run: node scripts/qa-floor-verify.mjs   (dev server on :4173, real GPU best)
// with the poison fix + simplified chain live.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

// QA_BASE_URL matches the sibling harnesses (qa-height-datum / qa-cctv-v2) so
// each candidate can verify against its own dev server instead of :4173.
const APP_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
// CLI: --lat --lon --floor-min --floor-max (defaults: Austin airport)
const argv = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.replace(/^--/, ''), Number(v)]));
const SITE = {
  lat: Number.isFinite(argv.lat) ? argv.lat : 30.197,
  lon: Number.isFinite(argv.lon) ? argv.lon : -97.666,
  floorMin: Number.isFinite(argv['floor-min']) ? argv['floor-min'] : 100,
  floorMax: Number.isFinite(argv['floor-max']) ? argv['floor-max'] : 250,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Prefer puppeteer's version-pinned Chrome-for-Testing over the system Chrome
// (2026-07-30 lesson, already applied to the other harnesses): /Applications
// auto-updates underneath the harnesses and its software-GL behavior shifts
// across majors.
const chrome = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find((p) => fs.existsSync(p));

const browser = await puppeteer.launch({
  headless: 'new', executablePath: chrome,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.dataManager && window.__godsEyeView?.viewer, { timeout: 150000 });
await sleep(2000);

// Let the app's boot fly-to fully settle FIRST (it was overriding an early
// setView, leaving the camera away from Austin — every probe then read
// coarse global tiles at ~25 m and the oracle was garbage).
await sleep(12000);
await page.evaluate((site) => { window.__QA_SITE = site; }, SITE);
const camPin = async () => page.evaluate(() => {
  const v = window.__godsEyeView.viewer;
  const C = v.camera.positionCartographic.constructor;
  v.camera.cancelFlight();
  v.camera.setView({ destination: v.scene.globe.ellipsoid.cartographicToCartesian(C.fromDegrees(window.__QA_SITE.lon, window.__QA_SITE.lat, 3000)) });
  v.camera.moveEnd.raiseEvent();
  const c = v.camera.positionCartographic;
  return { lat: +(c.latitude * 180 / Math.PI).toFixed(3), lon: +(c.longitude * 180 / Math.PI).toFixed(3), h: Math.round(c.height) };
});
console.log('camera pinned:', JSON.stringify(await camPin()));
await page.evaluate(async () => { await window.__godsEyeView.dataManager.toggle('flights'); });
console.log('waiting 100s: tiles stream + 3 polls...');
await sleep(100000);
// re-pin + report readiness right before probing
console.log('camera at probe time:', JSON.stringify(await camPin()));
const ready = await page.evaluate(() => {
  const v = window.__godsEyeView.viewer;
  const prims = v.scene.primitives;
  for (let i = 0; i < prims.length; i++) {
    const p = prims.get(i);
    if (p && p.tilesLoaded !== undefined && p.show) return { tilesLoaded: !!p.tilesLoaded };
  }
  return { tilesLoaded: null };
});
console.log('tileset ready:', JSON.stringify(ready));
await sleep(8000);

const report = await page.evaluate(() => {
  const gev = window.__godsEyeView;
  const v = gev.viewer;
  const layer = gev.dataManager.layers.get('flights')?.module;
  if (!layer) return { err: 'no flights module' };
  const ell = v.scene.globe.ellipsoid;
  const C = v.camera.positionCartographic.constructor;
  const center = ell.cartographicToCartesian(C.fromDegrees(window.__QA_SITE.lon, window.__QA_SITE.lat, 200));
  const nearby = layer.getNearby(center, 15000, 60);
  // getNearby() intentionally reports the raw hidden-billboard position for an
  // untracked contact whose 3D model owns the visual. The detection surface is
  // already welded to whichever primitive actually owns that visual: model
  // centre, tracked visual, or billboard. Reuse that production render anchor
  // here instead of treating the deliberately unfloored raw datum as buried.
  const visualByIcao = new Map(layer.getDetectableObjects().map((object) => [
    String(object.sourceId || '').trim().toLowerCase(),
    object.position,
  ]));
  // Exclude EVERY billboard from the probes — sprites are pickable, so an
  // unexcluded probe can return another aircraft's height as "the mesh".
  // Exclude every fleet/tracked 3D Model too: getNearby() also returns contacts
  // whose billboard is hidden because a model owns the visual, and those probes
  // would otherwise land on aircraft geometry. `activeAnimations` +
  // `minimumPixelSize` are Model-only — the 3D-Tiles tileset has neither, and
  // excluding IT would leave sampleHeight with no mesh to read at all.
  const excludes = [];
  const walk = (coll) => {
    const n = coll.length;
    for (let i = 0; i < n; i++) {
      let pr; try { pr = coll.get(i); } catch { continue; }
      if (!pr) continue;
      if (typeof pr.length === 'number' && typeof pr.get === 'function') { walk(pr); continue; }
      if (pr.image !== undefined && pr.alignedAxis !== undefined) { excludes.push(pr); continue; }
      if (pr.activeAnimations !== undefined && pr.minimumPixelSize !== undefined) excludes.push(pr);
    }
  };
  walk(v.scene.primitives);
  const out = [];
  for (const p of nearby) {
    const raw = ell.cartesianToCartographic(p.position);
    const visualPosition = visualByIcao.get(String(p.icao24 || '').trim().toLowerCase());
    if (!visualPosition) {
      out.push({
        id: p.id,
        icao24: p.icao24,
        rawDatumAltM: +raw.height.toFixed(1),
        renderAltM: null,
        meshM: null,
        aboveMeshM: null,
        visualOffsetM: null,
        missingVisualAnchor: true,
      });
      continue;
    }
    const visual = ell.cartesianToCartographic(visualPosition);
    const latDeg = visual.latitude * 180 / Math.PI, lonDeg = visual.longitude * 180 / Math.PI;
    let meshH = null;
    try {
      const h = v.scene.sampleHeight(C.fromDegrees(lonDeg, latDeg), excludes);
      if (Number.isFinite(h)) meshH = h;
    } catch { /* ignore */ }
    out.push({
      id: p.id,
      icao24: p.icao24,
      rawDatumAltM: +raw.height.toFixed(1),
      renderAltM: +visual.height.toFixed(1),
      meshM: meshH != null ? +meshH.toFixed(1) : null,
      aboveMeshM: meshH != null ? +(visual.height - meshH).toFixed(1) : null,
      visualOffsetM: +(visual.height - raw.height).toFixed(1),
      missingVisualAnchor: false,
    });
  }
  // Visibility census (round 6): getNearby only returns contacts a sprite or a
  // 3D model is actually drawing, so also walk the raw collections — a culled
  // "invisible plane" shows up here.
  let shown = 0, hidden = 0;
  const censusWalk = (coll) => {
    const n = coll.length;
    for (let i = 0; i < n; i++) {
      let pr; try { pr = coll.get(i); } catch { continue; }
      if (!pr) continue;
      if (typeof pr.length === 'number' && typeof pr.get === 'function') { censusWalk(pr); continue; }
      if (pr.image === undefined || pr.alignedAxis === undefined) continue;
      const cc = ell.cartesianToCartographic(pr.position);
      const la = cc.latitude * 180 / Math.PI, lo = cc.longitude * 180 / Math.PI;
      if (Math.abs(la - window.__QA_SITE.lat) > 0.08 || Math.abs(lo - window.__QA_SITE.lon) > 0.10) continue;
      if (pr.show) shown++; else hidden++;
    }
  };
  censusWalk(v.scene.primitives);
  return {
    ausContacts: out.length,
    contacts: out,
    missingVisualAnchors: out.filter((contact) => contact.missingVisualAnchor).length,
    spritesShown: shown,
    spritesHidden: hidden,
  };
});
console.log(JSON.stringify(report, null, 1));

// verdict — plausible mesh readings only (a wild meshM means the probe ray
// missed the tileset entirely; those rows prove nothing either way)
// Trust only probes that read a plausible AUS-area surface (~100..250 m
// ellipsoidal) — anything else hit a coarse tile or nothing (proves nothing).
const lows = (report.contacts || []).filter((c) =>
  c.renderAltM < SITE.floorMax + 450 && c.aboveMeshM != null && c.meshM > SITE.floorMin && c.meshM < SITE.floorMax);
const buried = lows.filter((c) => c.aboveMeshM < -2);
const missingVisuals = (report.contacts || []).filter((c) => c.missingVisualAnchor);
console.log(`low contacts with plausible mesh readings: ${lows.length}; buried (< -2m): ${buried.length}`);
for (const b of buried) {
  console.log(`  BURIED ${b.id}: render ${b.renderAltM} m vs mesh ${b.meshM} m (${b.aboveMeshM} m)`);
}
for (const missing of missingVisuals) {
  console.log(`  MISSING VISUAL ANCHOR ${missing.id} (${missing.icao24})`);
}
// A measured burial is always a failure. Otherwise, no plausible readings or
// any missing render anchor is inconclusive: the harness must never turn an
// unmeasured visible contact into a false pass.
const verdict = buried.length > 0
  ? 'FAIL'
  : (lows.length === 0 || missingVisuals.length > 0 ? 'INCONCLUSIVE' : 'PASS');
console.log(`VERDICT: ${verdict}`);
await browser.close();
// Exit code (2026-08-19): this harness printed VERDICT: FAIL and still exited 0,
// so a real regression (taxiing contacts rendering under the mesh) stayed
// invisible to every automated caller. Now it reports like its siblings
// (qa-height-datum / qa-cctv-v2): 0 = PASS, 1 = FAIL, 2 = could-not-measure.
// INCONCLUSIVE is deliberately NOT 0 — a run that measured no usable contacts
// proves nothing, and must not read as a pass. The VERDICT line is unchanged,
// so anything scraping stdout (the L9 QA matrix) is unaffected.
process.exit(verdict === 'PASS' ? 0 : (verdict === 'FAIL' ? 1 : 2));
