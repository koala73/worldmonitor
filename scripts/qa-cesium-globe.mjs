/**
 * Smoke-test the God's Eye View globe inside World Monitor, in a real browser.
 *
 * Source-text tests can prove CesiumGlobeMap implements MapContainer's
 * contract; only a browser can prove the thing actually paints. This drives a
 * built preview, forces the globe on, and checks that a Cesium canvas exists,
 * has non-zero size, and is rendering frames.
 *
 * Run:  node scripts/qa-cesium-globe.mjs [--url http://localhost:5198] [--headed]
 * Needs: npm run build, then a preview server on that URL.
 */

import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const argv = process.argv.slice(2);
const urlIdx = argv.indexOf('--url');
const BASE = urlIdx !== -1 && argv[urlIdx + 1] ? argv[urlIdx + 1] : 'http://localhost:5198';
const HEADED = argv.includes('--headed');
const SHOT_DIR = resolve(ROOT, 'qa-shots');

const failures = [];
const notes = [];

function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`;
  console.log(`  ${line}`);
  if (!ok) failures.push(name);
}

const browser = await puppeteer.launch({
  headless: !HEADED,
  args: [
    // Cesium needs WebGL. SwiftShader gives a software GL that is slow but
    // real, which is what makes this runnable on a headless CI box.
    '--enable-unsafe-swiftshader',
    '--use-gl=swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 300)}`));

  // Force globe mode before the app boots, so we test the mount path rather
  // than the runtime switch.
  await page.evaluateOnNewDocument(() => {
    try {
      // STORAGE_KEYS.mapMode — see src/config/variants/base.ts. panel-layout
      // reads this to decide `preferGlobe` when it constructs MapContainer.
      // loadFromStorage JSON-parses, so the value must be a JSON string.
      localStorage.setItem('worldmonitor-map-mode', JSON.stringify('globe'));
      // Short boot, not none: the ceremony is the front door now, and this
      // test should go through it the way a returning user does.
      localStorage.setItem('openeye.boot.seen', '1');
      // Deliberately NOT the map tab, even though MAP is the default: a user
      // whose last session ended on another section reloads into it, and the
      // map section is then display:none when MapContainer constructs the
      // globe. That produces a 0x0 canvas that only recovers if something
      // resizes it when the tab opens. The tab switch below is the test.
      localStorage.setItem('openeye-active-tab', 'live');
    } catch { /* private mode */ }
  });

  console.log(`\nLoading ${BASE} …`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  // Through the front door first.
  await page.waitForFunction(
    () => document.documentElement.classList.contains('openeye-booted'),
    { timeout: 120_000, polling: 250 }).catch(() => {});

  // The globe is dynamically imported and Cesium takes a while under
  // SwiftShader; poll rather than guess a fixed delay.
  const appeared = await page
    .waitForFunction(
      () => !!document.querySelector('.gev-root canvas, #cesiumContainer canvas'),
      { timeout: 120_000, polling: 500 },
    )
    .then(() => true)
    .catch(() => false);

  check('Cesium canvas mounted', appeared);

  // The map has its own tab. Until it is opened the section is display:none,
  // so Cesium builds its canvas at 0x0 — correct, and recoverable only if
  // something resizes it when the tab opens. That recovery is the check.
  const hiddenSize = await page.evaluate(() => {
    const c = document.querySelector('.gev-root canvas, #cesiumContainer canvas');
    const r = c?.getBoundingClientRect();
    return r ? Math.round(r.width) : -1;
  });
  await page.evaluate(() => {
    document.querySelector('.openeye-tab[data-oe-key="map"]')?.click();
  });
  const resized = await page
    .waitForFunction(() => {
      const c = document.querySelector('.gev-root canvas, #cesiumContainer canvas');
      return (c?.getBoundingClientRect().width ?? 0) > 100;
    }, { timeout: 30_000, polling: 250 })
    .then(() => true).catch(() => false);
  check('the globe recovers its size when the MAP tab opens', resized,
    `was ${hiddenSize}px wide while hidden`);

  if (appeared) {
    const geom = await page.evaluate(() => {
      const c = document.querySelector('.gev-root canvas, #cesiumContainer canvas');
      const r = c.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    check('canvas has non-zero size', geom.w > 100 && geom.h > 100, `${geom.w}x${geom.h}`);

    const rooted = await page.evaluate(
      () => !!document.querySelector('.gev-root'),
    );
    check('chrome mounted under .gev-root (stylesheet namespace)', rooted);

    const viewerLive = await page.evaluate(() => {
      const g = window.__godsEyeView;
      if (!g?.viewer) return { ok: false, why: 'no window.__godsEyeView.viewer' };
      return { ok: !g.viewer.isDestroyed(), why: '' };
    });
    check('GEV viewer handle is live', viewerLive.ok, viewerLive.why);

    // Frames actually advancing — a mounted-but-frozen canvas is the failure
    // mode a size check alone would miss.
    const rendering = await page.evaluate(async () => {
      const g = window.__godsEyeView;
      if (!g?.viewer) return false;
      let frames = 0;
      const remove = g.viewer.scene.postRender.addEventListener(() => { frames++; });
      g.viewer.scene.requestRender();
      await new Promise((r) => setTimeout(r, 3000));
      remove();
      return frames;
    }).catch(() => 0);
    check('scene is rendering frames', Number(rendering) > 0, `${rendering} frames in 3s`);

    const layers = await page.evaluate(() => {
      const g = window.__godsEyeView;
      try { return g?.dataManager?.getAll?.()?.length ?? -1; } catch { return -1; }
    });
    if (layers > 0) notes.push(`${layers} God's Eye View data layers registered`);

    // Where the map OPENS is a check in its own right. The vendored tree
    // flies to Austin on a 500 ms timer unless told not to, which silently
    // overrides whatever region World Monitor asked for; capture the frame
    // before the pick test below moves the camera on purpose.
    const opening = await page.evaluate(() => {
      const c = window.__godsEyeView?.viewer?.camera?.positionCartographic;
      if (!c) return null;
      const deg = 180 / Math.PI;
      return { lat: +(c.latitude * deg).toFixed(2), lon: +(c.longitude * deg).toFixed(2), h: Math.round(c.height) };
    });
    // MapContainer's 'global' preset — see VIEW_CAMERAS in CesiumGlobeMap.ts.
    check('map opens on World Monitor\'s view, not the vendored default',
      !!opening && Math.abs(opening.lat - 20) < 2 && Math.abs(opening.lon) < 2 && opening.h > 5_000_000,
      opening ? `lat ${opening.lat}, lon ${opening.lon}, ${Math.round(opening.h / 1000)} km` : 'no camera');

    await mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: resolve(SHOT_DIR, 'cesium-globe-opening.png') });

    // ── The tracker bridge ───────────────────────────────────────────────
    //
    // World Monitor's own layer tray, and proof that toggling a layer in it
    // puts real Cesium entities on the globe. A built-in site catalogue is
    // used rather than a live tracker: it needs no network, so a failure
    // here is the bridge's fault and not an upstream feed's.

    const tray = await page.evaluate(() => {
      const el = document.querySelector('.gev-layer-toggles');
      if (!el) return { present: false, rows: 0 };
      return { present: true, rows: el.querySelectorAll('.layer-toggle-row').length };
    });
    check("World Monitor's layer tray mounted on the globe", tray.present && tray.rows > 10,
      `${tray.rows} layer rows`);

    const bridged = await page.evaluate(async () => {
      const toggle = document.querySelector('.layer-toggle[data-layer="bases"] input');
      if (!toggle) return { ok: false, why: 'no Military Bases row in the tray' };
      if (!toggle.checked) toggle.click();

      const sources = () => {
        const ds = window.__godsEyeView?.viewer?.dataSources;
        if (!ds) return [];
        const out = [];
        for (let i = 0; i < ds.length; i++) out.push(ds.get(i));
        return out;
      };

      // Entity creation is synchronous but dataSources.add is not.
      const deadline = Date.now() + 8000;
      let source = null;
      while (Date.now() < deadline) {
        source = sources().find((s) => s.name === 'wm:static:bases') ?? null;
        if (source && source.entities.values.length) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!source) return { ok: false, why: 'no wm:static:bases data source appeared' };

      const count = source.entities.values.length;
      const shown = source.show;

      // ...and that turning it back off hides it rather than leaking it.
      toggle.click();
      await new Promise((r) => setTimeout(r, 300));
      const hidden = source.show === false;

      const sample = source.entities.values[0];
      const positioned = !!sample?.position;

      return { ok: count > 0 && shown && hidden && positioned, count, shown, hidden, positioned };
    });
    check('toggling a World Monitor layer draws Cesium entities', bridged.ok,
      bridged.why ?? `${bridged.count} entities, shown=${bridged.shown}, hides=${bridged.hidden}`);

    // Both marker paths in the spec table must produce real graphics. Glyph
    // markers go through a canvas texture into a billboard; plain markers
    // through Cesium's point graphic. Counting entity graphics rather than
    // GPU primitives is deliberate — Cesium rasterises ground-clamped points
    // as billboards internally, so a primitive count cannot tell the two
    // spec paths apart, which is what this is checking.
    const primitives = await page.evaluate(() => {
      const ds = window.__godsEyeView?.viewer?.dataSources;
      if (!ds) return { billboards: 0, points: 0 };
      let billboards = 0;
      let points = 0;
      for (let i = 0; i < ds.length; i++) {
        const source = ds.get(i);
        if (!source?.name?.startsWith('wm:')) continue;
        for (const entity of source.entities.values) {
          if (entity.billboard) billboards++;
          if (entity.point) points++;
        }
      }
      return { billboards, points };
    });
    check('both marker spec paths produce graphics',
      primitives.billboards > 0 && primitives.points > 0,
      `${primitives.billboards} glyph, ${primitives.points} plain`);

    // The decisive check: fly to a marker and pick it off the screen. Entity
    // count proves the bridge built something; a successful pick proves the
    // GPU drew it AND that hover and click will find it. Under Google's
    // photorealistic tiles the vendored tree hides Cesium's own globe
    // (scene.globe.show = false), which is exactly the configuration where a
    // ground-clamped marker can silently fail to appear.
    const picked = await page.evaluate(async () => {
      const Cesium = window.Cesium;
      const g = window.__godsEyeView;
      const v = g?.viewer;
      if (!Cesium || !v) return { ok: false, why: 'no Cesium global to project with' };

      const ds = v.dataSources;
      let source = null;
      for (let i = 0; i < ds.length; i++) {
        const s = ds.get(i);
        if (s?.name?.startsWith('wm:') && s.entities.values.length) { source = s; break; }
      }
      if (!source) return { ok: false, why: 'no bridged source has entities' };
      source.show = true;

      const entity = source.entities.values[0];
      const time = v.clock.currentTime;
      const position = entity.position.getValue(time);
      const carto = Cesium.Cartographic.fromCartesian(position);

      // Park the camera straight above it, high enough that terrain cannot
      // occlude and low enough that the marker is not a sub-pixel speck.
      v.camera.setView({
        destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 300000),
      });
      // The scene runs in requestRenderMode, and SwiftShader takes its time.
      // Ask the scene directly rather than through the render governor, and
      // give it long enough that a miss means "not drawn" rather than "not
      // drawn YET".
      v.scene.requestRender();
      await new Promise((r) => setTimeout(r, 3000));

      const screen = Cesium.SceneTransforms.worldToWindowCoordinates
        ? Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, position)
        : Cesium.SceneTransforms.wgs84ToWindowCoordinates(v.scene, position);
      if (!screen) return { ok: false, why: 'marker did not project to the screen' };

      // drillPick, not pick: Google's photorealistic tileset is also at this
      // pixel, and which of the two is topmost depends on tile load state.
      // What matters is that the marker was rasterised into the pick buffer
      // at all — that is what makes hover and click work.
      const hits = v.scene.drillPick(new Cesium.Cartesian2(screen.x, screen.y), 10);
      const ids = hits.map((h) => h?.id?.id).filter((id) => typeof id === 'string');
      return {
        ok: ids.includes(entity.id),
        why: ids.length ? `picked ${ids.join(', ')}` : 'nothing under the marker',
        expected: entity.id,
      };
    });
    check('a bridged marker is drawn and pickable', picked.ok,
      picked.ok ? `picked ${picked.expected}` : picked.why);

    const trackers = await page.evaluate(() => {
      const ds = window.__godsEyeView?.viewer?.dataSources;
      if (!ds) return [];
      const out = [];
      for (let i = 0; i < ds.length; i++) {
        const s = ds.get(i);
        if (s?.name?.startsWith('wm:')) out.push(`${s.name}(${s.entities.values.length})`);
      }
      return out;
    });
    if (trackers.length) {
      notes.push(`bridged sources on the globe: ${trackers.join(', ')}`);
    }
  }

  // The globe must not have taken the dashboard down with it.
  const dashboardAlive = await page.evaluate(
    () => document.querySelectorAll('.panel, [data-panel-id]').length,
  );
  check('World Monitor panels still render alongside the globe', dashboardAlive > 0,
    `${dashboardAlive} panels`);

  await mkdir(SHOT_DIR, { recursive: true });
  const shot = resolve(SHOT_DIR, 'cesium-globe.png');
  await page.screenshot({ path: shot });
  console.log(`\n  screenshot: ${shot}`);

  // Cesium is noisy about tile requests; only surface errors that look like
  // ours rather than upstream tile 404s.
  const relevant = consoleErrors.filter(
    (e) => !/tile|Tile|404|Failed to load resource/.test(e),
  );
  if (relevant.length) {
    console.log('\n  console errors:');
    for (const e of relevant.slice(0, 8)) console.log(`    ${e}`);
  }
  await writeFile(
    resolve(SHOT_DIR, 'cesium-globe-console.log'),
    consoleErrors.join('\n'),
  );
} finally {
  await browser.close();
}

if (notes.length) {
  console.log('');
  for (const n of notes) console.log(`  note: ${n}`);
}

console.log('');
if (failures.length) {
  console.error(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('Cesium globe smoke test passed.');
