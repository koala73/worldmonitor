#!/usr/bin/env node
/**
 * fly_route cinematic evidence — drives the REAL voice runner headlessly and
 * measures the REAL camera (Cesium heading/pitch/roll + position) every
 * rendered frame, so the proof is the shot the owner will watch, not our own
 * internal numbers.
 *
 *   node scripts/qa-flyroute-cinema.mjs --url http://localhost:4247
 *
 * Writes a screenshot sequence plus a JSON trace to qa-shots/flyroute/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const getOpt = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const APP_URL = getOpt('--url', 'http://localhost:4247');
const OUT_DIR = getOpt('--out', path.join(ROOT, 'qa-shots', 'flyroute'));
const MIRROR_DIR = getOpt('--mirror', '');
const SHOT_EVERY_MS = Number(getOpt('--shot-ms', '2000'));

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
].filter(Boolean);
const CHROME_EXECUTABLE = CHROME_CANDIDATES.find((c) => { try { return fs.existsSync(c); } catch { return false; } });

// A 6-waypoint downtown Austin route: north, right, left, right, left.
const ROUTE_POINTS = [
  { latitude: 30.2620, longitude: -97.7431 },
  { latitude: 30.2650, longitude: -97.7431 },
  { latitude: 30.2650, longitude: -97.7397 },
  { latitude: 30.2680, longitude: -97.7397 },
  { latitude: 30.2680, longitude: -97.7363 },
  { latitude: 30.2712, longitude: -97.7363 },
];

const results = [];
const report = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
};
const note = (name, detail) => {
  results.push({ ok: null, name, detail });
  console.log(`  \x1b[33mNOTE\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const wrapDeg = (deg) => ((deg + 540) % 360) - 180;

fs.mkdirSync(OUT_DIR, { recursive: true });
if (MIRROR_DIR) fs.mkdirSync(MIRROR_DIR, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  ...(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : {}),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    // Real GPU when the host has one: the dolly is frame-rate independent, but
    // a higher sample rate makes the roll and the ease ramps far easier to see.
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1500,950',
  ],
  protocolTimeout: 240000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on('pageerror', (e) => console.log(`  [page error] ${String(e).slice(0, 160)}`));

// Cold-corridor proof: hold the terrain proxy back so the dolly has to survive
// a corridor that has no floor data when the flight is asked for. Without this
// the harness only ever measures a machine whose cache happens to be warm.
const TERRAIN_DELAY_MS = Number(getOpt('--terrain-delay-ms', '0'));
let terrainRequests = 0;
if (TERRAIN_DELAY_MS > 0) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url().includes('/api/terrain/heights')) {
      terrainRequests += 1;
      setTimeout(() => { request.continue().catch(() => {}); }, TERRAIN_DELAY_MS);
      return;
    }
    request.continue().catch(() => {});
  });
}

/** Install a postRender sampler: one row per RENDERED frame. */
async function installSampler() {
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    window.__gevFlyTrace = { rows: [], marks: [] };
    if (window.__gevFlyTraceRemove) window.__gevFlyTraceRemove();
    let frame = 0;
    const listener = () => {
      const cam = viewer.camera;
      const carto = cam.positionCartographic;
      // Every 6th frame, ask the RENDERED WORLD what is under the camera. This
      // is the only measurement that can prove "never below terrain": it reads
      // the surface the user is actually looking at, not our own floor cache.
      let surfaceM = null;
      frame += 1;
      if (frame % 6 === 0 && typeof viewer.scene.sampleHeight === 'function') {
        try {
          const probe = viewer.scene.sampleHeight(carto.clone());
          if (Number.isFinite(probe)) surfaceM = probe;
        } catch { /* tiles not loaded under the camera */ }
      }
      window.__gevFlyTrace.rows.push({
        t: performance.now(),
        lon: (carto.longitude * 180) / Math.PI,
        lat: (carto.latitude * 180) / Math.PI,
        height: carto.height,
        headingDeg: (cam.heading * 180) / Math.PI,
        pitchDeg: (cam.pitch * 180) / Math.PI,
        rollDeg: (cam.roll * 180) / Math.PI,
        surfaceM,
      });
    };
    viewer.scene.postRender.addEventListener(listener);
    window.__gevFlyTraceRemove = () => viewer.scene.postRender.removeEventListener(listener);
  });
}

async function readTrace() {
  return page.evaluate(() => ({
    rows: window.__gevFlyTrace.rows.slice(),
    marks: window.__gevFlyTrace.marks.slice(),
  }));
}

/** Metres between two samples, on the ground plane plus height. */
function sampleDistanceM(a, b) {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((a.lat * Math.PI) / 180);
  const dx = (b.lon - a.lon) * mPerDegLon;
  const dy = (b.lat - a.lat) * mPerDegLat;
  return Math.hypot(dx, dy);
}

try {
  console.log(`\nfly_route cinematic evidence — ${APP_URL}`);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__gevVoiceCommands?.runner && window.__gevAnnotations,
    { timeout: 150000, polling: 250 },
  );
  const run = (name, args = {}) => page.evaluate(
    (n, a) => window.__gevVoiceCommands.runner(n, a), name, args,
  );

  // ── Setup: get over downtown Austin, draw the route ───────────────────
  await run('fly_to_location', { query: 'Texas State Capitol, Austin' });
  await sleep(9000);
  await run('clear_annotations', {});
  await sleep(500);
  const drawn = await run('annotate_map', {
    annotations: [{
      type: 'route', mode: 'driving', label: 'cinema evidence route', points: ROUTE_POINTS,
    }],
  });
  await sleep(6000);
  const routeInfo = await page.evaluate(() => {
    const route = (window.__gevAnnotations.list?.() || []).filter((a) => a.type === 'route').at(-1);
    return route ? { label: route.label, waypoints: route.path?.length ?? 0 } : null;
  });
  report(Boolean(routeInfo?.waypoints >= 2), 'route drawn on the board',
    `waypoints=${routeInfo?.waypoints} drawn=${drawn?.drawn}`);
  if (!routeInfo) throw new Error('no route on the board — cannot fly it');

  // ── Run 1: the full cinematic flight ──────────────────────────────────
  await installSampler();
  const flight = await run('fly_route', { label: 'cinema evidence', speed: 'normal' });
  await page.evaluate(() => window.__gevFlyTrace.marks.push({ label: 'flight-start', t: performance.now() }));
  report(flight?.ok === true, 'fly_route accepted',
    `distanceM=${flight?.distanceM} durationS=${flight?.durationS} waypoints=${flight?.waypoints}`);
  if (!flight?.ok) throw new Error(`fly_route refused: ${flight?.error}`);
  const coldPath = await page.evaluate(async () => {
    try {
      const mod = await import('/src/cameraVerbs.js');
      return mod.getActiveCameraMotion?.() ?? null;
    } catch { return 'module-unavailable'; }
  });
  if (coldPath && coldPath !== 'module-unavailable') {
    report(true, 'cold-path telemetry read from the live flight',
      `arming=${coldPath.arming} floorKnown=${coldPath.floorKnown} viaMeshProbe=${coldPath.floorFromMeshProbe}`
      + (TERRAIN_DELAY_MS ? ` (terrain proxy held back ${TERRAIN_DELAY_MS} ms, ${terrainRequests} request(s))` : ''));
  }

  // Liveness is read off the CAMERA, never off a module import: under Vite the
  // dev server hands a dynamic import its own module instance after any HMR
  // update, whose motion slot is empty no matter what the app is doing.
  const stillForMs = () => page.evaluate(() => {
    const rows = window.__gevFlyTrace.rows;
    if (rows.length < 3) return 0;
    const last = rows.at(-1);
    for (let i = rows.length - 2; i >= 0; i -= 1) {
      const moved = Math.abs(rows[i].lon - last.lon) + Math.abs(rows[i].lat - last.lat)
        + (Math.abs(rows[i].height - last.height) / 1e5);
      if (moved > 1e-7) return last.t - rows[i].t;
    }
    return last.t - rows[0].t;
  });

  const budgetMs = Math.min(180000, ((flight.durationS || 40) + 10) * 1000);
  const shots = [];
  const startedAt = Date.now();
  let shotIndex = 0;
  while (Date.now() - startedAt < budgetMs) {
    const file = path.join(OUT_DIR, `flight-${String(shotIndex).padStart(2, '0')}.png`);
    const at = await page.evaluate(() => performance.now());
    await page.screenshot({ path: file });
    shots.push({ file, at });
    shotIndex += 1;
    await sleep(SHOT_EVERY_MS);
    if (Date.now() - startedAt > 5000 && (await stillForMs()) > 1500) break;
  }
  const trace = await readTrace();
  await page.evaluate(() => window.__gevFlyTraceRemove?.());
  report(shots.length >= 6, 'screenshot sequence captured', `${shots.length} frames @ ${SHOT_EVERY_MS}ms`);

  // ── Measure the REAL camera ───────────────────────────────────────────
  // Only the dolly's own frames count. The sampler is installed before the
  // flight, so the pre-flight view and the single frame that jumps the camera
  // onto the route start are dropped — neither is dolly motion.
  const flightStartT = trace.marks.find((m) => m.label === 'flight-start')?.t ?? 0;
  const rows = trace.rows.filter((r) => r.t > flightStartT).slice(1);
  const fps = rows.length / Math.max(0.001, (rows.at(-1).t - rows[0].t) / 1000);
  report(rows.length > 60, 'camera sampled every rendered frame',
    `${rows.length} dolly samples (${trace.rows.length} total) at ${fps.toFixed(1)} fps`);

  const rolls = rows.map((r) => wrapDeg(r.rollDeg));
  const peakRoll = Math.max(...rolls.map(Math.abs));
  report(peakRoll <= 10.5, 'bank never exceeds the 10° cap', `peak |roll| = ${peakRoll.toFixed(2)}°`);
  report(peakRoll > 3, 'turns actually bank', `peak |roll| = ${peakRoll.toFixed(2)}°`);
  report(Math.abs(rolls[0]) < 1 && Math.abs(rolls.at(-1)) < 3,
    'the flight starts and finishes near wings level',
    `first=${rolls[0].toFixed(2)}° last=${rolls.at(-1).toFixed(2)}°`);

  // Roll follows the turn: while banked, roll sign must match heading rate.
  // Sampled over ~1 s of heading change, and only where BOTH the roll and the
  // turn are unambiguous (a roll-out trails its turn by design, so the tail of
  // every corner is deliberately outside the window).
  let agree = 0;
  let disagree = 0;
  const span = Math.max(2, Math.round(fps));
  for (let i = span; i < rows.length; i += 1) {
    const dt = (rows[i].t - rows[i - span].t) / 1000;
    if (!(dt > 0)) continue;
    const headingRate = wrapDeg(rows[i].headingDeg - rows[i - span].headingDeg) / dt;
    const roll = wrapDeg(rows[i].rollDeg);
    if (Math.abs(roll) < 2 || Math.abs(headingRate) < 3) continue;
    if (Math.sign(roll) === Math.sign(headingRate)) agree += 1; else disagree += 1;
  }
  const agreement = agree / Math.max(1, agree + disagree);
  report(agreement > 0.85, 'the camera rolls INTO the turn (right turn → right bank)',
    `${(agreement * 100).toFixed(1)}% of banked samples agree (${agree}/${agree + disagree})`);

  // Every rate below is measured over ~250 ms windows. A per-frame difference
  // is dominated by the pairing jitter between the motion tick's own clock and
  // postRender (a 36 ms frame next to an 8 ms one doubles any per-frame rate),
  // which measures the harness, not the dolly.
  const RATE_WINDOW_MS = 250;
  const peakRate = (valueAt) => {
    let worst = 0;
    for (let i = 0, j = 0; i < rows.length; i += 1) {
      while (j < rows.length - 1 && rows[j].t - rows[i].t < RATE_WINDOW_MS) j += 1;
      const dt = (rows[j].t - rows[i].t) / 1000;
      if (dt >= RATE_WINDOW_MS / 2000) worst = Math.max(worst, Math.abs(valueAt(j) - valueAt(i)) / dt);
    }
    return worst;
  };

  const peakRollRate = peakRate((i) => rolls[i]);
  report(peakRollRate < 20, 'the roll enters and exits smoothly, never snaps',
    `peak roll rate ${peakRollRate.toFixed(1)} °/s over ${RATE_WINDOW_MS} ms`);

  // Speed: eased at both ends, no step in between. Measured over 400 ms
  // windows — the per-frame delta is dominated by the pairing jitter between
  // the motion tick's own clock and postRender, not by the dolly.
  const cumulative = [0];
  for (let i = 1; i < rows.length; i += 1) {
    cumulative.push(cumulative[i - 1] + sampleDistanceM(rows[i - 1], rows[i]));
  }
  const speeds = [];
  for (let i = 0, j = 0; i < rows.length; i += 1) {
    while (j < rows.length - 1 && rows[j].t - rows[i].t < 400) j += 1;
    const dt = (rows[j].t - rows[i].t) / 1000;
    if (dt >= 0.3) speeds.push({ t: rows[i].t - rows[0].t, v: (cumulative[j] - cumulative[i]) / dt });
  }
  const window1s = (from, to) => {
    const inWindow = speeds.filter((s) => s.t >= from && s.t <= to);
    return inWindow.length ? inWindow.reduce((sum, s) => sum + s.v, 0) / inWindow.length : Number.NaN;
  };
  const peakV = Math.max(...speeds.map((s) => s.v));
  const firstSecond = window1s(0, 1200);
  report(firstSecond < peakV * 0.5, 'the dolly eases IN (no velocity step at the start)',
    `first 1.2 s ${firstSecond.toFixed(1)} m/s vs peak ${peakV.toFixed(1)} m/s`);

  // Ease-out is measured as the SHAPE of the decay, not as a terminal window.
  // The sampler keeps running after the dolly stops, so a trailing average
  // includes stationary frames — under which a hard stop also reports ~0 m/s
  // and passes. How long the speed takes to fall from 90% to 10% of peak is
  // immune to that tail: a ramp spreads it over a second or more, a hard stop
  // collapses it into a single frame.
  const lastAbove = (fraction) => {
    for (let i = speeds.length - 1; i >= 0; i -= 1) if (speeds[i].v >= peakV * fraction) return speeds[i].t;
    return Number.NaN;
  };
  const decayMs = lastAbove(0.1) - lastAbove(0.9);
  report(decayMs > 800, 'the dolly eases OUT over a real ramp, not a hard stop',
    `speed fell 90% → 10% of peak over ${decayMs.toFixed(0)} ms (a hard stop collapses to one frame)`);
  const riseMs = (() => {
    const first = (fraction) => speeds.find((s) => s.v >= peakV * fraction)?.t ?? Number.NaN;
    return first(0.9) - first(0.1);
  })();
  report(riseMs > 800, 'and eases IN over one too',
    `speed rose 10% → 90% of peak over ${riseMs.toFixed(0)} ms`);
  report(peakV < 40 * 1.35, 'the easing keeps the shipped pace — the plateau IS the speed word',
    `peak ${peakV.toFixed(1)} m/s over a 40 m/s mean (${(flight.distanceM / flight.durationS).toFixed(1)} m/s reported)`);
  // Acceleration, differenced across NON-overlapping speed windows so the
  // 400 ms averaging is not differentiated against itself.
  let peakAccel = 0;
  for (let i = 0, j = 0; i < speeds.length; i += 1) {
    while (j < speeds.length - 1 && speeds[j].t - speeds[i].t < 400) j += 1;
    const dt = (speeds[j].t - speeds[i].t) / 1000;
    if (dt >= 0.3) peakAccel = Math.max(peakAccel, Math.abs(speeds[j].v - speeds[i].v) / dt);
  }
  report(peakAccel < 40, 'no velocity discontinuity anywhere on the route',
    `peak |acceleration| ${peakAccel.toFixed(1)} m/s² (a hard start would read in the hundreds)`);

  // Altitude shaping and terrain clearance, read off the real camera.
  const heights = rows.map((r) => r.height);
  const floors = await page.evaluate(async (samples) => {
    try {
      const mod = await import('/src/data/groundFloor.js');
      return samples.map(({ lat, lon }) => mod.cachedGroundFloor(lat, lon));
    } catch { return samples.map(() => null); }
  }, rows.map((r) => ({ lat: r.lat, lon: r.lon })));
  // The strongest terrain check available: the eye against the RENDERED
  // surface under it, sampled live. Independent of our own floor cache, and
  // therefore the one that would catch flying inside a building or a hillside.
  const probed = rows.filter((r) => Number.isFinite(r.surfaceM));
  if (probed.length > 20) {
    let worst = Infinity;
    let worstAt = null;
    for (const row of probed) {
      const clearance = row.height - row.surfaceM;
      if (clearance < worst) { worst = clearance; worstAt = row; }
    }
    report(worst > 0, 'the eye is never inside the RENDERED world',
      `min clearance over the rendered surface ${worst.toFixed(1)} m across ${probed.length} live probes`
      + (worstAt ? ` (worst at ${worstAt.lat.toFixed(5)}, ${worstAt.lon.toFixed(5)})` : ''));
  } else {
    note('rendered-surface clearance', `only ${probed.length} live mesh probes answered`);
  }
  const warm = floors.map((f, i) => (Number.isFinite(f) ? heights[i] - f : null)).filter((v) => v !== null);
  if (warm.length > 20) {
    const minAgl = Math.min(...warm);
    const maxAgl = Math.max(...warm);
    report(minAgl >= 90, 'the eye always clears the rendered floor',
      `min AGL ${minAgl.toFixed(1)} m, max ${maxAgl.toFixed(1)} m over ${warm.length} warm samples`);
  } else {
    note('terrain clearance', `only ${warm.length} warm floor cells under the route — clearance clamp is pinned in npm test`);
  }
  // The floor ACQUISITION — the one frame where a cold-corridor safety seed is
  // replaced by real terrain — is deliberately a single step, and it lands in
  // the same moment the camera teleports onto the route start. It is measured
  // separately from the shaping, which must be a swell for the whole flight.
  const cruiseFrom = rows.findIndex((r) => r.t - rows[0].t > 1500);
  const cruiseRows = cruiseFrom > 0 ? rows.slice(cruiseFrom) : rows;
  const cruiseHeights = cruiseRows.map((r) => r.height);
  // Split the two directions: a DESCENT is capped by the dolly (never drop the
  // eye toward ground it is still learning about), while a CLIMB is deliberately
  // uncapped — rising is the safety direction, and a terrain rise plus the
  // shaping swell can legitimately exceed the descent cap.
  let peakDescentMps = 0;
  let peakClimbMps = 0;
  for (let i = 0, j = 0; i < cruiseRows.length; i += 1) {
    while (j < cruiseRows.length - 1 && cruiseRows[j].t - cruiseRows[i].t < RATE_WINDOW_MS) j += 1;
    const dt = (cruiseRows[j].t - cruiseRows[i].t) / 1000;
    if (dt < RATE_WINDOW_MS / 2000) continue;
    const rate = (cruiseHeights[j] - cruiseHeights[i]) / dt;
    if (rate < 0) peakDescentMps = Math.max(peakDescentMps, -rate);
    else peakClimbMps = Math.max(peakClimbMps, rate);
  }
  const peakVerticalMps = Math.max(peakDescentMps, peakClimbMps);
  const acquisitionM = Math.abs(heights[0] - cruiseHeights[0]);
  const cruiseRangeM = Math.max(...cruiseHeights) - Math.min(...cruiseHeights);
  report(cruiseRangeM > 5, 'altitude breathes rather than sitting flat',
    `${cruiseRangeM.toFixed(1)} m of vertical range in cruise`);
  report(cruiseRangeM < 120, 'and the cruise altitude never wanders far from its mean',
    `${cruiseRangeM.toFixed(1)} m of range after a ${acquisitionM.toFixed(0)} m floor acquisition at the start`);
  // Smoothness is measured on the camera's ABSOLUTE vertical motion, because
  // that is what a viewer sees. It is tempting to difference AGL instead, to
  // separate "our shaping" from "the hill" — but the floor is a ~111 m
  // staircase, so an AGL series steps at every cell boundary even when the eye
  // is gliding. Differencing it measures the quantization, not the ride
  // (measured: 31.6 m/s of "AGL rate" while the eye moved at 8.9 m/s).
  report(peakDescentMps < 10.5, 'the eye is never DROPPED — descent stays inside its cap',
    `peak descent ${peakDescentMps.toFixed(1)} m/s (cap 10 m/s)`);
  report(peakClimbMps < 20, 'and climbs stay a swell rather than a lurch',
    `peak climb ${peakClimbMps.toFixed(1)} m/s against ~40 m/s of ground speed`);

  const pitches = rows.map((r) => r.pitchDeg);
  const pitchSpread = Math.max(...pitches) - Math.min(...pitches);
  report(pitchSpread < 2, 'the look-down angle stays locked (no pitch wobble)',
    `pitch ${Math.min(...pitches).toFixed(1)}°..${Math.max(...pitches).toFixed(1)}°`);

  // ── Run 2: interrupt the dolly MID-BANK ───────────────────────────────
  // Cutting a level camera proves nothing about levelling, so this waits for
  // the live camera to actually be rolled before it grabs the controls.
  await sleep(1500);
  await installSampler();
  const second = await run('fly_route', { label: 'cinema evidence', speed: 'normal' });
  report(second?.ok === true, 'second flight starts for the interrupt case');
  const liveRollDeg = () => page.evaluate(
    () => (window.__godsEyeView.viewer.camera.roll * 180) / Math.PI,
  );
  let rollBeforeCut = 0;
  for (let waited = 0; waited < 90000; waited += 400) {
    rollBeforeCut = wrapDeg(await liveRollDeg());
    if (Math.abs(rollBeforeCut) >= 3) break;
    await sleep(400);
  }
  report(Math.abs(rollBeforeCut) >= 3, 'the dolly is genuinely banked before the cut',
    `live camera roll ${rollBeforeCut.toFixed(2)}°`);
  await page.screenshot({ path: path.join(OUT_DIR, 'interrupt-0-banked.png') });

  const cut = await page.evaluate(async () => {
    const viewer = window.__godsEyeView.viewer;
    const canvas = viewer.scene.canvas;
    // Read the motion slot BEFORE the cut too: under Vite a dynamic import can
    // hand back a second module instance whose slot is always empty, and an
    // "empty after" that was already empty before proves nothing.
    let read = null;
    let slotBefore = 'module-unavailable';
    let slotAfter = 'module-unavailable';
    try {
      const mod = await import('/src/cameraVerbs.js');
      read = () => mod.getActiveCameraMotion?.() ?? null;
      slotBefore = read();
    } catch { /* dev-only module read */ }
    const rollBefore = (viewer.camera.roll * 180) / Math.PI;
    window.__gevFlyTrace.marks.push({ label: 'pointerdown', t: performance.now() });
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    // Same synchronous turn as the pointerdown — no frame has rendered yet.
    const rollAfter = (viewer.camera.roll * 180) / Math.PI;
    if (read) slotAfter = read();
    return { slotBefore, slotAfter, rollBefore, rollAfter };
  });
  // The camera-side proof, which needs no module identity at all: a banked
  // horizon is level again inside the same synchronous turn as the pointerdown.
  report(
    Math.abs(wrapDeg(cut.rollBefore)) >= 3 && Math.abs(wrapDeg(cut.rollAfter)) < 0.01,
    'the release levels the horizon synchronously — no tilt left behind',
    `roll ${wrapDeg(cut.rollBefore).toFixed(2)}° → ${wrapDeg(cut.rollAfter).toFixed(4)}° in the same turn`,
  );
  if (cut.slotBefore && cut.slotBefore !== 'module-unavailable') {
    report(cut.slotAfter === null, 'a manual pointerdown frees the motion slot synchronously',
      `active before the cut: ${cut.slotBefore.kind}@${(cut.slotBefore.progress * 100).toFixed(0)}% → after: ${JSON.stringify(cut.slotAfter)}`);
  } else {
    note('motion-slot read',
      'the dev server handed the harness a second module instance (HMR); the camera-side roll and freeze checks carry the proof');
  }
  await sleep(2500);
  const rollAfterSettle = wrapDeg(await liveRollDeg());
  report(Math.abs(rollAfterSettle) < 0.01, 'and the horizon STAYS level after the cut',
    `roll ${rollAfterSettle.toFixed(4)}° 2.5 s later`);
  await page.screenshot({ path: path.join(OUT_DIR, 'interrupt-1-level.png') });
  const cutTrace = await readTrace();
  await page.evaluate(() => window.__gevFlyTraceRemove?.());

  const cutAt = cutTrace.marks.at(-1)?.t ?? 0;
  const before = cutTrace.rows.filter((r) => r.t < cutAt);
  const after = cutTrace.rows.filter((r) => r.t >= cutAt);
  const movementBefore = before.length > 2
    ? sampleDistanceM(before.at(-3), before.at(-1)) : Number.NaN;
  let movementAfter = 0;
  for (let i = 1; i < after.length; i += 1) {
    movementAfter = Math.max(movementAfter, sampleDistanceM(after[i - 1], after[i]));
  }
  report(movementBefore > 0.5 && movementAfter < 0.5,
    'the camera freezes on the cut frame — no coast, no snap-back',
    `moved ${movementBefore.toFixed(2)} m/frame before, max ${movementAfter.toFixed(3)} m/frame after (${after.length} frames)`);

  fs.writeFileSync(
    path.join(OUT_DIR, 'trace.json'),
    JSON.stringify({
      url: APP_URL,
      flight,
      shots: shots.map((s) => path.basename(s.file)),
      samples: rows.length,
      peakRollDeg: peakRoll,
      peakRollRateDegS: peakRollRate,
      rollTurnAgreement: agreement,
      peakSpeedMps: peakV,
      peakAccelMps2: peakAccel,
      peakVerticalMps,
      peakDescentMps,
      peakClimbMps,
      easeInMps: firstSecond,
      easeInRampMs: riseMs,
      easeOutRampMs: decayMs,
      heightRangeM: [Math.min(...heights), Math.max(...heights)],
      cruiseHeightRangeM: cruiseRangeM,
      floorAcquisitionM: acquisitionM,
      pitchRangeDeg: [Math.min(...pitches), Math.max(...pitches)],
      finalRollDeg: rolls.at(-1),
      terrainDelayMs: TERRAIN_DELAY_MS,
      interrupt: {
        movementBefore,
        movementAfter,
        framesAfter: after.length,
        rollBeforeCutDeg: wrapDeg(cut.rollBefore),
        rollAfterCutDeg: wrapDeg(cut.rollAfter),
        rollAfterSettleDeg: rollAfterSettle,
      },
      series: rows.map((r) => ({
        t: Number((r.t - rows[0].t).toFixed(0)),
        roll: Number(wrapDeg(r.rollDeg).toFixed(3)),
        heading: Number(r.headingDeg.toFixed(2)),
        pitch: Number(r.pitchDeg.toFixed(2)),
        height: Number(r.height.toFixed(1)),
      })),
    }, null, 2),
  );
  // Contact sheet: the sequence in one image, each tile stamped with the
  // elapsed time and the roll the camera was actually holding at that moment.
  const nearestRow = (at) => rows.reduce(
    (best, row) => (Math.abs(row.t - at) < Math.abs(best.t - at) ? row : best), rows[0],
  );
  const cols = 5;
  const tileW = 384;
  const tileH = Math.round((950 / 1500) * tileW);
  const labelH = 26;
  const gap = 6;
  const sheetRows = Math.ceil(shots.length / cols);
  const sheetW = (cols * tileW) + ((cols + 1) * gap);
  const sheetH = (sheetRows * (tileH + labelH)) + ((sheetRows + 1) * gap);
  const composites = [];
  const labels = [];
  for (let i = 0; i < shots.length; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const left = gap + (col * (tileW + gap));
    const top = gap + (row * (tileH + labelH + gap));
    composites.push({
      input: await sharp(shots[i].file).resize(tileW, tileH, { fit: 'fill' }).toBuffer(),
      left,
      top,
    });
    const near = nearestRow(shots[i].at);
    const elapsed = ((near.t - rows[0].t) / 1000).toFixed(0);
    const roll = wrapDeg(near.rollDeg);
    const sign = roll >= 0 ? '+' : '−';
    labels.push(`<text x="${left + 6}" y="${top + tileH + 18}" font-family="monospace" font-size="15" fill="#8fe9ff">`
      + `${String(i).padStart(2, '0')}  t=${elapsed}s  roll ${sign}${Math.abs(roll).toFixed(1)}°  alt ${near.height.toFixed(0)}m</text>`);
  }
  composites.push({
    input: Buffer.from(`<svg width="${sheetW}" height="${sheetH}">${labels.join('')}</svg>`),
    left: 0,
    top: 0,
  });
  const sheetPath = path.join(OUT_DIR, 'sequence-contact-sheet.jpg');
  await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: '#05080d' } })
    .composite(composites)
    .jpeg({ quality: 86 })
    .toFile(sheetPath);
  console.log(`  contact sheet → ${sheetPath}`);

  if (MIRROR_DIR) {
    // Mirror as JPEG: the PNG sequence is ~80 MB, which is a poor thing to
    // hand a human who just wants to flip through the shot.
    for (const entry of fs.readdirSync(OUT_DIR)) {
      const from = path.join(OUT_DIR, entry);
      if (entry.endsWith('.png')) {
        await sharp(from).jpeg({ quality: 80 })
          .toFile(path.join(MIRROR_DIR, entry.replace(/\.png$/, '.jpg')));
      } else {
        fs.copyFileSync(from, path.join(MIRROR_DIR, entry));
      }
    }
  }
} catch (error) {
  report(false, 'harness completed', String(error?.message || error).slice(0, 200));
} finally {
  await browser.close();
}

const failed = results.filter((r) => r.ok === false).length;
const passed = results.filter((r) => r.ok === true).length;
console.log(`\n  ${passed} passed, ${failed} failed → ${OUT_DIR}`);
process.exitCode = failed ? 1 : 0;
