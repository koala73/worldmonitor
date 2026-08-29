#!/usr/bin/env node
/**
 * Are the fly_route pins actually load-bearing?
 *
 * A pin that is red only when you delete the whole feature proves very little.
 * This reverts each fix INDIVIDUALLY — the smallest edit that reintroduces the
 * original defect — and requires src/routeCinematics.test.mjs to go red for it.
 * Every entry names the defect it restores, so the count is reproducible rather
 * than asserted in a commit message.
 *
 *   node scripts/qa-flyroute-mutations.mjs
 *
 * Restores the file on exit, including on failure.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'src', 'cameraVerbs.js');
const TESTS = 'src/routeCinematics.test.mjs';

/** @type {Array<{defect: string, from: string, to: string}>} */
const MUTATIONS = [
  {
    defect: 'interrupt leaves the horizon tilted (round-1 behaviour)',
    from: 'const leveled = wasRoute && !tracking ? levelCameraRoll() : false;',
    to: 'const leveled = false;',
  },
  {
    defect: 'completion freezes a bank into the final frame',
    from: 'const appliedBankDeg = state.bankDeg * profile.speed;',
    to: 'const appliedBankDeg = state.bankDeg;',
  },
  {
    defect: 'heading lerps in Cartesian space and cannot cross a U-turn',
    from: '    const turned = Cesium.Matrix3.multiplyByVector(rotation, state.headingDir, _frameDir);',
    to: '    const turned = Cesium.Cartesian3.lerp(state.headingDir, gaze, k, _frameDir);',
  },
  {
    defect: 'the exact-180° bank direction becomes a floating-point coin toss',
    from: '  if (cosTurn <= -1 + ANTIPODAL_EPS && Math.abs(sinLeft) < ANTIPODAL_EPS) return Math.PI;',
    to: '  // branch removed',
  },
  {
    defect: 'a cold cell is read as sea level (the 1.3 km underground bug)',
    from: '    state.floorM = Number.isFinite(state.floorM) ? state.floorM : state.coldSeedFloorM;',
    to: '    state.floorM = carto.height;',
  },
  {
    defect: 'the flight never warms its own corridor',
    from: '  warmRouteCorridor(state, 0, ROUTE_WARM_START_M);',
    to: '  // warm removed',
  },
  {
    defect: 'the dolly races the fire-and-forget warm instead of arming for it',
    from: '  if (canAnswer && !state.floorKnown && !state.departed && state.armS < ROUTE_ARM_S) {',
    to: '  if (false) {',
  },
  {
    defect: 'no mesh probe, so a permanently cold DEM is flown blind',
    from: '  if (cold.length && !state.meshProbeSpent && typeof state.probeFn === \'function\') {',
    to: '  if (false) {',
  },
  {
    defect: 'the launch-altitude hold is dropped and the eye descends blind',
    from: '  if (!state.floorKnown && Number.isFinite(state.safeHoldHeightM)) {',
    to: '  if (false) {',
  },
  {
    defect: 'releasing the hold onto late data drops the eye without a limit',
    from: '  if (Number.isFinite(state.appliedHeightM)) {',
    to: '  if (false) {',
  },
  {
    defect: 'a late mid-flight floor is taken whole and snaps the eye',
    from: '    state.floorM = routeFloorHoldM(state.floorM, sampledFloor, step);\n    state.floorKnown = true;',
    to: '    state.floorM = sampledFloor;\n    state.floorKnown = true;',
  },
  {
    defect: 'the lookahead floor read is dropped (clearance only underfoot)',
    from: '      const warm = [here, ahead].filter((value) => Number.isFinite(value));',
    to: '      const warm = [here].filter((value) => Number.isFinite(value));',
  },
  {
    defect: 'the shaping floor adopts rises instantly and pops at cell edges',
    from: '  if (!Number.isFinite(previousM)) return sampledM;',
    to: '  if (!Number.isFinite(previousM) || sampledM >= previousM) return sampledM;',
  },
  {
    defect: 'the mesh probe fires every arming frame instead of once per route',
    from: '  if (cold.length && !state.meshProbeSpent && typeof state.probeFn === \'function\') {\n    state.meshProbeSpent = true;',
    to: '  if (cold.length && typeof state.probeFn === \'function\') {\n    state.meshProbeSpent = true;',
  },
  {
    defect: 'one warm cell resolves a corridor whose other cells are unknown',
    from: '  if (cold.length && !state.meshProbeCoveredCold) return false;',
    to: '  // partial-corridor guard removed',
  },
  {
    defect: 'the probe re-reads cells the cache already answered',
    from: '      const probe = state.probeFn(cold) || {};',
    to: '      const probe = state.probeFn(cells) || {};',
  },
  {
    defect: 'the hard clearance clamp reads the SMOOTHED floor, not the raw sample',
    from: '    (Number.isFinite(sampledFloor) ? sampledFloor : state.floorM) + ROUTE_MIN_CLEARANCE_M,',
    to: '    state.floorM + ROUTE_MIN_CLEARANCE_M,',
  },
  {
    defect: 'levelling also RE-FRAMES the camera (destination passed with the HPR)',
    from: '    cam.setView({ orientation: { heading: cam.heading, pitch: cam.pitch, roll: 0 } });',
    to: '    cam.setView({ destination: Cesium.Cartesian3.fromDegrees(0, 0, 5000), orientation: { heading: cam.heading, pitch: cam.pitch, roll: 0 } });',
  },
  {
    defect: 'the OS reduced-motion preference is never consulted',
    from: '      reducedMotion: prefersReducedMotion(),',
    to: '      reducedMotion: false,',
  },
];

const original = fs.readFileSync(SOURCE, 'utf8');
let caught = 0;
const missed = [];

process.on('exit', () => fs.writeFileSync(SOURCE, original));

console.log(`\nfly_route pin strength — ${MUTATIONS.length} individual reverts\n`);
for (const { defect, from, to } of MUTATIONS) {
  if (!original.includes(from)) {
    missed.push(`${defect} (ANCHOR MISSING — the mutation no longer applies)`);
    console.log(`  \x1b[31mSTALE\x1b[0m ${defect}`);
    continue;
  }
  fs.writeFileSync(SOURCE, original.replace(from, to));
  let red = false;
  let by = '';
  try {
    execFileSync('node', ['--test', TESTS], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    red = true;
    const failed = String(error.stdout || '').split('\n')
      .filter((line) => line.trim().startsWith('✖') && line.includes('('))
      .map((line) => line.trim().slice(2).split(' (')[0]);
    by = [...new Set(failed)].slice(0, 2).join('; ');
  }
  if (red) {
    caught += 1;
    console.log(`  \x1b[32mRED  \x1b[0m ${defect}\n         caught by: ${by}`);
  } else {
    missed.push(defect);
    console.log(`  \x1b[31mGREEN\x1b[0m ${defect}  <-- no pin covers this`);
  }
}
fs.writeFileSync(SOURCE, original);

console.log(`\n  ${caught}/${MUTATIONS.length} defects caught by the pins`);
if (missed.length) {
  console.log('\n  uncovered:');
  for (const item of missed) console.log(`    - ${item}`);
}
process.exitCode = missed.length ? 1 : 0;
