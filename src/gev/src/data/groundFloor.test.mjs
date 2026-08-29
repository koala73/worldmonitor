// src/data/groundFloor.test.mjs
// Field-test round (2026-07-06): locks the coarse ground-floor helpers used to
// clamp military render altitudes and trail waypoints so they never render
// below the local ellipsoidal surface (RS46 heli-in-hillside + WAKE01
// trail-underground findings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coarseFloorCoord, floorAltitudeM, GROUND_FLOOR_LIFT_M, displayFloorHeightM,
  corridorFloorCells, CORRIDOR_MAX_CELLS, stickyFloorCell, allocateCorridorCells,
  CORRIDOR_WALK_STEP_DEG,
  meshFloorSampleWithinPrior,
  reportMeshFloorCell, cachedMeshFloor, cachedGroundFloor,
  setMeshFloorPreferred, meshFloorPreferred, _clearMeshFloorCellsForTest,
  neighborFloorM,
} from './groundFloor.js';
import {
  corridorPathLatLon, projectGroundArcLatLon,
  CORRIDOR_SAMPLE_SPACING_M, CORRIDOR_MAX_LENGTH_M,
} from './motionModel.js';

test('coarseFloorCoord rounds to a 3-decimal (~111 m) grid cell', () => {
  const c = coarseFloorCoord(35.049876, -106.591432);
  assert.equal(c.lat, 35.05);
  assert.equal(c.lon, -106.591);
});

test('coarseFloorCoord: nearby points collapse to the same cell (cache reuse)', () => {
  const a = coarseFloorCoord(35.0501, -106.5914);
  const b = coarseFloorCoord(35.0504, -106.5909);
  assert.deepEqual(a, b);
});

test('floorAltitudeM lifts a below-ground altitude to ground + lift', () => {
  // RS46 case: baro+N ≈ 334 m but the ridge is ~400 m ellipsoidal.
  const got = floorAltitudeM(334, 400);
  assert.equal(got, 400 + GROUND_FLOOR_LIFT_M);
});

test('floorAltitudeM leaves an above-ground altitude untouched', () => {
  assert.equal(floorAltitudeM(1200, 400), 1200);
});

test('floorAltitudeM with unknown ground returns the altitude unchanged', () => {
  assert.equal(floorAltitudeM(334, null), 334);
  assert.equal(floorAltitudeM(334, NaN), 334);
});

test('floorAltitudeM with null altitude and known ground returns ground + lift (ground-waypoint case)', () => {
  // WAKE01 case: a readsb trace point of "ground" has NO altitude — it must
  // sit ON the local surface (~1590 m at Kirtland), never the old 50 m sentinel.
  const got = floorAltitudeM(null, 1590);
  assert.equal(got, 1590 + GROUND_FLOOR_LIFT_M);
});

test('floorAltitudeM with null altitude and unknown ground returns null (caller fallback applies)', () => {
  assert.equal(floorAltitudeM(null, null), null);
});

test('floorAltitudeM honors a custom lift', () => {
  assert.equal(floorAltitudeM(10, 100, 5), 105);
});

test('floorAltitudeM treats ground of 0 (sea-level coast) as a real floor', () => {
  assert.equal(floorAltitudeM(-20, 0), 0 + GROUND_FLOOR_LIFT_M);
});

// Mesh-floor cells (round 4): the rendered-surface layer over the DEM prior.
test('mesh cell: report + read round-trips within the same coarse cell', () => {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.1971, -97.6663, 138.4);
  // ~30 m away, same 111 m cell
  assert.equal(cachedMeshFloor(30.19725, -97.66645), 138.4);
});

test('mesh cell: first accepted sample wins (one-shot latch)', () => {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.197, -97.666, 138.4);
  reportMeshFloorCell(30.197, -97.666, 150.0);
  assert.equal(cachedMeshFloor(30.197, -97.666), 138.4);
});

test('mesh cell: reads are null on globe stacks (DEM is the rendered surface there)', () => {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.197, -97.666, 138.4);
  setMeshFloorPreferred(false);
  assert.equal(cachedMeshFloor(30.197, -97.666), null);
  // cells survive the regime round-trip (latched for the session)
  setMeshFloorPreferred(true);
  assert.equal(cachedMeshFloor(30.197, -97.666), 138.4);
});

test('cachedGroundFloor prefers the mesh cell over the DEM cell (AUS 17 m case)', () => {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  // no DEM warm needed for this assertion: mesh present -> mesh wins outright
  reportMeshFloorCell(30.197, -97.666, 138.1);
  assert.equal(cachedGroundFloor(30.197, -97.666), 138.1);
});

test('meshFloorPreferred reflects the setter (sampler stack-listener contract)', () => {
  setMeshFloorPreferred(false);
  assert.equal(meshFloorPreferred(), false);
  setMeshFloorPreferred(true);
  assert.equal(meshFloorPreferred(), true);
});

test('all mesh-floor writers share the asymmetric real-DEM acceptance window', () => {
  assert.equal(meshFloorSampleWithinPrior(85, 100), true);
  assert.equal(meshFloorSampleWithinPrior(180, 100), true);
  assert.equal(meshFloorSampleWithinPrior(84.99, 100), false);
  assert.equal(meshFloorSampleWithinPrior(180.01, 100), false);
  assert.equal(meshFloorSampleWithinPrior(120, null), false);
});

// --- Display-time floor (2026-08-19, buried taxiing contacts at KAUS) -------
// A grounded contact's render height is fixed at POLL time from the floor of
// the fix's cell, but what renders is the DEAD-RECKONED position, which drifts
// across cells for the whole 30 s segment (and far further while a stale
// ground contact coasts). On a graded apron the sprite ends up under the mesh
// it drifted over. displayFloorHeightM is the decision at the point of display.

test('displayFloorHeightM lifts a display height that drifted under the floor', () => {
  // KAUS taxiway: fix cell floor 124.7 m, drifted onto a 140.2 m cell.
  assert.equal(displayFloorHeightM(124.7, 140.2), 140.2 + GROUND_FLOOR_LIFT_M);
});

test('displayFloorHeightM returns null (no rebuild) when already above the floor', () => {
  assert.equal(displayFloorHeightM(140.2, 124.7), null);
});

test('displayFloorHeightM returns null exactly at the lifted floor (no jitter)', () => {
  assert.equal(displayFloorHeightM(124.7 + GROUND_FLOOR_LIFT_M, 124.7), null);
});

test('displayFloorHeightM returns null when the floor cell is not warm', () => {
  assert.equal(displayFloorHeightM(124.7, null), null);
  assert.equal(displayFloorHeightM(124.7, NaN), null);
  assert.equal(displayFloorHeightM(124.7, undefined), null);
});

test('displayFloorHeightM returns null for a non-finite display height', () => {
  assert.equal(displayFloorHeightM(NaN, 124.7), null);
  assert.equal(displayFloorHeightM(null, 124.7), null);
});

test('displayFloorHeightM honours a caller-supplied lift', () => {
  assert.equal(displayFloorHeightM(100, 140, 5), 145);
});

// --- Display corridor ------------------------------------------------------
// A grounded contact's DISPLAY walks from where it currently renders toward
// the newest fix over the following poll(s), so those are the cells it is
// about to need a floor for. Warming only the cell it is standing on warms the
// cell it is LEAVING — a contact taxiing at 10 m/s crosses a 111 m cell every
// ~11 s while the warm batch runs once per 30 s poll, so it stays permanently
// ahead of its own floor data (measured at KAUS: sprites buried 2–4 m with
// `cellFloor=COLD` for the whole observation).

test('corridorFloorCells covers both ends of the display→fix walk', () => {
  const cells = corridorFloorCells([{ lat: 30.200, lon: -97.660 }, { lat: 30.203, lon: -97.660 }]);
  assert.deepEqual(cells[0], { lat: 30.2, lon: -97.66 });
  assert.deepEqual(cells[cells.length - 1], { lat: 30.203, lon: -97.66 });
});

test('corridorFloorCells has no gaps along a multi-cell walk', () => {
  // ~330 m north = 3 coarse cells.
  const lats = corridorFloorCells([{ lat: 30.200, lon: -97.660 }, { lat: 30.203, lon: -97.660 }]).map((c) => c.lat);
  assert.deepEqual(lats, [30.2, 30.201, 30.202, 30.203]);
});

test('corridorFloorCells dedupes when both ends share one cell', () => {
  const cells = corridorFloorCells([{ lat: 30.2001, lon: -97.6601 }, { lat: 30.2004, lon: -97.6604 }]);
  assert.deepEqual(cells, [{ lat: 30.2, lon: -97.66 }]);
});

test('corridorFloorCells is bounded on a long walk (never unbounded)', () => {
  const cells = corridorFloorCells([{ lat: 30.2, lon: -97.66 }, { lat: 31.2, lon: -96.66 }]);
  assert.ok(cells.length <= CORRIDOR_MAX_CELLS, `bounded, got ${cells.length}`);
});

test('corridorFloorCells returns the start cell alone for a bad endpoint', () => {
  assert.deepEqual(corridorFloorCells([{ lat: 30.2, lon: -97.66 }, { lat: NaN, lon: -97.66 }]), [{ lat: 30.2, lon: -97.66 }]);
  assert.deepEqual(corridorFloorCells([{ lat: 30.2, lon: -97.66 }, { lat: null, lon: null }]), [{ lat: 30.2, lon: -97.66 }]);
});

test('corridorFloorCells returns nothing for a bad start', () => {
  assert.deepEqual(corridorFloorCells([{ lat: NaN, lon: -97.66 }, { lat: 30.2, lon: -97.66 }]), []);
});

// --- F5: contiguous prefix + guaranteed endpoint ---------------------------
// The first cut capped the interpolation at 20 half-cell steps, so past ~1.1 km
// the walk sampled SPARSELY: cells between the samples were skipped and the
// destination could be dropped entirely. A corridor with holes warms ground the
// contact never crosses while leaving ground it does cross cold.

test('corridorFloorCells: 3 km corridor keeps a gap-free prefix', () => {
  // ~3.3 km north.
  const cells = corridorFloorCells([{ lat: 30.200, lon: -97.660 }, { lat: 30.230, lon: -97.660 }]);
  assert.ok(cells.length <= CORRIDOR_MAX_CELLS, `bounded, got ${cells.length}`);
  // Every prefix cell is exactly one cell on from the previous — no holes.
  const prefix = cells.slice(0, -1);
  for (let i = 1; i < prefix.length; i++) {
    const step = Math.round((prefix[i].lat - prefix[i - 1].lat) * 1000);
    assert.equal(step, 1, `hole between ${JSON.stringify(prefix[i - 1])} and ${JSON.stringify(prefix[i])}`);
  }
});

test('corridorFloorCells: the destination cell always survives truncation', () => {
  const cells = corridorFloorCells([{ lat: 30.200, lon: -97.660 }, { lat: 30.230, lon: -97.660 }]);
  assert.deepEqual(cells[cells.length - 1], { lat: 30.23, lon: -97.66 },
    'the far end is where the contact is headed — it must be warmed, not dropped');
});

test('corridorFloorCells: a diagonal 3 km corridor is still gap-free', () => {
  const cells = corridorFloorCells([{ lat: 30.200, lon: -97.660 }, { lat: 30.220, lon: -97.640 }]);
  const prefix = cells.slice(0, -1);
  for (let i = 1; i < prefix.length; i++) {
    const dLat = Math.abs(Math.round((prefix[i].lat - prefix[i - 1].lat) * 1000));
    const dLon = Math.abs(Math.round((prefix[i].lon - prefix[i - 1].lon) * 1000));
    assert.ok(dLat <= 1 && dLon <= 1 && (dLat + dLon) > 0,
      `non-adjacent step ${JSON.stringify(prefix[i - 1])} -> ${JSON.stringify(prefix[i])}`);
  }
});

// --- F6: cell-boundary hysteresis ------------------------------------------
// A dead-reckoned position jittering across a 0.001° edge would otherwise pick
// a different cell — and so a different floor — at 12 Hz, popping the sprite
// between two heights.

test('stickyFloorCell picks the containing cell with no previous cell', () => {
  assert.deepEqual(stickyFloorCell(30.2004, -97.6604, null), { lat: 30.2, lon: -97.66 });
});

test('stickyFloorCell holds the previous cell for a jitter-sized excursion', () => {
  const prev = { lat: 30.2, lon: -97.66 };
  // 30.2006 belongs to cell 30.201, but it is only ~11 m past the boundary.
  assert.deepEqual(stickyFloorCell(30.2006, -97.66, prev), prev);
  assert.deepEqual(stickyFloorCell(30.1994, -97.66, prev), prev);
});

test('stickyFloorCell releases once the contact is properly into the next cell', () => {
  const prev = { lat: 30.2, lon: -97.66 };
  assert.deepEqual(stickyFloorCell(30.2011, -97.66, prev), { lat: 30.201, lon: -97.66 });
});

test('stickyFloorCell holds across a diagonal corner excursion', () => {
  const prev = { lat: 30.2, lon: -97.66 };
  assert.deepEqual(stickyFloorCell(30.2006, -97.6606, prev), prev);
});

test('stickyFloorCell does not stick to a far-away stale cell', () => {
  const prev = { lat: 30.1, lon: -97.66 };
  assert.deepEqual(stickyFloorCell(30.2004, -97.6604, prev), { lat: 30.2, lon: -97.66 });
});

// --- F2: corridor budget fairness ------------------------------------------
// The first cut spent the budget in Map insertion order and decremented it
// BEFORE deduping, so parked contacts (whose corridor is the fix cell the poll
// already collected) burned slots and the contacts actually outrunning their
// floor data got nothing.

/** Warmth oracle for the budget-policy tests: nothing is warm, so every cell
 *  is charged and the allocation order under test is the only variable. */
const NONE_WARM = () => false;

const cellsFrom = (lat, n) => Array.from({ length: n }, (_, i) => ({ lat: +(lat + i * 0.001).toFixed(3), lon: -97.66 }));

test('allocateCorridorCells: already-collected cells cost nothing', () => {
  const seen = new Set(['30.2,-97.66']);
  const got = allocateCorridorCells(
    [{ cells: [{ lat: 30.2, lon: -97.66 }], cold: 0, speedMps: 0 }], seen, 4, 4, 0, NONE_WARM,
  );
  assert.deepEqual(got, [], 'a parked contact on a collected cell allocates nothing');
});

test('allocateCorridorCells: a parked contact never crowds out a mover', () => {
  const seen = new Set(['30.2,-97.66']);
  const parked = { cells: [{ lat: 30.2, lon: -97.66 }], cold: 0, speedMps: 0 };
  const mover = { cells: cellsFrom(30.3, 3), cold: 3, speedMps: 12 };
  // Parked FIRST in insertion order — the old bug's shape.
  const got = allocateCorridorCells([parked, mover], seen, 3, 4, 0, NONE_WARM);
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((c) => c.lat), [30.3, 30.301, 30.302]);
});

test('allocateCorridorCells: 85 grounded contacts — the needy are served first', () => {
  // 64 parked contacts whose cells the poll already collected, then 21 movers
  // with cold ground ahead. Insertion-order budgeting starved every mover.
  const seen = new Set();
  const candidates = [];
  for (let i = 0; i < 64; i++) {
    const cell = { lat: +(31 + i * 0.001).toFixed(3), lon: -97.66 };
    seen.add(`${cell.lat},${cell.lon}`);
    candidates.push({ cells: [cell], cold: 0, speedMps: 0 });
  }
  const movers = [];
  for (let i = 0; i < 21; i++) {
    const cells = cellsFrom(32 + i, 4);
    movers.push(cells);
    candidates.push({ cells, cold: 4, speedMps: 10 });
  }
  const got = allocateCorridorCells(candidates, seen, 64, 4, 0, NONE_WARM);
  const gotKeys = new Set(got.map((c) => `${c.lat},${c.lon}`));
  // Demand (21 x 4 = 84) exceeds the 64-cell budget, so not every mover can be
  // filled — but none may be left with NOTHING, and no slot may go to a parked
  // contact whose cell the poll already had.
  for (const cells of movers) {
    assert.ok(gotKeys.has(`${cells[0].lat},${cells[0].lon}`),
      `mover at ${cells[0].lat} was starved outright`);
  }
  assert.equal(got.length, 64, 'budget is spent, and spent entirely on movers');
  for (const cell of got) {
    assert.ok(cell.lat >= 32, `slot wasted on an already-collected parked cell (${cell.lat})`);
  }
});

test('allocateCorridorCells: fair share caps a long corridor in the first pass', () => {
  const seen = new Set();
  const hog = { cells: cellsFrom(30, 12), cold: 12, speedMps: 30 };
  const small = { cells: cellsFrom(40, 2), cold: 2, speedMps: 5 };
  const got = allocateCorridorCells([hog, small], seen, 6, 4, 0, NONE_WARM);
  const lats = got.map((c) => c.lat);
  assert.ok(lats.includes(40) && lats.includes(40.001),
    'the small corridor is served before the hog takes seconds');
});

test('allocateCorridorCells: leftover budget goes to the neediest in pass two', () => {
  const seen = new Set();
  const hog = { cells: cellsFrom(30, 8), cold: 8, speedMps: 30 };
  const small = { cells: cellsFrom(40, 1), cold: 1, speedMps: 5 };
  const got = allocateCorridorCells([hog, small], seen, 8, 4, 0, NONE_WARM);
  assert.equal(got.length, 8);
  assert.ok(got.filter((c) => c.lat >= 30 && c.lat < 31).length === 7, 'hog gets the remainder');
});

test('allocateCorridorCells: mutates `seen` so the caller stays deduped', () => {
  const seen = new Set();
  allocateCorridorCells([{ cells: cellsFrom(30, 2), cold: 2, speedMps: 1 }], seen, 4, 4, 0, NONE_WARM);
  assert.ok(seen.has('30,-97.66') && seen.has('30.001,-97.66'));
});

test('allocateCorridorCells: no budget, no allocation', () => {
  assert.deepEqual(allocateCorridorCells([{ cells: cellsFrom(30, 2), cold: 2, speedMps: 1 }], new Set(), 0, 4, 0, NONE_WARM), []);
  assert.deepEqual(allocateCorridorCells([], new Set(), 10, 4, 0, NONE_WARM), []);
});

// --- F1: the corridor covers the ARC, not the chord -------------------------

test('corridorFloorCells walks a turning path\'s arc, not the chord across it', () => {
  const path = corridorPathLatLon({
    extrapolating: true,
    displayLat: 30.200, displayLon: -97.660, courseDeg: 0, speedMps: 12, turnRateDps: 3,
    fixLat: 30.199, fixLon: -97.660, lookaheadSec: 30,
  });
  const arcCells = corridorFloorCells(path);
  const chordCells = corridorFloorCells([path[0], path[path.length - 1]]);
  const chordKeys = new Set(chordCells.map((c) => `${c.lat},${c.lon}`));
  const offChord = arcCells.filter((c) => !chordKeys.has(`${c.lat},${c.lon}`));
  assert.ok(offChord.length > 0,
    'the turn leaves the chord — those cells are the ground a straight corridor left cold');
});

test('corridorFloorCells keeps a multi-leg path gap-free', () => {
  const path = corridorPathLatLon({
    extrapolating: true,
    displayLat: 30.200, displayLon: -97.660, courseDeg: 0, speedMps: 12, turnRateDps: 2,
    fixLat: 30.199, fixLon: -97.660, lookaheadSec: 40,
  });
  const cells = corridorFloorCells(path);
  const prefix = cells.slice(0, -1);
  for (let i = 1; i < prefix.length; i++) {
    const dLat = Math.abs(Math.round((prefix[i].lat - prefix[i - 1].lat) * 1000));
    const dLon = Math.abs(Math.round((prefix[i].lon - prefix[i - 1].lon) * 1000));
    assert.ok(dLat <= 1 && dLon <= 1 && (dLat + dLon) > 0,
      `non-adjacent step ${JSON.stringify(prefix[i - 1])} -> ${JSON.stringify(prefix[i])}`);
  }
});

// --- F2-shifted: a tie larger than the budget must not starve its tail ------
// Need-ranking alone left the stable ranked tail with nothing, poll after poll:
// starvation moved rather than being removed. The epoch rotates equal-ranked
// runs so the tail cycles in.

test('allocateCorridorCells: the epoch rotates a tie, so a different prefix leads each poll', () => {
  const cellsFor = (i) => [{ lat: +(50 + i).toFixed(3), lon: -97.66 }];
  const candidates = Array.from({ length: 5 }, (_, i) => ({ cells: cellsFor(i), cold: 1, speedMps: 10 }));
  const first = (epoch) => allocateCorridorCells(candidates, new Set(), 1, 4, epoch, NONE_WARM)[0].lat;
  const leaders = new Set([first(0), first(1), first(2)]);
  assert.equal(leaders.size, 3, 'the same contact led every poll — the tie never cycles');
});

test('allocateCorridorCells: rotation never demotes a needier contact below a less needy one', () => {
  const needy = { cells: [{ lat: 60, lon: -97.66 }], cold: 4, speedMps: 1 };
  const idle = { cells: [{ lat: 61, lon: -97.66 }], cold: 1, speedMps: 99 };
  for (let epoch = 0; epoch < 6; epoch++) {
    const got = allocateCorridorCells([idle, needy], new Set(), 1, 4, epoch, NONE_WARM);
    assert.equal(got[0].lat, 60, `epoch ${epoch} served the less needy contact first`);
  }
});

// --- F1: the arc walk must be CELL-COMPLETE ---------------------------------
// Six FIXED samples were fine at taxi speed and coarse at speed, and a short
// leg rounds to a single walk step — so the collector degenerated to testing
// the sample points themselves and skipped cells the arc genuinely crosses.
// Concrete miss: 5 m/s, 0.4 deg/s, 60 s from (30.200, -97.660) passes through
// 30.202,-97.659 for ~4.4 s (~22 m of ground) and never sampled it.

const TURNING_COAST = {
  extrapolating: true,
  displayLat: 30.200, displayLon: -97.660,
  courseDeg: 0, speedMps: 5, turnRateDps: 0.4,
  fixLat: 30.199, fixLon: -97.660,
  lookaheadSec: 60,
};

test('corridorFloorCells covers the cell a slow sustained turn actually occupies', () => {
  const cells = corridorFloorCells(corridorPathLatLon(TURNING_COAST));
  const keys = new Set(cells.map((c) => `${c.lat},${c.lon}`));
  assert.ok(keys.has('30.202,-97.659'),
    `the arc sits in 30.202,-97.659 for ~22 m; collected ${JSON.stringify(cells)}`);
});

test('corridorFloorCells: every cell the sampled arc passes through is collected', () => {
  // Independent oracle: re-walk the arc at 2 m granularity and demand that any
  // cell it occupies for a meaningful stretch is in the corridor.
  const cells = corridorFloorCells(corridorPathLatLon(TURNING_COAST));
  const keys = new Set(cells.map((c) => `${c.lat},${c.lon}`));
  const dwell = new Map();
  const stepSec = 60 / 500;
  for (let i = 0; i <= 500; i++) {
    const p = projectGroundArcLatLon(
      TURNING_COAST.displayLat, TURNING_COAST.displayLon, TURNING_COAST.courseDeg,
      TURNING_COAST.speedMps, TURNING_COAST.turnRateDps, (60 * i) / 500,
    );
    const c = coarseFloorCoord(p.lat, p.lon);
    const key = `${c.lat},${c.lon}`;
    dwell.set(key, (dwell.get(key) || 0) + stepSec * TURNING_COAST.speedMps);
  }
  // The walk guarantees cells occupied for at least a step's worth of ground.
  const guaranteedM = CORRIDOR_WALK_STEP_DEG * 111320;
  const missed = [...dwell.entries()]
    .filter(([key, metres]) => metres >= guaranteedM * 1.5 && !keys.has(key))
    .map(([key]) => key);
  assert.deepEqual(missed, [], `cells the arc occupies but the corridor missed: ${missed.join(' ')}`);
});

test('corridorPathLatLon spacing stays cell-sized as speed rises', () => {
  const fast = corridorPathLatLon({ ...TURNING_COAST, speedMps: 25, turnRateDps: 0 });
  for (let i = 1; i < fast.length; i++) {
    const dM = Math.hypot(
      (fast[i].lat - fast[i - 1].lat) * 111320,
      (fast[i].lon - fast[i - 1].lon) * 111320 * Math.cos(30.2 * Math.PI / 180),
    );
    assert.ok(dM <= CORRIDOR_SAMPLE_SPACING_M + 1, `sample gap ${dM.toFixed(1)} m`);
  }
});

test('corridorPathLatLon truncates a very long arc instead of thinning it', () => {
  const path = corridorPathLatLon({ ...TURNING_COAST, speedMps: 120, lookaheadSec: 60 });
  const end = path[path.length - 1];
  const lenM = Math.hypot(
    (end.lat - TURNING_COAST.displayLat) * 111320,
    (end.lon - TURNING_COAST.displayLon) * 111320 * Math.cos(30.2 * Math.PI / 180),
  );
  assert.ok(lenM <= CORRIDOR_MAX_LENGTH_M + 50, `projected ${lenM.toFixed(0)} m`);
});

// --- F2: fairness under PRODUCTION `seen` semantics -------------------------
// Production's `seen` holds only the CURRENT poll's batch, so a cell warmed on
// an earlier poll looked new and was charged again — a contact's near cells
// could eat its whole share every poll while the ground ahead stayed cold, and
// the ranked tail waited far longer than the policy implies.

test('allocateCorridorCells: warm cells are emitted but never charged', () => {
  const warm = new Set(['30,-97.66']);
  const cells = [{ lat: 30, lon: -97.66 }, { lat: 30.001, lon: -97.66 }];
  const got = allocateCorridorCells(
    [{ cells, cold: 1, speedMps: 5 }], new Set(), 1, 4, 0,
    (c) => warm.has(`${c.lat},${c.lon}`),
  );
  assert.equal(got.length, 2, 'the warm cell still reaches the mesh sampler');
  assert.deepEqual(got.map((c) => c.lat), [30, 30.001]);
});

test('allocateCorridorCells: a warm near-cell cannot eat the budget every poll', () => {
  const warm = new Set(['30,-97.66']);
  const hogWarmPrefix = { cells: [{ lat: 30, lon: -97.66 }, { lat: 30.001, lon: -97.66 }], cold: 1, speedMps: 5 };
  const other = { cells: [{ lat: 45, lon: -97.66 }], cold: 1, speedMps: 5 };
  const got = allocateCorridorCells(
    [hogWarmPrefix, other], new Set(), 2, 1, 0,
    (c) => warm.has(`${c.lat},${c.lon}`),
  );
  const lats = got.map((c) => c.lat);
  assert.ok(lats.includes(30.001), 'the cold cell BEHIND the warm one is still reached');
  assert.ok(lats.includes(45), 'and the other contact is still served');
});

test('allocateCorridorCells: 80 movers are served within the bound the policy implies', () => {
  const CELLS_EACH = 4;
  const BUDGET = 64;
  const COUNT = 80;
  // Round one charges at most one cell per candidate, so >= min(COUNT, BUDGET)
  // candidates are served per poll and an unserved candidate outranks every
  // served one next poll. Bound falls straight out of that.
  const boundPolls = Math.ceil(COUNT / BUDGET);
  const movers = [];
  for (let i = 0; i < COUNT; i++) {
    movers.push(Array.from(
      { length: CELLS_EACH },
      (_, k) => ({ lat: +(40 + i + k * 0.001).toFixed(3), lon: -97.66 }),
    ));
  }
  const warmed = new Set();
  const servedPoll = new Map();
  for (let poll = 0; poll < boundPolls; poll++) {
    const candidates = movers.map((cells) => ({
      cells,
      cold: cells.filter((c) => !warmed.has(`${c.lat},${c.lon}`)).length,
      speedMps: 10,
    }));
    // PRODUCTION SEMANTICS: `seen` starts empty every poll — it is this poll's
    // batch, not a memory of what has already warmed.
    const got = allocateCorridorCells(
      candidates, new Set(), BUDGET, 4, poll,
      (c) => warmed.has(`${c.lat},${c.lon}`),
    );
    for (const c of got) warmed.add(`${c.lat},${c.lon}`);
    movers.forEach((cells, i) => {
      if (servedPoll.has(i)) return;
      if (cells.some((c) => warmed.has(`${c.lat},${c.lon}`))) servedPoll.set(i, poll);
    });
  }
  const starved = movers.map((_, i) => i).filter((i) => !servedPoll.has(i));
  assert.deepEqual(starved, [],
    `unserved after the ceil(${COUNT}/${BUDGET}) = ${boundPolls}-poll bound: ${starved.join(',')}`);
});

test('allocateCorridorCells: every mover reaches its FULL corridor in bounded polls', () => {
  const CELLS_EACH = 4;
  const BUDGET = 64;
  const COUNT = 80;
  // Total cold demand / budget, rounded up — the work simply cannot finish
  // sooner, and the policy must not take longer.
  const boundPolls = Math.ceil((COUNT * CELLS_EACH) / BUDGET);
  const movers = [];
  for (let i = 0; i < COUNT; i++) {
    movers.push(Array.from(
      { length: CELLS_EACH },
      (_, k) => ({ lat: +(40 + i + k * 0.001).toFixed(3), lon: -97.66 }),
    ));
  }
  const warmed = new Set();
  for (let poll = 0; poll < boundPolls; poll++) {
    const candidates = movers.map((cells) => ({
      cells,
      cold: cells.filter((c) => !warmed.has(`${c.lat},${c.lon}`)).length,
      speedMps: 10,
    }));
    const got = allocateCorridorCells(
      candidates, new Set(), BUDGET, 4, poll,
      (c) => warmed.has(`${c.lat},${c.lon}`),
    );
    for (const c of got) warmed.add(`${c.lat},${c.lon}`);
  }
  const incomplete = movers
    .map((cells, i) => [i, cells.filter((c) => !warmed.has(`${c.lat},${c.lon}`)).length])
    .filter(([, cold]) => cold > 0);
  assert.deepEqual(incomplete, [],
    `corridors still cold after the ceil(${COUNT * CELLS_EACH}/${BUDGET}) = ${boundPolls}-poll bound`);
});

// ---------------------------------------------------------------------------
// neighborFloorM (2026-08-21 terrain-outage round). The Re:Earth proxy timed
// out four times in a row and a grounded contact rendered at the geoid, under
// the mesh it was parked on. An adjacent resolved cell is the measured
// stand-in the flights display-floor hold borrows when its own cell is cold.
// ---------------------------------------------------------------------------

test('neighborFloorM leans to the LOWEST resolved neighbour', () => {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.201, -97.66, 141);
  reportMeshFloorCell(30.199, -97.66, 152);
  reportMeshFloorCell(30.2, -97.659, 145);
  // Flat-ish ground: the neighbours are within metres and the choice barely
  // matters. It matters at a structure edge, which the next case covers.
  assert.equal(neighborFloorM({ lat: 30.2, lon: -97.66 }), 141);
});

test('neighborFloorM takes the apron, not the roof, at a structure edge', () => {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.201, -97.66, 120); // the apron
  reportMeshFloorCell(30.199, -97.66, 205); // the terminal roof next door
  // A parked contact is on the apron; it is never on the roof. Leaning high
  // here is what put planes in midair at gates during the field test.
  assert.equal(neighborFloorM({ lat: 30.2, lon: -97.66 }), 120);
});

test('neighborFloorM refuses a LONE neighbour — one reading cannot be checked', () => {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.199, -97.66, 205); // could be a roof; nothing to compare it to
  assert.equal(neighborFloorM({ lat: 30.2, lon: -97.66 }), null,
    'refusing leaves the contact unclamped, which is inert — borrowing floats it permanently');
  // A second reading makes the pair comparable, and the low one is the ground.
  reportMeshFloorCell(30.201, -97.66, 120);
  assert.equal(neighborFloorM({ lat: 30.2, lon: -97.66 }), 120);
});

test('neighborFloorM is null when nothing around the cell has resolved', () => {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  assert.equal(neighborFloorM({ lat: 30.2, lon: -97.66 }), null);
  assert.equal(neighborFloorM(null), null);
  assert.equal(neighborFloorM({ lat: Number.NaN, lon: -97.66 }), null);
});

test('neighborFloorM never counts the cell itself — it exists because that one is cold', () => {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
  reportMeshFloorCell(30.2, -97.66, 500);
  assert.equal(neighborFloorM({ lat: 30.2, lon: -97.66 }), null);
});
