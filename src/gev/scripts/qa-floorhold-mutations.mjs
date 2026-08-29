#!/usr/bin/env node
/**
 * Are the floor-hold pins actually load-bearing?
 *
 * A pin that is red only when you delete the whole feature proves very little.
 * This reverts each fix INDIVIDUALLY — the smallest edit that reintroduces the
 * original defect — and requires the floor suites to go red for it. Every entry
 * names the defect it restores, so the count is reproducible rather than
 * asserted in a commit message.
 *
 *   node scripts/qa-floorhold-mutations.mjs
 *
 * Restores every file on exit, including on failure.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = [
  'src/data/flights.test.mjs',
  'src/data/groundFloor.test.mjs',
  'src/data/meshFloorSampler.test.mjs',
  'src/data/renderAltitude.test.mjs',
];

const FLIGHTS = 'src/data/flights.js';
const FLOOR = 'src/data/groundFloor.js';
const ALT = 'src/data/renderAltitude.js';

/** @type {Array<{defect: string, edits: Array<{file: string, from: string, to: string}>}>} */
const MUTATIONS = [
  {
    defect: 'the display hold is gone — a cold cell clamps nothing (the original bug)',
    edits: [
      {
        file: FLIGHTS,
        from: '  if (state.heldTier === \'own\' && !state.seeded) return state.heldM;',
        to: '  if (true) return null;',
      },
    ],
  },
  {
    defect: 'the adjacent-cell tier is gone',
    edits: [
      {
        file: FLIGHTS,
        from: '  const near = neighborFloorM(cell);',
        to: '  const near = null;',
      },
    ],
  },
  {
    defect: 'a borrowed floor is owned forever — no upgrade when a better one warms',
    edits: [
      {
        file: FLIGHTS,
        from: '  if (state.heldTier === \'own\' && !state.seeded) return state.heldM;',
        to: '  if (state.heldTier && !state.seeded) return state.heldM;',
      },
    ],
  },
  {
    // The round-1 shape verbatim: memo on the RAW cell floor, checked BEFORE
    // the hold chain runs. A parked contact whose cell never warms then
    // returns its own unresolved answer forever.
    defect: 'a stationary unresolved contact memo-returns before the chain can retry',
    edits: [
      {
        file: FLIGHTS,
        from: '  const floor = cachedGroundFloor(cell.lat, cell.lon);',
        to: '  const floor = cachedGroundFloor(cell.lat, cell.lon);\n'
          + '  if (state && state.rawFloorM === floor\n'
          + '    && Cesium.Cartesian3.equals(pos, state.in)) return state.out || pos;',
      },
      {
        file: FLIGHTS,
        from: '  next.effectiveM = effective;',
        to: '  next.effectiveM = effective;\n  next.rawFloorM = floor;',
      },
    ],
  },
  {
    defect: 'the hold survives an airborne / model-owned interval',
    edits: [
      {
        file: FLIGHTS,
        from: '    _retireDisplayFloorState(icao24, nowMs);\n    return pos;',
        to: '    return pos;',
      },
    ],
  },
  {
    defect: 'the held floor is stretched without bound (no drift limit)',
    edits: [
      { file: FLIGHTS, from: '      <= HELD_FLOOR_MAX_DRIFT_KM)) {', to: '      <= Infinity)) {' },
    ],
  },
  {
    defect: 'a hold release SNAPS instead of easing',
    edits: [
      {
        file: FLIGHTS,
        from: '  if (next.easedM == null && wasHeld && Number.isFinite(stoodOnM)',
        to: '  if (false && next.easedM == null && wasHeld && Number.isFinite(stoodOnM)',
      },
    ],
  },
  {
    defect: 'rises are eased too — time spent under the mesh',
    edits: [
      {
        file: FLIGHTS,
        from: '    if (!Number.isFinite(effective) || effective >= next.easedM) {',
        to: '    if (!Number.isFinite(effective)) {',
      },
    ],
  },
  {
    defect: 'the ease escapes its release scope — every floor drop eased',
    edits: [
      {
        file: FLIGHTS,
        from: '  if (next.easedM == null && wasHeld && Number.isFinite(stoodOnM)',
        to: '  if (next.easedM == null && Number.isFinite(stoodOnM)',
      },
    ],
  },
  {
    // The owner-playtest regression: a roof neighbour taken as ground.
    defect: 'the neighbour lean takes the HIGHEST cell and floats a contact onto a roof',
    edits: [
      {
        file: FLOOR,
        from: '      if (lowest == null || h < lowest) lowest = h;',
        to: '      if (lowest == null || h > lowest) lowest = h;',
      },
    ],
  },
  {
    defect: 'a LONE neighbour is borrowed, with nothing to check it against',
    edits: [
      {
        file: FLOOR,
        from: '  return resolved >= NEIGHBOR_FLOOR_MIN_SAMPLES ? lowest : null;',
        to: '  return resolved >= 1 ? lowest : null;',
      },
    ],
  },
  {
    defect: 'the geoid guess outranks a held render height again (the poll-step bug)',
    edits: [
      { file: ALT, from: '  if (Number.isFinite(priorRenderM)) return null;', to: '  // guard removed' },
    ],
  },
  {
    defect: 'a re-probe onto a LOWER neighbour re-latches with a snap',
    edits: [
      {
        file: FLIGHTS,
        from: '  if (next.easedM == null && wasHeld && Number.isFinite(stoodOnM)\n    && Number.isFinite(effective) && effective < stoodOnM) {',
        to: '  if (next.easedM == null && Number.isFinite(floor) && wasHeld && Number.isFinite(stoodOnM)\n    && Number.isFinite(effective) && effective < stoodOnM) {',
      },
    ],
  },
  {
    // The from/duration shape this replaced: a FIXED anchor interpolated by
    // CUMULATIVE elapsed time. Re-evaluated against a target that moved
    // mid-approach it jumps by the eased fraction of the change.
    defect: 'the approach interpolates a fixed anchor, so a mid-approach retarget is a seam',
    edits: [
      { file: FLIGHTS, from: '      next.easeMs = nowMs;\n      const closed', to: '      const closed' },
      { file: FLIGHTS, from: '        next.easedM = value;', to: '        /* anchor stays fixed */' },
    ],
  },
  {
    defect: 'a global per-tick probe budget is reintroduced over the per-contact throttle',
    edits: [
      {
        file: FLIGHTS,
        from: '  state.probeMs = nowMs;\n  const near = neighborFloorM(cell);',
        to: '  globalThis.__mutGlobalProbeBudget = (globalThis.__mutGlobalProbeBudget || 0) + 1;\n'
          + '  if (globalThis.__mutGlobalProbeBudget > 12) return state.heldM;\n'
          + '  state.probeMs = nowMs;\n  const near = neighborFloorM(cell);',
      },
    ],
  },
  {
    defect: 'the per-tick step is unclamped, so a delayed tick snaps',
    edits: [
      {
        file: FLIGHTS,
        from: '      const closed = Math.min(FLOOR_EASE_MAX_STEP, 1 - Math.exp(-dtMs / FLOOR_EASE_TAU_MS));',
        to: '      const closed = 1 - Math.exp(-dtMs / FLOOR_EASE_TAU_MS);',
      },
    ],
  },
  {
    // The first cut: delete outright. An on_ground flap through a takeoff roll
    // then cold-starts the contact under the runway (field observation VIR138M).
    defect: 'retiring the hold DELETES it, so an on_ground flap cold-starts',
    edits: [
      {
        file: FLIGHTS,
        from: '  if (state.retiredMs == null) {',
        to: '  _displayFloorState.delete(icao24);\n  if (false) {',
      },
    ],
  },
  {
    defect: 'the rehydration seed never expires — an hour-old floor still answers',
    edits: [
      {
        file: FLIGHTS,
        from: '  return state.retiredMs != null && nowMs - state.retiredMs > FLOOR_SEED_GRACE_MS;',
        to: '  return false;',
      },
    ],
  },
  {
    // Expiry checked ONLY on the retire path: a contact that is parked and then
    // makes no calls at all never reaches it, and rehydration cleared
    // `retiredMs` before anything looked at it. Measured: parked 198 s, reused.
    defect: 'seed age is never validated at rehydration, only while still retired',
    edits: [
      {
        file: FLIGHTS,
        from: '  if (_seedExpired(next, nowMs)) _dropHeldFloor(next);',
        to: '  // rehydration takes whatever was parked, however old',
      },
    ],
  },
  {
    // The measured float: a 200 m seed reused 0.56 km away while the new
    // neighbourhood read 100 m and 105 m.
    defect: 'a rehydrated seed outranks fresh neighbour evidence',
    edits: [
      {
        file: FLIGHTS,
        from: '  if (state.heldTier === \'own\' && !state.seeded) return state.heldM;',
        to: '  if (state.heldTier === \'own\') return state.heldM;',
      },
    ],
  },
  {
    defect: 'a parked floor is not marked as a memory, so nothing can demote it',
    edits: [
      {
        file: FLIGHTS,
        from: '    state.seeded = true;        // what it answers with next is a memory, not a reading',
        to: '    state.seeded = false;',
      },
    ],
  },
  {
    defect: 'the seed flag survives a live reading, so a measured floor stays demoted',
    edits: [
      { file: FLIGHTS, from: '  state.seeded = false;\n  return floorM;', to: '  return floorM;' },
    ],
  },
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(ROOT, f), s);

function runTests() {
  try {
    execFileSync('node', ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { failed: 0, names: [] };
  } catch (e) {
    const raw = `${e.stdout || ''}${e.stderr || ''}`;
    const names = [...new Set([...raw.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]))];
    const m = raw.match(/^ℹ fail (\d+)/m);
    return { failed: m ? Number(m[1]) : -1, names, raw };
  }
}

const baseline = runTests();
console.log(`baseline: ${baseline.failed} failing`);
if (baseline.failed !== 0) {
  console.error('the suites must be green before mutating');
  if (baseline.raw) console.error(baseline.raw.slice(-2000));
  process.exit(1);
}

let allRed = true;
for (const mut of MUTATIONS) {
  const backups = new Map();
  let applied = true;
  for (const e of mut.edits) {
    if (!backups.has(e.file)) backups.set(e.file, read(e.file));
    const cur = read(e.file);
    if (!cur.includes(e.from)) {
      console.log(`  [STALE] ${mut.defect} — anchor not found in ${e.file}`);
      applied = false;
      break;
    }
    write(e.file, cur.replace(e.from, e.to));
  }
  if (applied) {
    const r = runTests();
    if (r.failed > 0) {
      console.log(`  [RED]   ${mut.defect} — ${r.failed} failing`);
      for (const n of r.names) console.log(`            ↳ ${n}`);
    } else {
      console.log(`  [GREEN] ${mut.defect} — NOT PINNED`);
      allRed = false;
    }
  } else {
    allRed = false;
  }
  for (const [file, text] of backups) write(file, text);
}

const after = runTests();
console.log(`\nrestored: ${after.failed} failing (must be 0)`);
console.log(allRed && after.failed === 0
  ? `RESULT: ${MUTATIONS.length}/${MUTATIONS.length} defects pinned`
  : 'RESULT: FAIL');
process.exit(allRed && after.failed === 0 ? 0 : 1);
