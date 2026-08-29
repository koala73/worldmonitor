#!/usr/bin/env node
/**
 * qa-cables-overlay — submarine-cable label path measurement + contract gate.
 *
 * Two jobs:
 *  1. MEASURE (both builds, `--legacy` on the pre-migration build): with the
 *     cables layer ON at a fixed mid-Atlantic camera, capture
 *       a. per-frame `scene.render` cost over a ~10 s driven-orbit window
 *          (mean / p50 / p95 / max — relative numbers, SwiftShader surface),
 *       b. toggle-ON → first-labels-visible latency,
 *       c. entity / native-label / host-entry counts,
 *       d. parked-idle postRender fires over 5 s (render-governor honesty).
 *  2. GATE (unified build only): assert the migration contract —
 *       zero native `LabelGraphics` on cable reference entities, host entries
 *       present for the source, idle stays near-zero, and a clean OFF→ON cycle
 *       (no orphan host entries after disable).
 *
 * Usage: node scripts/qa-cables-overlay.mjs [--url http://localhost:4214] [--legacy]
 * Requires a running dev server. Headless; rAF throttling disabled so the
 * frame clock is honest (hidden-pane gotcha).
 */
import puppeteer from 'puppeteer';

const argv = process.argv;
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:4214';
const legacy = argv.includes('--legacy');
// --control: never enable the layer; measure the empty-scene orbit cost so the
// cables layer's share of frame time is attributable.
const control = argv.includes('--control');
const LAYER_ID = 'telegeography-submarine-cables';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
function report(name, detail) {
  console.log(`  [MEAS] ${name} — ${JSON.stringify(detail)}`);
}

const browser = await puppeteer.launch({
  headless: 'new',
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1440,900',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 860 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, { timeout: 90_000 });
  await new Promise((r) => setTimeout(r, 12_000)); // boot flyTo + deferred init

  // Park mid-Atlantic (many cables + both coasts' landings in range) and
  // disable every layer so the cables layer is measured in isolation.
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    v.camera.cancelFlight();
    const ell = v.scene.globe.ellipsoid;
    v.camera.setView({
      destination: ell.cartographicToCartesian({
        longitude: -40 * Math.PI / 180, latitude: 35 * Math.PI / 180, height: 4_500_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    for (const [id, entry] of gev.dataManager.layers) {
      if (entry.enabled) { try { await gev.dataManager.setEnabled(id, false, { origin: 'user' }); } catch { /* measured via counts */ } }
    }
  });
  await new Promise((r) => setTimeout(r, 6_000)); // tiles + fades settle

  // ── b. toggle-ON → labels visible ─────────────────────────────────────
  if (!control) {
    const labelLatency = await page.evaluate(async (layerId, isLegacy) => {
      const gev = window.__godsEyeView;
      const t0 = performance.now();
      await gev.dataManager.setEnabled(layerId, true, { origin: 'user' });
      const deadline = t0 + 60_000;
      const labelsUp = () => {
        if (isLegacy) {
          const stats = gev.dataManager.layers.get(layerId)?.module?.getStats?.() || {};
          return (stats.referenceLabelCount || 0) > 0;
        }
        const diag = window.__gevWorldOverlay?.getDiagnostics?.() || {};
        return (diag.paintedBySource?.[layerId] || 0) > 0;
      };
      while (performance.now() < deadline) {
        if (labelsUp()) return { ms: Math.round(performance.now() - t0), timedOut: false };
        gev.viewer.scene.requestRender?.();
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ms: 60_000, timedOut: true };
    }, LAYER_ID, legacy);
    report('toggle-ON -> labels visible (ms)', labelLatency);
    check('labels became visible after enable', labelLatency.timedOut === false, labelLatency);
    await new Promise((r) => setTimeout(r, 3_000)); // let load/labels settle
  }

  // ── c. entity / label / host counts ───────────────────────────────────
  const counts = await page.evaluate((layerId) => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    const out = {
      dataSources: {}, nativeLabels: 0, dynamicPositionEntities: 0,
      referenceEntities: 0, hostEntries: 0, hostPainted: 0,
    };
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      if (!/TeleGeography/.test(ds.name || '')) continue;
      const list = ds.entities.values;
      out.dataSources[ds.name] = list.length;
      for (const e of list) {
        if (e.label !== undefined) out.nativeLabels++;
        if (e.position && e.position.isConstant === false) out.dynamicPositionEntities++;
        if (e.polyline?.positions && e.polyline.positions.isConstant === false) {
          out.dynamicPositionEntities++;
        }
      }
      if (/References/.test(ds.name)) out.referenceEntities = list.length;
    }
    const diag = window.__gevWorldOverlay?.getDiagnostics?.() || {};
    out.hostEntries = diag.entriesBySource?.[layerId] || 0;
    out.hostPainted = diag.paintedBySource?.[layerId] || 0;
    const stats = gev.dataManager.layers.get(layerId)?.module?.getStats?.() || {};
    out.referenceLabelCount = stats.referenceLabelCount ?? null;
    return out;
  }, LAYER_ID);
  report(control ? 'counts (control, cables OFF)' : 'counts with cables ON', counts);

  // ── a. per-frame scene.render cost over a ~10 s driven orbit ─────────
  const frameCost = await page.evaluate(() => new Promise((resolve) => {
    const v = window.__godsEyeView.viewer;
    const scene = v.scene;
    const durations = [];
    const originalRender = scene.render;
    scene.render = function patchedRender(...args) {
      const started = performance.now();
      const result = originalRender.apply(this, args);
      durations.push(performance.now() - started);
      return result;
    };
    const t0 = performance.now();
    const tick = () => {
      // Slow orbit: every frame is a camera change, so Cesium renders every
      // rAF — the honest "user is interacting" cost of the layer.
      v.camera.rotateRight(0.0004);
      if (performance.now() - t0 < 10_000) requestAnimationFrame(tick);
      else {
        scene.render = originalRender;
        durations.sort((a, b) => a - b);
        const n = durations.length;
        const sum = durations.reduce((s, d) => s + d, 0);
        resolve({
          frames: n,
          meanMs: +(sum / Math.max(1, n)).toFixed(2),
          p50Ms: +(durations[Math.floor(n * 0.5)] || 0).toFixed(2),
          p95Ms: +(durations[Math.floor(n * 0.95)] || 0).toFixed(2),
          maxMs: +(durations[n - 1] || 0).toFixed(2),
          effectiveFps: +(n / 10).toFixed(1),
        });
      }
    };
    requestAnimationFrame(tick);
  }));
  report(control
    ? 'scene.render cost, control (cables OFF), 10s orbit'
    : 'scene.render cost, cables ON, 10s orbit', frameCost);

  // ── d. parked idle honesty (labels must not force continuous render) ──
  await new Promise((r) => setTimeout(r, 4_000)); // orbit stop + fades settle
  const idle = await page.evaluate(() => new Promise((resolve) => {
    const scene = window.__godsEyeView.viewer.scene;
    let renders = 0;
    const remove = scene.postRender.addEventListener(() => { renders += 1; });
    setTimeout(() => { remove(); resolve({ renders }); }, 5_000);
  }));
  report(control
    ? 'parked idle, control (postRender fires / 5s)'
    : 'parked idle with cables ON (postRender fires / 5s)', idle);

  if (!legacy && !control) {
    // ── unified-build contract gates ────────────────────────────────────
    check('zero native LabelGraphics on cable entities', counts.nativeLabels === 0, counts.nativeLabels);
    check('zero per-frame CallbackProperty cable entities', counts.dynamicPositionEntities === 0, counts.dynamicPositionEntities);
    check('host has cable entries', counts.hostEntries > 0, counts.hostEntries);
    check('host painted cable labels', counts.hostPainted > 0, counts.hostPainted);
    // The cables source never republishes an unchanged cohort (unit pin), and
    // since the 2026-08-18 host fix the occluder observer is scoped (body
    // childList filtered to inventory chrome; attribute observation
    // element-only) and the right-rail allocator writes-if-changed — so a
    // parked camera measures 0 postRender fires / 5 s with cables ON, equal
    // to the empty-scene control (pre-fix: ~56-61). The headroom below covers
    // an occasional genuine chrome transition (loading-chip flip + its 100 ms
    // occluder-refresh echo) landing inside the window; ticking churn (~10)
    // or the old observer leak (~56+) must fail.
    check('parked idle stays near zero (≤6 / 5s)', idle.renders <= 6, idle);

    // OFF must clear the host source (no orphan labels), ON must restore.
    const cycle = await page.evaluate(async (layerId) => {
      const gev = window.__godsEyeView;
      await gev.dataManager.setEnabled(layerId, false, { origin: 'user' });
      gev.viewer.scene.requestRender?.();
      await new Promise((r) => setTimeout(r, 1_200));
      const offDiag = window.__gevWorldOverlay?.getDiagnostics?.() || {};
      const offEntries = offDiag.entriesBySource?.[layerId] || 0;
      const offPainted = offDiag.paintedBySource?.[layerId] || 0;
      await gev.dataManager.setEnabled(layerId, true, { origin: 'user' });
      const t0 = performance.now();
      let onPainted = 0;
      while (performance.now() - t0 < 20_000) {
        const diag = window.__gevWorldOverlay?.getDiagnostics?.() || {};
        onPainted = diag.paintedBySource?.[layerId] || 0;
        if (onPainted > 0) break;
        gev.viewer.scene.requestRender?.();
        await new Promise((r) => setTimeout(r, 100));
      }
      return { offEntries, offPainted, onPainted };
    }, LAYER_ID);
    check('disable clears host entries (no orphans)', cycle.offEntries === 0 && cycle.offPainted === 0, cycle);
    check('re-enable restores painted labels', cycle.onPainted > 0, cycle);
  }
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\nqa-cables-overlay: ${passed}/${results.length} passed${legacy ? ' (legacy measurement mode)' : ''}${control ? ' (control mode)' : ''}`);
console.log(`RESULT: ${passed} passed, ${results.length - passed} failed, 0 skipped`);
process.exit(passed === results.length ? 0 : 1);
