#!/usr/bin/env node
/**
 * scripts/qa-floorhold-probe-cost.mjs — what does an unrationed adjacent-cell
 * probe actually cost?
 *
 * The display-floor hold borrows a floor from the eight cells adjacent to a
 * contact's own when that one is cold (`neighborFloorM`). An early draft
 * rationed those probes with a global per-tick budget and a fairness queue,
 * which produced two starvation defects in a row. This measures the thing the
 * scheduler was protecting, so the decision to delete it is a number rather
 * than an opinion.
 *
 * A probe is eight synchronous `Map` reads against the shared floor cache — no
 * fetch, no `sampleHeight`, nothing async. Every DEM request is driven by
 * `warmGroundFloor` from the poll loop instead, already bounded there by
 * DISPLAY_CORRIDOR_CELL_BUDGET and the resolver's single-flight chain.
 *
 *   node scripts/qa-floorhold-probe-cost.mjs
 */
import {
  neighborFloorM, reportMeshFloorCell, setMeshFloorPreferred, _clearMeshFloorCellsForTest,
} from '../src/data/groundFloor.js';

const CONTACTS = 200;   // a dense airport view, every contact probing at once
const TICK_MS = 80;     // the fleet dead-reckoning cadence
const THROTTLE_MS = 500; // NEIGHBOR_FLOOR_PROBE_MS

setMeshFloorPreferred(true);
for (const [label, warm] of [
  ['all cold (every neighbour a miss — the outage case)', false],
  ['all warm (all eight neighbours resolved)', true],
]) {
  _clearMeshFloorCellsForTest();
  const cells = [];
  for (let i = 0; i < CONTACTS; i += 1) {
    const cell = { lat: +(30 + i * 0.003).toFixed(3), lon: -97.66 };
    cells.push(cell);
    if (warm) {
      for (let dLat = -1; dLat <= 1; dLat += 1) {
        for (let dLon = -1; dLon <= 1; dLon += 1) {
          if (dLat === 0 && dLon === 0) continue; // the contact's OWN cell stays cold
          reportMeshFloorCell(cell.lat + dLat * 0.001, cell.lon + dLon * 0.001, 100 + i);
        }
      }
    }
  }
  for (let w = 0; w < 200; w += 1) for (const c of cells) neighborFloorM(c); // settle the JIT
  const runs = [];
  for (let r = 0; r < 60; r += 1) {
    const t0 = process.hrtime.bigint();
    for (const c of cells) neighborFloorM(c);
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  runs.sort((a, b) => a - b);
  const median = runs[Math.floor(runs.length / 2)];
  const worst = runs[runs.length - 1];
  console.log(`\n${label}`);
  console.log(`  ${CONTACTS} contacts x 8 cells on ONE tick : median ${median.toFixed(3)} ms, worst ${worst.toFixed(3)} ms`);
  console.log(`  share of one ${TICK_MS} ms fleet tick        : ${(worst / TICK_MS * 100).toFixed(2)}%`);
  console.log(`  sustained under the ${THROTTLE_MS} ms throttle   : ${(median * 1000 / THROTTLE_MS).toFixed(2)} ms per second`);
}
console.log('\nA global scheduler over this protects single-digit milliseconds.\n');
