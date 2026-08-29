#!/usr/bin/env node
/**
 * qa-label-readability.mjs — before/after evidence capture for ambient label
 * legibility over bright ground.
 *
 * Run:
 *   node scripts/qa-label-readability.mjs --url http://localhost:4244 --tag after
 *
 * Every scene pins its own camera pose AND substitutes a deterministic
 * synthetic contact field for the live pollers, so a `before` run and an
 * `after` run produce pixel-comparable frames: same contacts, same callsigns,
 * same placements, same imagery. The only difference between the two tags is
 * the code under test.
 *
 * Scenes cover the cases the readability spec calls out:
 *   bright-*  — sunlit aerial imagery, one shot per visual style
 *   dark-*    — dark water/terrain, where a plate must NOT turn into a box
 *   sats-*    — space-tier contacts over the lit Earth disc
 *   horizon-* — cockpit pose at the horizon, contacts against SKY, where the
 *               plate must feather back toward the bare-text look
 *   band-*    — the horizon crossing the middle of the label field, so the
 *               feather can be judged for smoothness rather than popping
 *
 * Each shot also reports a luminance histogram of the label band, so the
 * "did the plate actually darken anything" question has a number behind it and
 * not only an eyeball.
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const APP_URL = getOpt('--url', 'http://localhost:4244');
const TAG = getOpt('--tag', 'after');
/** Comma-separated scene-id prefixes. Empty runs the whole set. */
const SCENE_FILTER = getOpt('--scenes', '')
  .split(',')
  .map((token) => token.trim())
  .filter(Boolean);
const SHOT_DIR = path.resolve(getOpt('--out', 'qa-shots/labels'));
const SETTLE_MAX_MS = 40_000;
const SETTLE_MIN_MS = 4_000;

/**
 * Scenes are (camera pose × visual style). `field` describes the synthetic
 * contact cloud dropped around the camera target.
 */
/** Sunlit airport apron — the brightest ground the product routinely flies over. */
const APRON = { lon: -97.6664, lat: 30.1975, height: 1100, heading: 0.35, pitch: -0.85 };

/**
 * Cockpit pose: cruise altitude, level, looking out at the horizon. From 10 km
 * the ellipsoid silhouette sits ~3.2° below the local horizontal, so a level
 * camera puts the horizon line just under frame centre and everything the
 * `horizon-*` field lands on is open sky.
 */
const COCKPIT = { lon: -98.35, lat: 30.05, height: 10_000, heading: 1.42, pitch: 0 };

/** Contacts biased into the upper frame: every one of them backs onto sky. */
const SKY_FIELD = {
  kind: 'air', count: 30, near: 40_000, far: 120_000, spanY: 0.9, biasY: 0.3,
};

const SCENES = [
  {
    id: 'bright-normal',
    style: 'normal',
    note: 'sunlit apron concrete — the failure case from the field report',
    camera: APRON,
    field: { kind: 'air', count: 30, near: 700, far: 2600 },
  },
  {
    id: 'bright-retro',
    style: 'retro',
    note: 'CRT amber over the same sunlit ground',
    camera: APRON,
    field: { kind: 'air', count: 30, near: 700, far: 2600 },
  },
  {
    id: 'bright-surveillance',
    style: 'surveillance',
    note: 'NVG green over the same sunlit ground',
    camera: APRON,
    field: { kind: 'air', count: 30, near: 700, far: 2600 },
  },
  {
    id: 'bright-thermal',
    style: 'thermal',
    note: 'FLIR over the same sunlit ground',
    camera: APRON,
    field: { kind: 'air', count: 30, near: 700, far: 2600 },
  },
  {
    id: 'dark-normal',
    style: 'normal',
    note: 'dark water — a plate here must stay a whisper, not a box',
    camera: { lon: 139.05, lat: 34.45, height: 9000, heading: 0.2, pitch: -0.62 },
    field: { kind: 'air', count: 30, near: 6000, far: 26_000 },
  },
  {
    id: 'sats-normal',
    style: 'normal',
    note: 'space tier over the lit Earth disc',
    camera: { lon: -60, lat: 20, height: 21_000_000, heading: 0, pitch: -Math.PI / 2 },
    field: { kind: 'sat', count: 30, near: 14_000_000, far: 20_000_000 },
  },
  {
    id: 'horizon-normal',
    style: 'normal',
    note: 'cockpit at the horizon — the sky backdrop the plate must feather off',
    camera: COCKPIT,
    field: SKY_FIELD,
  },
  {
    id: 'horizon-retro',
    style: 'retro',
    note: 'CRT amber against the same sky',
    camera: COCKPIT,
    field: SKY_FIELD,
  },
  {
    id: 'horizon-surveillance',
    style: 'surveillance',
    note: 'NVG green against the same sky',
    camera: COCKPIT,
    field: SKY_FIELD,
  },
  {
    id: 'horizon-thermal',
    style: 'thermal',
    note: 'FLIR against the same sky',
    camera: COCKPIT,
    field: SKY_FIELD,
  },
  {
    id: 'band-normal',
    style: 'normal',
    note: 'horizon crossing the label field — feather smoothness, both sides in one frame',
    camera: COCKPIT,
    // Shallower depths keep the low contacts above ground rather than inside it,
    // so the frame carries genuine terrain-backed AND sky-backed labels.
    field: {
      kind: 'air', count: 30, near: 15_000, far: 60_000, spanY: 1.0, biasY: -0.1,
    },
    // The band scene's contacts sit lower in the frame than the default crop.
    crop: { x: 0.16, y: 0.28, w: 0.52, h: 0.54 },
  },
];

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Pin puppeteer's Chrome-for-Testing: system Chrome auto-updates underneath
  // the harnesses and its software-GL behaviour shifts across majors.
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* fall through */ }
  }
  return null;
}

/** Decode a base64 PNG inside the page and return luminance statistics. */
async function measureShot(page, base64) {
  return page.evaluate(async (b64) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = `data:image/png;base64,${b64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    // Sample the central band only: the vignette and the fixed chrome rails
    // would otherwise dominate a whole-frame histogram.
    const x0 = Math.round(image.width * 0.2);
    const x1 = Math.round(image.width * 0.8);
    const y0 = Math.round(image.height * 0.15);
    const y1 = Math.round(image.height * 0.8);
    const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const values = [];
    for (let i = 0; i < data.length; i += 4) {
      values.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    }
    values.sort((a, b) => a - b);
    const at = (q) => Math.round(values[Math.min(values.length - 1, Math.floor(values.length * q))]);
    return { p05: at(0.05), p25: at(0.25), p50: at(0.5), p95: at(0.95), samples: values.length };
  }, base64);
}

/** Wait until consecutive frames stop changing, so tiles are fully resolved. */
async function settle(page) {
  const started = Date.now();
  let previous = null;
  while (Date.now() - started < SETTLE_MAX_MS) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const state = await page.evaluate(() => {
      const { viewer, tileset } = window.__godsEyeView;
      return {
        tilesLoaded: tileset?.tilesLoaded !== false,
        pending: viewer.scene.globe?._surface?._tileLoadQueueHigh?.length ?? 0,
      };
    });
    const settled = state.tilesLoaded && state.pending === 0;
    if (settled && previous && Date.now() - started > SETTLE_MIN_MS) return true;
    previous = settled;
  }
  return false;
}

async function main() {
  console.log('\nLabel readability evidence');
  console.log(`  App URL : ${APP_URL}`);
  console.log(`  Tag     : ${TAG}`);
  console.log(`  Output  : ${SHOT_DIR}\n`);

  try {
    const response = await fetch(APP_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(`Dev server not reachable at ${APP_URL}: ${error.message}`);
    process.exit(2);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const executablePath = findChrome();
  const browser = await puppeteer.launch({
    headless: 'new',
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-dev-shm-usage', '--disable-web-security',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--window-size=1280,800',
    ],
  });

  const results = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => console.warn(`  ! pageerror: ${error.message}`));

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.styleManager,
      { timeout: 60_000, polling: 100 },
    );
    // flyToAustin arrives ~500 ms after init; let it start and land before any
    // scene sets its own pose, or the arrival overwrites the first camera.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const selected = SCENE_FILTER.length
      ? SCENES.filter((scene) => SCENE_FILTER.some((prefix) => scene.id.startsWith(prefix)))
      : SCENES;
    if (selected.length === 0) throw new Error(`--scenes matched nothing: ${SCENE_FILTER}`);

    for (const scene of selected) {
      process.stdout.write(`  ${scene.id} … `);
      await page.evaluate((spec) => {
        const { viewer, dataManager, styleManager } = window.__godsEyeView;
        viewer.camera.cancelFlight();
        const Cartesian3 = viewer.camera.position.constructor;

        viewer.camera.setView({
          destination: Cartesian3.fromDegrees(
            spec.camera.lon, spec.camera.lat, spec.camera.height,
          ),
          orientation: {
            heading: spec.camera.heading,
            pitch: spec.camera.pitch,
            roll: 0,
          },
        });

        // Contacts are placed by SCREEN position rather than by geography: a
        // pitched camera looks well ahead of its own ground point, so a cloud
        // centred on the camera coordinate mostly lands behind the frustum and
        // the frame comes back with two labels instead of a field. Building
        // straight off the camera basis guarantees every contact lands inside
        // the keyhole, at a known depth, in both the before and after runs.
        const camera = viewer.camera;
        const frustum = camera.frustum;
        const halfHeight = Math.tan((frustum.fovy ?? frustum.fov ?? 1.0) / 2);
        const halfWidth = halfHeight * (frustum.aspectRatio || 1.6);
        const basis = {
          px: camera.position.x, py: camera.position.y, pz: camera.position.z,
          dx: camera.direction.x, dy: camera.direction.y, dz: camera.direction.z,
          ux: camera.up.x, uy: camera.up.y, uz: camera.up.z,
          rx: camera.right.x, ry: camera.right.y, rz: camera.right.z,
        };
        // A 6x5 jittered lattice over the central 76% of the frame. Deterministic
        // by construction — no RNG anywhere in the harness.
        const pointAt = (ndcX, ndcY, distance) => {
          const sx = ndcX * halfWidth * distance;
          const sy = ndcY * halfHeight * distance;
          return new Cartesian3(
            basis.px + basis.dx * distance + basis.rx * sx + basis.ux * sy,
            basis.py + basis.dy * distance + basis.ry * sx + basis.uy * sy,
            basis.pz + basis.dz * distance + basis.rz * sx + basis.uz * sy,
          );
        };

        const build = (prefix) => {
          const rows = [];
          const cols = 6;
          const isSat = spec.field.kind === 'sat';
          for (let i = 0; i < spec.field.count; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const jitter = ((i * 37) % 11) / 11 - 0.5;
            // spanY/biasY let a scene aim the lattice at sky, at ground, or
            // straight across the horizon line without moving the camera.
            const spanX = spec.field.spanX ?? 1.52;
            const spanY = spec.field.spanY ?? 1.34;
            const biasY = spec.field.biasY ?? 0;
            const ndcX = ((col + 0.5) / cols - 0.5) * spanX + jitter * 0.06;
            const ndcY = ((row + 0.5) / Math.ceil(spec.field.count / cols) - 0.5)
              * spanY + biasY + jitter * 0.05;
            const depth = spec.field.near
              + (spec.field.far - spec.field.near) * (((i * 53) % 17) / 17);
            const flightLevel = 20 + ((i * 29) % 380);
            rows.push({
              sourceId: `${prefix}-${String(i).padStart(3, '0')}`,
              id: isSat ? `SAT-${String(1000 + i)}` : `JA${String(20000 + i * 7)}`,
              metric: isSat ? 'LEO' : `FL${String(flightLevel).padStart(3, '0')}`,
              position: pointAt(ndcX, ndcY, depth),
              type: isSat ? 'SAT' : 'AIR',
              tier: isSat ? 'space' : (i % 6 === 0 ? 'military' : 'civil'),
            });
          }
          return rows;
        };

        const assignment = spec.field.kind === 'sat'
          ? { satellites: build('s'), flights: [], military: [] }
          : { flights: build('f'), military: [], satellites: [] };
        window.__LABEL_EVIDENCE = assignment;
        for (const layerId of Object.keys(assignment)) {
          const entry = dataManager.layers.get(layerId);
          if (entry?.module) {
            entry.module.getDetectableObjects = () => window.__LABEL_EVIDENCE[layerId];
          }
        }

        styleManager.setStyle(spec.style, { applyPreset: false });
        // Set detection AFTER the style: military presets auto-arm Panoptic at
        // 0% density, which would otherwise leave the frame without callouts.
        styleManager.setDetection({
          enabled: true,
          densityPct: 100,
          allocationStrategy: 'elastic',
        });
      }, scene);

      const converged = await settle(page);
      const base64 = await page.screenshot({ encoding: 'base64' });
      fs.writeFileSync(
        path.join(SHOT_DIR, `${TAG}-${scene.id}.png`),
        Buffer.from(base64, 'base64'),
      );
      // A 2x blow-up of the label field. Ambient callouts are 10px mono, and
      // the taste call this evidence exists for cannot be made at 1:1.
      const crop = await page.evaluate(async ({ b64, box }) => {
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = `data:image/png;base64,${b64}`;
        });
        const sx = Math.round(image.width * box.x);
        const sy = Math.round(image.height * box.y);
        const sw = Math.round(image.width * box.w);
        const sh = Math.round(image.height * box.h);
        const canvas = document.createElement('canvas');
        canvas.width = sw * 2;
        canvas.height = sh * 2;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw * 2, sh * 2);
        return canvas.toDataURL('image/png').split(',')[1];
      }, { b64: base64, box: scene.crop ?? { x: 0.16, y: 0.14, w: 0.52, h: 0.5 } });
      fs.writeFileSync(
        path.join(SHOT_DIR, `${TAG}-${scene.id}-crop.png`),
        Buffer.from(crop, 'base64'),
      );
      const stats = await measureShot(page, base64);
      const diagnostics = await page.evaluate(
        () => window.__godsEyeView.styleManager.getDetectionState?.() || {},
      );
      results.push({ scene: scene.id, converged, ...stats });
      console.log(
        `p05=${stats.p05} p25=${stats.p25} p50=${stats.p50} p95=${stats.p95}`
        + `${converged ? '' : '  (tiles did not fully settle)'}`
        + `  [${diagnostics.detectionMode || '?'}]`,
      );
    }
  } finally {
    await browser.close();
  }

  const summary = path.join(SHOT_DIR, `${TAG}-summary.json`);
  fs.writeFileSync(summary, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n  ${results.length} shots → ${SHOT_DIR}`);
  console.log(`  summary → ${summary}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
