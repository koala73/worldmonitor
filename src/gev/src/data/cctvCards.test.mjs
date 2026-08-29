// src/data/cctvCards.test.mjs
// Pure-helper tests for the ambient CCTV thumbnail-card overlay: greedy
// declutter, the no-flicker frame-persistence rule, retry pacing, and the
// bounded thumbnail-cache prune. Rendering geometry (placeCard/cardAlpha) is
// shared with firmsLabels.js and covered by firmsLabels.test.mjs; the radial
// keyhole edge fade is covered by the celestialRing suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CCTV_CARD_FADE_END_M,
  CCTV_CARD_FADE_START_M,
  CCTV_CARD_FETCH_BURST_LIMIT,
  CCTV_CARD_FETCH_BURST_SPACING_MS,
  CCTV_CARD_FETCH_STEADY_SPACING_MS,
  CCTV_CARD_MIN_SEP_PX,
  CCTV_CARD_SCALE_AT_MID,
  CCTV_CARD_SCALE_FULL_M,
  CCTV_CARD_SCALE_MID_M,
  CCTV_CARD_SCALE_MIN,
  CCTV_FRAME_CACHE_MAX,
  applyFrameResult,
  cardFetchPolicy,
  cardScaleForAltitude,
  createCctvThumbnailOverlayEntry,
  createFrameSlot,
  declutterCctvCards,
  frameFetchDue,
  frameRetryDelayMs,
  isCctvCardAnchorSafe,
  planFrameCachePrune,
} from './cctvCards.js';

test('isCctvCardAnchorSafe protects the top HUD band for ambient cards', () => {
  assert.equal(isCctvCardAnchorSafe({ sy: 100, viewH: 1000 }), false);
  assert.equal(isCctvCardAnchorSafe({ sy: 150, viewH: 1000 }), true);
  assert.equal(isCctvCardAnchorSafe({ sy: 100, viewH: 1000, pinned: true }), true);
  assert.equal(isCctvCardAnchorSafe({ sy: NaN, viewH: 1000 }), false);
});

// ─── declutterCctvCards ──────────────────────────────────────────────────────

test('declutterCctvCards: nearest-first greedy accept with min separation', () => {
  const kept = declutterCctvCards([
    { id: 'far', sx: 100, sy: 100, distanceKm: 5 },
    { id: 'near', sx: 110, sy: 110, distanceKm: 1 },   // wins the overlap: nearer
    { id: 'clear', sx: 400, sy: 400, distanceKm: 9 },
  ], { minSepPx: 130 });
  assert.deepEqual(kept, ['near', 'clear']);
});

test('declutterCctvCards: separation is radial (Euclidean), matching the vessel pass', () => {
  // 100px apart on one axis: inside a 130px separation, outside a 90px one.
  const candidates = [
    { id: 'a', sx: 0, sy: 0, distanceKm: 1 },
    { id: 'b', sx: 100, sy: 0, distanceKm: 2 },
  ];
  assert.deepEqual(declutterCctvCards(candidates, { minSepPx: 130 }), ['a']);
  assert.deepEqual(declutterCctvCards(candidates, { minSepPx: 90 }), ['a', 'b']);
});

test('declutterCctvCards: respects the limit and drops malformed rows', () => {
  const kept = declutterCctvCards([
    { id: 'a', sx: 0, sy: 0, distanceKm: 1 },
    { id: 'b', sx: 500, sy: 0, distanceKm: 2 },
    { id: 'c', sx: 1000, sy: 0, distanceKm: 3 },
    { id: '', sx: 200, sy: 200, distanceKm: 0 },
    { id: 'nan', sx: NaN, sy: 0, distanceKm: 0 },
    null,
  ], { minSepPx: 130, limit: 2 });
  assert.deepEqual(kept, ['a', 'b']);
});


test('thumbnail entry carries the exact shipped contract and stable frame-slot reference', () => {
  const frameSlot = createFrameSlot();
  const entry = createCctvThumbnailOverlayEntry({
    id: 'cam-a',
    position: { x: 1, y: 2, z: 3 },
    title: 'Main & 5th',
    frameSlot,
    rank: 2,
  });
  assert.equal(entry.variant, 'thumbnail');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.paintLane, 'thumbnail');
  assert.equal(entry.interactive, true);
  assert.equal(entry.image, frameSlot, 'host receives the source-owned stable slot by reference');
  assert.equal(entry.thumbnailWidth, 96);
  assert.equal(entry.thumbnailHeight, 54);
  assert.equal(entry.thumbnailPadX, 4);
  assert.equal(entry.thumbnailTitleHeight, 13);
  assert.equal(entry.requireImage, true);
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.verticalOnly, true);
  assert.equal(entry.gapPx, 22);
  assert.equal(entry.leaderOffsetPx, 16);
  // CCTV shipped as a stateless per-frame rebuild with an anchor-separation
  // pass. Both are opt-ins on the shared host: without them the arbiter's
  // min-lifetime/cooldown/sticky-corner hysteresis makes cards stick below
  // their icon and take ~1.5 s to return, and rectangle overlap alone lets them
  // stack about twice as densely as shipped.
  assert.equal(entry.stateless, true);
  assert.equal(entry.minAnchorSeparationPx, CCTV_CARD_MIN_SEP_PX);
});

test('active CCTV thumbnail is protected while ambient and pinned policies stay distinct', () => {
  const base = { id: 'cam-a', position: { x: 1, y: 2, z: 3 }, title: 'A', frameSlot: createFrameSlot() };
  const ambient = createCctvThumbnailOverlayEntry(base);
  const pinned = createCctvThumbnailOverlayEntry({ ...base, pinned: true });
  const active = createCctvThumbnailOverlayEntry({ ...base, active: true });
  assert.equal(ambient.protected, false);
  assert.equal(ambient.pinned, false);
  assert.equal(pinned.pinned, true);
  assert.equal(active.protected, true);
  assert.ok(active.priority > pinned.priority && pinned.priority > ambient.priority);
});

test('CCTV card module cannot resurrect a canvas, projection, listener, or private hit store', () => {
  const source = readFileSync(new URL('./cctvCards.js', import.meta.url), 'utf8');
  const forbidden = [
    /createElement\(\s*['"]canvas['"]\s*\)/,
    /postRender\.addEventListener/,
    /cartesianToCanvasCoordinates/,
    /SceneTransforms/,
    /hitTestCctvCard/,
    /setCctvCardHitRects/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
});

// ─── cardScaleForAltitude — the validated altitude curve (finding 5) ────

test('cardScaleForAltitude: full size and opacity at or below 1,800 m', () => {
  assert.deepEqual(cardScaleForAltitude(0), { scale: 1, alpha: 1 });
  assert.deepEqual(cardScaleForAltitude(CCTV_CARD_SCALE_FULL_M), { scale: 1, alpha: 1 });
  assert.deepEqual(cardScaleForAltitude(NaN), { scale: 1, alpha: 1 });
});

test('cardScaleForAltitude: hits the validated waypoints', () => {
  const mid = cardScaleForAltitude(CCTV_CARD_SCALE_MID_M);
  assert.ok(Math.abs(mid.scale - CCTV_CARD_SCALE_AT_MID) < 1e-9, 'scale ~0.45 at 6,000 m');
  assert.equal(mid.alpha, 1);
  const fadeStart = cardScaleForAltitude(CCTV_CARD_FADE_START_M);
  assert.equal(fadeStart.alpha, 1, 'still opaque at 7,500 m');
  assert.ok(fadeStart.scale < CCTV_CARD_SCALE_AT_MID, 'keeps shrinking slightly past 6,000 m');
  const midFade = cardScaleForAltitude((CCTV_CARD_FADE_START_M + CCTV_CARD_FADE_END_M) / 2);
  assert.ok(Math.abs(midFade.alpha - 0.5) < 1e-9, 'linear fade midpoint');
});

test('cardScaleForAltitude: fully hidden at and above the 9,500 m ceiling', () => {
  assert.equal(cardScaleForAltitude(CCTV_CARD_FADE_END_M).alpha, 0);
  assert.equal(cardScaleForAltitude(50_000).alpha, 0);
  assert.equal(cardScaleForAltitude(50_000).scale, CCTV_CARD_SCALE_MIN);
});

test('cardScaleForAltitude: scale and alpha are monotonic non-increasing', () => {
  let prev = cardScaleForAltitude(0);
  for (let h = 100; h <= 12_000; h += 100) {
    const cur = cardScaleForAltitude(h);
    assert.ok(cur.scale <= prev.scale + 1e-12, `scale rises at ${h} m`);
    assert.ok(cur.alpha <= prev.alpha + 1e-12, `alpha rises at ${h} m`);
    assert.ok(cur.scale >= CCTV_CARD_SCALE_MIN - 1e-12);
    prev = cur;
  }
});

// ─── cardFetchPolicy — cold-fill burst pacing (finding 3) ───────────────────

test('cardFetchPolicy: cold fill bursts up to 4 in flight at 250 ms spacing', () => {
  assert.deepEqual(
    cardFetchPolicy({ coldFill: true, inFlight: 0, sinceLastLaunchMs: CCTV_CARD_FETCH_BURST_SPACING_MS }),
    { mode: 'burst', launch: true }
  );
  assert.deepEqual(
    cardFetchPolicy({ coldFill: true, inFlight: CCTV_CARD_FETCH_BURST_LIMIT - 1, sinceLastLaunchMs: 260 }),
    { mode: 'burst', launch: true }
  );
  // Blocked at the concurrency cap and inside the launch spacing.
  assert.equal(cardFetchPolicy({ coldFill: true, inFlight: CCTV_CARD_FETCH_BURST_LIMIT, sinceLastLaunchMs: 9_999 }).launch, false);
  assert.equal(cardFetchPolicy({ coldFill: true, inFlight: 0, sinceLastLaunchMs: CCTV_CARD_FETCH_BURST_SPACING_MS - 1 }).launch, false);
});

test('cardFetchPolicy: steady state keeps the 1-fetch/s single-flight gate', () => {
  assert.deepEqual(
    cardFetchPolicy({ coldFill: false, inFlight: 0, sinceLastLaunchMs: CCTV_CARD_FETCH_STEADY_SPACING_MS }),
    { mode: 'steady', launch: true }
  );
  // An in-flight fetch blocks the tick; so does the 1 s spacing.
  assert.equal(cardFetchPolicy({ coldFill: false, inFlight: 1, sinceLastLaunchMs: 9_999 }).launch, false);
  assert.equal(cardFetchPolicy({ coldFill: false, inFlight: 0, sinceLastLaunchMs: 999 }).launch, false);
  // First-ever launch (no prior fetch) is immediate.
  assert.equal(cardFetchPolicy({ coldFill: false, inFlight: 0 }).launch, true);
});

// ─── applyFrameResult — the no-flicker persistence rule ─────────────────────

test('applyFrameResult: success replaces the frame and stamps it', () => {
  const slot = createFrameSlot();
  const next = applyFrameResult(slot, { ok: true, frame: 'FRAME-1' }, 5_000);
  assert.deepEqual(next, { frame: 'FRAME-1', stamp: 5_000, failCount: 0, lastAttemptAt: 5_000 });
});

test('applyFrameResult: a FAILED fetch persists the drawn frame and stamp', () => {
  const drawn = applyFrameResult(createFrameSlot(), { ok: true, frame: 'FRAME-1' }, 5_000);
  const afterFail = applyFrameResult(drawn, { ok: false }, 65_000);
  // The owner's zero-flicker rule: the card keeps rendering FRAME-1.
  assert.equal(afterFail.frame, 'FRAME-1');
  assert.equal(afterFail.stamp, 5_000);
  assert.equal(afterFail.failCount, 1);
  assert.equal(afterFail.lastAttemptAt, 65_000);
  // A later success replaces it and clears the failure streak.
  const recovered = applyFrameResult(afterFail, { ok: true, frame: 'FRAME-2' }, 130_000);
  assert.equal(recovered.frame, 'FRAME-2');
  assert.equal(recovered.stamp, 130_000);
  assert.equal(recovered.failCount, 0);
});

test('applyFrameResult: an ok result without a frame counts as a failure', () => {
  const drawn = applyFrameResult(createFrameSlot(), { ok: true, frame: 'FRAME-1' }, 5_000);
  const next = applyFrameResult(drawn, { ok: true }, 9_000);
  assert.equal(next.frame, 'FRAME-1');
  assert.equal(next.failCount, 1);
});

// ─── frameRetryDelayMs / frameFetchDue ──────────────────────────────────────

test('frameRetryDelayMs: doubles per failure, capped at 5 minutes', () => {
  assert.equal(frameRetryDelayMs(0), 15_000);
  assert.equal(frameRetryDelayMs(1), 30_000);
  assert.equal(frameRetryDelayMs(2), 60_000);
  assert.equal(frameRetryDelayMs(10), 300_000);
});

test('frameFetchDue: an untouched slot is due immediately', () => {
  assert.equal(frameFetchDue(createFrameSlot(), 300_000, 1_000), true);
  assert.equal(frameFetchDue(null, 300_000, 1_000), false);
});

test('frameFetchDue: a fresh frame is not due until its cadence elapses', () => {
  const slot = applyFrameResult(createFrameSlot(), { ok: true, frame: 'F' }, 10_000);
  assert.equal(frameFetchDue(slot, 300_000, 10_000 + 299_999), false);
  assert.equal(frameFetchDue(slot, 300_000, 10_000 + 300_000), true);
});

test('frameFetchDue: failures back off instead of hammering the source', () => {
  let slot = applyFrameResult(createFrameSlot(), { ok: false }, 10_000);
  // First retry waits the doubled delay (failCount=1 -> 30s).
  assert.equal(frameFetchDue(slot, 300_000, 10_000 + 29_999), false);
  assert.equal(frameFetchDue(slot, 300_000, 10_000 + 30_000), true);
  // A slot with a PERSISTED frame still backs off between failed refreshes.
  slot = applyFrameResult(createFrameSlot(), { ok: true, frame: 'F' }, 0);
  slot = applyFrameResult(slot, { ok: false }, 300_000);
  assert.equal(frameFetchDue(slot, 300_000, 300_000 + 20_000), false);
  assert.equal(frameFetchDue(slot, 300_000, 300_000 + 30_000), true);
});

// ─── planFrameCachePrune ────────────────────────────────────────────────────

test('planFrameCachePrune: never drops live card ids (grace included)', () => {
  const slots = [
    { id: 'live-1', stamp: 10 },
    { id: 'graced', stamp: 5 },
    { id: 'old', stamp: 1 },
  ];
  const drops = planFrameCachePrune(slots, ['live-1', 'graced'], 2);
  assert.deepEqual(drops, ['old']);
});

test('planFrameCachePrune: spare slots kept newest-first up to the cap', () => {
  const slots = [
    { id: 'live', stamp: 100 },
    { id: 'spare-new', stamp: 90 },
    { id: 'spare-mid', stamp: 50 },
    { id: 'spare-old', stamp: 10 },
  ];
  const drops = planFrameCachePrune(slots, ['live'], 3);
  assert.deepEqual(drops.sort(), ['spare-old']);
  assert.deepEqual(planFrameCachePrune(slots, ['live'], 1).sort(),
    ['spare-mid', 'spare-new', 'spare-old']);
});

test('planFrameCachePrune: default cap is the exported cache bound', () => {
  const slots = Array.from({ length: CCTV_FRAME_CACHE_MAX + 5 }, (_, i) => ({
    id: `cam-${String(i).padStart(3, '0')}`,
    stamp: i,
  }));
  const drops = planFrameCachePrune(slots, []);
  assert.equal(drops.length, 5);
  // Oldest stamps go first.
  assert.deepEqual(drops.sort(), ['cam-000', 'cam-001', 'cam-002', 'cam-003', 'cam-004']);
});
