// src/data/cctvLod.test.mjs
// Pure LOD-engine tests, adapted from earlier Part C suite
// zoom-scaled card budgets, nearest-first in-view
// selection, video exclusion, the eviction-grace planner, and source-aware
// static-frame pacing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_CARD_CENTER_WEIGHT,
  CCTV_CARD_INCUMBENT_FACTOR,
  CCTV_LOD_GRACE_MS,
  CCTV_LOD_GRACE_PASSES,
  CCTV_AMBIENT_CARD_MAX,
  CCTV_AMBIENT_CARD_MID,
  CCTV_AMBIENT_CARD_MIN,
  applyEvictionGrace,
  blendCenterRankKm,
  cctvCandidateSpreadKm,
  cctvLodBudgets,
  distributeCctvCards,
  hasFiniteCctvViewport,
  incumbentRankKm,
  screenCenterFraction,
  selectCctvLod,
  staticFrameRefreshMs,
} from './cctvLod.js';

function candidates(count, options = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `cam-${String(index).padStart(3, '0')}`,
    distanceKm: index / 10,
    inView: options.hiddenAt !== index,
    isVideo: options.videoAt === index,
  }));
}

test('cctvLodBudgets scales the card budget from 20 to 40 with view height', () => {
  // Follow-up round 2 (item C): budgets raised 16/24/32 -> 20/28/40.
  assert.equal(CCTV_AMBIENT_CARD_MIN, 20);
  assert.equal(CCTV_AMBIENT_CARD_MID, 28);
  assert.equal(CCTV_AMBIENT_CARD_MAX, 40);
  assert.deepEqual(cctvLodBudgets(500), { cardLimit: CCTV_AMBIENT_CARD_MIN });
  assert.deepEqual(cctvLodBudgets(8_000), { cardLimit: CCTV_AMBIENT_CARD_MID });
  assert.deepEqual(cctvLodBudgets(30_000), { cardLimit: CCTV_AMBIENT_CARD_MAX });
});

test('selectCctvLod caps ambient cards at the 40 hard cap regardless of catalog size', () => {
  const selected = selectCctvLod(candidates(900), { cameraHeightM: 30_000 });
  assert.equal(selected.cardIds.length, CCTV_AMBIENT_CARD_MAX);
  assert.equal(selected.budgets.cardLimit, CCTV_AMBIENT_CARD_MAX);
});

test('selectCctvLod uses only in-view cameras and orders by viewer distance', () => {
  const input = candidates(20, { hiddenAt: 0 }).reverse();
  const selected = selectCctvLod(input, { cameraHeightM: 500 });
  assert.equal(selected.cardIds.includes('cam-000'), false);
  assert.deepEqual(selected.cardIds.slice(0, 3), ['cam-001', 'cam-002', 'cam-003']);
});

test('video cameras never consume ambient card slots', () => {
  const selected = selectCctvLod(candidates(30, { videoAt: 0 }), { cameraHeightM: 500 });
  assert.equal(selected.cardIds.includes('cam-000'), false);
  assert.equal(selected.cardIds.length, CCTV_AMBIENT_CARD_MIN);
});

test('selectCctvLod tolerates malformed candidate rows', () => {
  const selected = selectCctvLod(
    [null, {}, { id: '', inView: true }, { id: 'cam-ok', inView: true, distanceKm: NaN }],
    { cameraHeightM: 500 }
  );
  assert.deepEqual(selected.cardIds, ['cam-ok']);
});

// ─── Selection-level incumbency (field test finding 4) ────────────────

test('incumbentRankKm discounts incumbents by the 20% factor', () => {
  assert.equal(incumbentRankKm(10, false), 10);
  assert.equal(incumbentRankKm(10, true), 10 * CCTV_CARD_INCUMBENT_FACTOR);
  assert.equal(incumbentRankKm(NaN, true), Infinity);
});

test('selectCctvLod: a carded camera outranks a slightly-nearer non-carded one', () => {
  // Street budget filled: budget-1 anchors + one contested slot. The
  // incumbent at 5.0 km holds its card against a newcomer at 4.5 km (only
  // 10% closer).
  const anchors = Array.from({ length: CCTV_AMBIENT_CARD_MIN - 1 }, (_, i) => ({
    id: `anchor-${String(i).padStart(2, '0')}`, distanceKm: i / 100, inView: true,
  }));
  const contested = [
    { id: 'incumbent', distanceKm: 5.0, inView: true },
    { id: 'newcomer', distanceKm: 4.5, inView: true },
  ];
  const selected = selectCctvLod([...anchors, ...contested], {
    cameraHeightM: 500,
    incumbentIds: new Set(['incumbent']),
  });
  assert.equal(selected.cardIds.length, CCTV_AMBIENT_CARD_MIN);
  assert.ok(selected.cardIds.includes('incumbent'), 'incumbent keeps its card');
  assert.equal(selected.cardIds.includes('newcomer'), false);
});

test('selectCctvLod: a meaningfully (>20%) closer camera still displaces an incumbent', () => {
  const anchors = Array.from({ length: CCTV_AMBIENT_CARD_MIN - 1 }, (_, i) => ({
    id: `anchor-${String(i).padStart(2, '0')}`, distanceKm: i / 100, inView: true,
  }));
  const contested = [
    { id: 'incumbent', distanceKm: 5.0, inView: true },
    { id: 'newcomer', distanceKm: 3.9, inView: true }, // beats 5.0 * 0.8 = 4.0
  ];
  const selected = selectCctvLod([...anchors, ...contested], {
    cameraHeightM: 500,
    incumbentIds: new Set(['incumbent']),
  });
  assert.ok(selected.cardIds.includes('newcomer'), 'meaningfully closer camera wins');
  assert.equal(selected.cardIds.includes('incumbent'), false);
});

test('selectCctvLod: no incumbents means plain nearest-first (unchanged behavior)', () => {
  const plain = selectCctvLod(candidates(20), { cameraHeightM: 500 });
  const withEmpty = selectCctvLod(candidates(20), { cameraHeightM: 500, incumbentIds: new Set() });
  assert.deepEqual(plain.cardIds, withEmpty.cardIds);
});

// ─── distributeCctvCards — screen distribution (follow-up round 2, item C) ──────
// Grid: 5 cols x 4 rows. At viewW 1000 / viewH 800 each cell is 200x200 px.

test('distributeCctvCards spreads clustered candidates across cells', () => {
  // Four nearest candidates cluster in the top-left cell; a farther one
  // sits alone bottom-right. Nearest-first would take the whole cluster —
  // distribution gives every occupied cell its best first.
  const clustered = Array.from({ length: 4 }, (_, i) => ({
    id: `center-${i}`, sx: 50 + i * 10, sy: 50, rankKm: i,
  }));
  const lonely = { id: 'periphery', sx: 950, sy: 750, rankKm: 30 };
  assert.deepEqual(
    distributeCctvCards([...clustered, lonely], { budget: 2, viewW: 1000, viewH: 800 }),
    ['center-0', 'periphery']
  );
});

test('distributeCctvCards: leftover budget falls back to global rank order', () => {
  const clustered = Array.from({ length: 4 }, (_, i) => ({
    id: `center-${i}`, sx: 50 + i * 10, sy: 50, rankKm: i,
  }));
  const lonely = { id: 'periphery', sx: 950, sy: 750, rankKm: 30 };
  // 2 occupied cells, budget 4: both cell winners, then the cluster's next
  // two by rank.
  assert.deepEqual(
    distributeCctvCards([...clustered, lonely], { budget: 4, viewW: 1000, viewH: 800 }),
    ['center-0', 'periphery', 'center-1', 'center-2']
  );
});

test('distributeCctvCards: empty cells are skipped, budget respected', () => {
  // Everything in ONE cell — the 19 empty cells claim nothing; the single
  // occupied cell fills the whole budget in rank order.
  const oneCell = Array.from({ length: 5 }, (_, i) => ({
    id: `c-${i}`, sx: 20 + i * 5, sy: 20, rankKm: i,
  }));
  const ids = distributeCctvCards(oneCell, { budget: 3, viewW: 1000, viewH: 800 });
  assert.deepEqual(ids, ['c-0', 'c-1', 'c-2']);
});

test('distributeCctvCards: an under-budget cut keeps the nearest cell winners', () => {
  const ids = distributeCctvCards([
    { id: 'far-cell', sx: 900, sy: 700, rankKm: 9 },
    { id: 'near-cell', sx: 100, sy: 100, rankKm: 1 },
  ], { budget: 1, viewW: 1000, viewH: 800 });
  assert.deepEqual(ids, ['near-cell']);
});

test('distributeCctvCards: incumbency (effective distance) is honored inside a cell', () => {
  // Same cell: the incumbent at 5.0 km (discounted to 4.0) beats the
  // non-carded newcomer at 4.5 km for the cell slot.
  const ids = distributeCctvCards([
    { id: 'newcomer', sx: 100, sy: 100, rankKm: incumbentRankKm(4.5, false) },
    { id: 'incumbent', sx: 120, sy: 100, rankKm: incumbentRankKm(5.0, true) },
  ], { budget: 1, viewW: 1000, viewH: 800 });
  assert.deepEqual(ids, ['incumbent']);
});

test('distributeCctvCards: malformed rows dropped; offscreen anchors clamp to edge cells', () => {
  const ids = distributeCctvCards([
    null,
    { id: '', sx: 10, sy: 10, rankKm: 0 },
    { id: 'nan', sx: NaN, sy: 10, rankKm: 0 },
    { id: 'ok', sx: 10, sy: 10, rankKm: 1 },
    // Margin candidates just outside the viewport land in the edge cells.
    { id: 'edge', sx: -20, sy: 850, rankKm: 2 },
  ], { budget: 5, viewW: 1000, viewH: 800 });
  assert.deepEqual(ids.sort(), ['edge', 'ok']);
  assert.deepEqual(distributeCctvCards([], { budget: 5, viewW: 1000, viewH: 800 }), []);
});

test('selectCctvLod with viewport dims routes the fill through screen distribution', () => {
  // A cluster larger than the street budget sits mid-screen; a periphery
  // camera ranks past the budget. Nearest-first drops it — distribution
  // keeps it because its cell is otherwise empty.
  const clustered = Array.from({ length: CCTV_AMBIENT_CARD_MIN + 2 }, (_, i) => ({
    id: `center-${String(i).padStart(2, '0')}`,
    distanceKm: i / 10,
    inView: true,
    sx: 400 + (i % 5) * 8,
    sy: 300 + Math.floor(i / 5) * 8,
  }));
  const periphery = { id: 'periphery', distanceKm: 9, inView: true, sx: 950, sy: 750 };
  const selected = selectCctvLod([...clustered, periphery], {
    cameraHeightM: 500, viewW: 1000, viewH: 800,
  });
  assert.equal(selected.cardIds.length, CCTV_AMBIENT_CARD_MIN, 'budget respected');
  assert.ok(selected.cardIds.includes('periphery'), 'periphery cell holds a card');
  // Without screen info the original nearest-first cap applies unchanged.
  const plain = selectCctvLod(
    [...clustered, periphery].map(({ sx, sy, ...rest }) => rest),
    { cameraHeightM: 500 }
  );
  assert.equal(plain.cardIds.includes('periphery'), false);
});

test('center-weight helpers are bounded and robust to invalid anchors and outliers', () => {
  assert.equal(CCTV_CARD_CENTER_WEIGHT, 0.5);
  assert.equal(hasFiniteCctvViewport(1000, 800), true);
  assert.equal(hasFiniteCctvViewport(Infinity, 800), false);
  assert.equal(screenCenterFraction(500, 400, 1000, 800), 0);
  assert.equal(screenCenterFraction(1000, 800, 1000, 800), 1);
  assert.equal(screenCenterFraction(NaN, 400, 1000, 800), 1);
  assert.equal(screenCenterFraction(-200, -200, 1000, 800), 1);
  assert.equal(screenCenterFraction(500, 400, 0, 0), 0);
  const near = Array.from({ length: 20 }, (_, index) => 1 + index / 100);
  assert.equal(cctvCandidateSpreadKm([...near, 900]), 1.18);
  assert.equal(cctvCandidateSpreadKm([Infinity, NaN]), 0);
  assert.equal(blendCenterRankKm(10, 0, 20), 5);
  assert.equal(blendCenterRankKm(10, 1, 20), 15);
  assert.equal(blendCenterRankKm(10, 0.5, 20, 0), 10);
});

test('non-finite positive viewport dimensions retain exact legacy nearest-first selection', () => {
  const near = Array.from({ length: CCTV_AMBIENT_CARD_MIN }, (_, index) => ({
    id: `near-${String(index).padStart(2, '0')}`,
    distanceKm: index,
    inView: true,
    sx: 100,
    sy: 100,
  }));
  const far = {
    id: 'far-other-cell',
    distanceKm: 100,
    inView: true,
    sx: 900,
    sy: 700,
  };
  const input = [...near, far];
  const legacy = selectCctvLod(input, { cameraHeightM: 500 });

  assert.deepEqual(
    selectCctvLod(input, { cameraHeightM: 500, viewW: Infinity, viewH: 800 }).cardIds,
    legacy.cardIds,
  );
  assert.deepEqual(
    selectCctvLod(input, { cameraHeightM: 500, viewW: 1000, viewH: Infinity }).cardIds,
    legacy.cardIds,
  );

  const legacyEdgeIds = [
    { id: '   ', distanceKm: 1, inView: true },
    { id: 'normal', distanceKm: 2, inView: true },
  ];
  assert.deepEqual(
    selectCctvLod(legacyEdgeIds, { cameraHeightM: 500, viewW: 0, viewH: 800 }).cardIds,
    ['   ', 'normal'],
    'invalid viewport preserves every non-empty string ID accepted by the legacy path',
  );
});

function edgeVsCenterPool() {
  const edge = Array.from({ length: 30 }, (_, index) => ({
    id: `edge-${String(index).padStart(2, '0')}`,
    distanceKm: 1 + index / 100,
    inView: true,
    sx: 20 + (index % 5) * 2,
    sy: 780 - Math.floor(index / 5) * 2,
  }));
  const center = Array.from({ length: 10 }, (_, index) => ({
    id: `center-${String(index).padStart(2, '0')}`,
    distanceKm: 12 + index / 100,
    inView: true,
    sx: 490 + (index % 5) * 4,
    sy: 390 + (index % 5) * 2,
  }));
  return { edge, center };
}

test('center weighting deterministically favors center without starving peripheral coverage', () => {
  const { edge, center } = edgeVsCenterPool();
  const view = { cameraHeightM: 500, viewW: 1000, viewH: 800 };
  const selected = selectCctvLod([...edge, ...center], view);
  const reordered = selectCctvLod([...center].reverse().concat([...edge].reverse()), view);

  assert.equal(selected.cardIds.length, CCTV_AMBIENT_CARD_MIN);
  assert.equal(selected.cardIds.filter((id) => id.startsWith('center-')).length, 10);
  assert.equal(selected.cardIds.filter((id) => id.startsWith('edge-')).length, 10);
  assert.deepEqual(reordered.cardIds, selected.cardIds, 'input order cannot affect winners or ordering');

  const legacy = selectCctvLod(
    [...edge, ...center].map(({ sx, sy, ...candidate }) => candidate),
    { cameraHeightM: 500 },
  );
  assert.equal(legacy.cardIds.filter((id) => id.startsWith('center-')).length, 0);
});

test('ineligible video, hidden, and malformed-distance rows cannot alter eligible winners', () => {
  const { edge, center } = edgeVsCenterPool();
  const eligible = [...edge, ...center];
  const view = { cameraHeightM: 500, viewW: 1000, viewH: 800 };
  const baseline = selectCctvLod(eligible, view).cardIds;
  const noise = [
    ...Array.from({ length: 50 }, (_, index) => ({
      id: `video-${index}`,
      distanceKm: 1_000 + index,
      inView: true,
      isVideo: true,
      sx: 500,
      sy: 400,
    })),
    { id: 'hidden-outlier', distanceKm: 9_000, inView: false, sx: 900, sy: 700 },
    { id: 'bad-distance', distanceKm: NaN, inView: true, sx: 900, sy: 700 },
    { id: '', distanceKm: 0, inView: true, sx: 500, sy: 400 },
  ];

  assert.deepEqual(selectCctvLod([...eligible, ...noise], view).cardIds, baseline);
  assert.deepEqual(selectCctvLod([...noise].reverse().concat([...eligible].reverse()), view).cardIds, baseline);
});

test('malformed-distance rows remain slot-neutral when valid candidates leave spare capacity', () => {
  const view = { cameraHeightM: 500, viewW: 1000, viewH: 800 };
  const candidates = [
    { id: 'valid', distanceKm: 1, inView: true, sx: 500, sy: 400 },
    { id: 'bad', distanceKm: NaN, inView: true, sx: 510, sy: 410 },
  ];

  assert.deepEqual(selectCctvLod(candidates, view).cardIds, ['valid']);
  assert.deepEqual(selectCctvLod([...candidates].reverse(), view).cardIds, ['valid']);
});

test('duplicate IDs are slot-neutral and choose a deterministic representative', () => {
  const { edge, center } = edgeVsCenterPool();
  const eligible = [...edge, ...center];
  const view = { cameraHeightM: 500, viewW: 1000, viewH: 800 };
  const baseline = selectCctvLod(eligible, view).cardIds;
  const duplicates = [
    { ...edge[0], distanceKm: 1_000, sx: 500, sy: 400 },
    { ...center[0], sx: 20, sy: 780 },
    { ...center[0], distanceKm: NaN, sx: 500, sy: 400 },
  ];

  assert.deepEqual(selectCctvLod([...eligible, ...duplicates], view).cardIds, baseline);
  assert.deepEqual(
    selectCctvLod([...duplicates, ...eligible].reverse(), view).cardIds,
    baseline,
    'input order cannot choose a different duplicate anchor or affect spread',
  );
});

test('center weighting has deterministic ID ties and preserves invalid-anchor eligibility', () => {
  const anchors = Array.from({ length: CCTV_AMBIENT_CARD_MIN - 1 }, (_, index) => ({
    id: `anchor-${String(index).padStart(2, '0')}`,
    distanceKm: index / 100,
    inView: true,
    sx: 500,
    sy: 400,
  }));
  const tied = [
    { id: 'tie-b', distanceKm: 10, inView: true, sx: 500, sy: 400 },
    { id: 'tie-a', distanceKm: 10, inView: true, sx: 500, sy: 400 },
    { id: 'invalid-anchor', distanceKm: 30, inView: true, sx: NaN, sy: NaN },
  ];
  const selected = selectCctvLod([...anchors, ...tied], {
    cameraHeightM: 500,
    viewW: 1000,
    viewH: 800,
  });
  assert.ok(selected.cardIds.includes('tie-a'));
  assert.equal(selected.cardIds.includes('tie-b'), false, 'ID breaks an exact contested tie');
  assert.equal(selected.cardIds.includes('invalid-anchor'), false, 'invalid anchor does not displace valid winners');

  const onlyInvalid = selectCctvLod([
    { id: 'invalid-only', distanceKm: 1, inView: true, sx: NaN, sy: NaN },
  ], { cameraHeightM: 500, viewW: 1000, viewH: 800 });
  assert.deepEqual(onlyInvalid.cardIds, ['invalid-only'], 'defensive top-up preserves eligibility');
});

test('applyEvictionGrace keeps a fallen-out card and clears grace when it returns', () => {
  // Pass 1: cam-b falls out of the selection but keeps its live card.
  const pass1 = applyEvictionGrace({
    selectedIds: ['cam-a'],
    builtIds: ['cam-a', 'cam-b'],
    graceState: new Map(),
    nowMs: 1_000,
    cardLimit: 16,
  });
  assert.ok(pass1.keepIds.includes('cam-b'), 'graced card stays alive');
  assert.deepEqual(pass1.evictIds, []);
  assert.deepEqual(pass1.graceState.get('cam-b'), { misses: 1, since: 1_000 });

  // Pass 2: cam-b is selected again — card survived, grace entry cleared.
  const pass2 = applyEvictionGrace({
    selectedIds: ['cam-a', 'cam-b'],
    builtIds: ['cam-a', 'cam-b'],
    graceState: pass1.graceState,
    nowMs: 1_500,
    cardLimit: 16,
  });
  assert.ok(pass2.keepIds.includes('cam-b'));
  assert.deepEqual(pass2.evictIds, []);
  assert.equal(pass2.graceState.size, 0);
});

test('applyEvictionGrace evicts a card that stays unselected past the pass budget', () => {
  let graceState = new Map();
  let result;
  // cam-b stays out: survives CCTV_LOD_GRACE_PASSES consecutive misses...
  for (let pass = 1; pass <= CCTV_LOD_GRACE_PASSES; pass++) {
    result = applyEvictionGrace({
      selectedIds: ['cam-a'],
      builtIds: ['cam-a', 'cam-b'],
      graceState,
      nowMs: 1_000 + pass * 100,
      cardLimit: 16,
    });
    graceState = result.graceState;
    assert.ok(result.keepIds.includes('cam-b'), `still graced at miss ${pass}`);
  }
  // ...and is dropped on the next pass.
  result = applyEvictionGrace({
    selectedIds: ['cam-a'],
    builtIds: ['cam-a', 'cam-b'],
    graceState,
    nowMs: 1_400,
    cardLimit: 16,
  });
  assert.deepEqual(result.evictIds, ['cam-b']);
  assert.equal(result.keepIds.includes('cam-b'), false);
  assert.equal(result.graceState.has('cam-b'), false);
});

test('applyEvictionGrace evicts on wall-time even with few passes', () => {
  const pass1 = applyEvictionGrace({
    selectedIds: ['cam-a'],
    builtIds: ['cam-a', 'cam-b'],
    graceState: new Map(),
    nowMs: 10_000,
    cardLimit: 16,
  });
  assert.ok(pass1.keepIds.includes('cam-b'));
  const pass2 = applyEvictionGrace({
    selectedIds: ['cam-a'],
    builtIds: ['cam-a', 'cam-b'],
    graceState: pass1.graceState,
    nowMs: 10_000 + CCTV_LOD_GRACE_MS,
    cardLimit: 16,
  });
  assert.deepEqual(pass2.evictIds, ['cam-b']);
});

test('applyEvictionGrace never exceeds the hard cap; graced cards go first, oldest first', () => {
  // Two cards in grace, cam-old fell out before cam-new.
  const graceState = new Map([
    ['cam-old', { misses: 1, since: 1_000 }],
    ['cam-new', { misses: 1, since: 2_000 }],
  ]);
  // Selection fills 3 of 4 slots: only one grace slot remains.
  const result = applyEvictionGrace({
    selectedIds: ['cam-a', 'cam-b', 'cam-c'],
    builtIds: ['cam-a', 'cam-b', 'cam-old', 'cam-new'],
    graceState,
    nowMs: 2_100,
    cardLimit: 4,
  });
  assert.equal(result.keepIds.length, 4);
  // cam-c is newly selected and enters immediately despite grace pressure.
  assert.ok(result.keepIds.includes('cam-c'));
  assert.ok(result.keepIds.includes('cam-new'), 'newest grace entry survives');
  assert.deepEqual(result.evictIds, ['cam-old'], 'oldest grace entry evicted for the cap');
});

test('applyEvictionGrace with a full selection keeps no graced cards', () => {
  const selectedIds = Array.from({ length: 4 }, (_, i) => `cam-${i}`);
  const result = applyEvictionGrace({
    selectedIds,
    builtIds: [...selectedIds, 'cam-extra'],
    graceState: new Map(),
    nowMs: 1_000,
    cardLimit: 4,
  });
  assert.deepEqual(result.keepIds.sort(), selectedIds.sort());
  assert.deepEqual(result.evictIds, ['cam-extra']);
});

test('staticFrameRefreshMs follows known pack cadences and bounds explicit values', () => {
  assert.equal(staticFrameRefreshMs({ provider: 'Austin Transportation & Public Works' }), 300_000);
  assert.equal(staticFrameRefreshMs({ provider: 'Transport for London' }), 180_000);
  assert.equal(staticFrameRefreshMs({ provider: 'Caltrans' }), 180_000);
  assert.equal(staticFrameRefreshMs({ frameRefreshMs: 5_000 }), 60_000);
  assert.equal(staticFrameRefreshMs({ frameRefreshMs: 3_000_000 }), 1_200_000);
  assert.equal(staticFrameRefreshMs({ provider: 'Unknown Provider' }), 300_000);
});
