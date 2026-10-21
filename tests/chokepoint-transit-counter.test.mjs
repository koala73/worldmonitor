import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyVesselType } from '../shared/ais-vessel-type.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf-8');

// classifyVesselType used to be sliced out of the relay with a regex and
// rebuilt via `new Function`, so the test exercised a copy rather than the
// code that ships. It now lives in shared/ and the relay requires it.
describe('classifyVesselType', () => {
  it('classifies tankers from ITU ship-type codes 80-89', () => {
    for (const code of [80, 84, 89]) assert.equal(classifyVesselType(code), 'tanker');
  });

  it('classifies cargo from codes 70-79', () => {
    for (const code of [70, 75, 79]) assert.equal(classifyVesselType(code), 'cargo');
  });

  it('classifies everything else as other', () => {
    // Passenger (60s), fishing (30), tug (52), naval (35), and the unknown 0.
    for (const code of [0, 30, 35, 52, 69, 60, 90, 99]) {
      assert.equal(classifyVesselType(code), 'other');
    }
  });

  it('treats the bucket boundaries as closed intervals', () => {
    assert.equal(classifyVesselType(69), 'other');
    assert.equal(classifyVesselType(70), 'cargo');
    assert.equal(classifyVesselType(79), 'cargo');
    assert.equal(classifyVesselType(80), 'tanker');
    assert.equal(classifyVesselType(89), 'tanker');
    assert.equal(classifyVesselType(90), 'other');
  });

  it('does not classify a missing or non-numeric ship type as cargo or tanker', () => {
    for (const code of [undefined, null, NaN, 'tanker']) {
      assert.equal(classifyVesselType(code), 'other');
    }
  });
});

// The transit counter's timing constants and its 15-chokepoint geofence table
// still live inside the relay, which boots a live server on import. These read
// the declarations directly — the constants are the contract (a cooldown
// shorter than the dwell window would double-count a single transit), and
// there is no importable surface to exercise instead.
describe('chokepoint transit counter timing constants', () => {
  const evalConst = (name) => {
    const m = relaySrc.match(new RegExp(`const ${name} = ([^;]+);`));
    assert.ok(m, `${name} not found in relay source`);
    return Number(new Function(`return (${m[1]})`)());
  };

  it('requires a longer cooldown than the dwell it counts, or one transit counts twice', () => {
    assert.ok(evalConst('TRANSIT_COOLDOWN_MS') > evalConst('MIN_DWELL_MS'));
  });

  it('keeps the counting window well above a single cooldown', () => {
    assert.ok(evalConst('TRANSIT_WINDOW_MS') > evalConst('TRANSIT_COOLDOWN_MS') * 4);
  });

  it('keeps the key TTL at least 6 publish intervals long', () => {
    assert.ok(
      evalConst('CHOKEPOINT_TRANSIT_TTL') * 1000 >= evalConst('CHOKEPOINT_TRANSIT_INTERVAL_MS') * 6,
    );
  });
});
