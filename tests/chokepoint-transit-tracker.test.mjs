import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTransitTracker } from '../shared/chokepoint-transit-tracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(resolve(__dirname, '../scripts/ais-relay.cjs'), 'utf-8');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const MALACCA = { name: 'Malacca Strait', lat: 2.5, lon: 101.5, radius: 2 };
const INSIDE = [2.5, 101.5];
const OUTSIDE = [6.0, 98.0];

function relayConst(name) {
  const m = relaySrc.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `${name} not found in relay source`);
  return Number(new Function(`return (${m[1]})`)());
}

function tracker(overrides = {}) {
  const crossings = new Map();
  const t = createTransitTracker({
    zones: [MALACCA],
    minDwellMs: 5 * MIN,
    cooldownMs: 30 * MIN,
    maxExitGapMs: relayConst('TRANSIT_MAX_EXIT_GAP_MS'),
    crossings,
    ...overrides,
  });
  const count = () => (crossings.get(MALACCA.name) || []).length;
  return { t, crossings, count };
}

describe('chokepoint transit tracker', () => {
  it('counts an exit reported in consecutive positions', () => {
    const { t, count } = tracker();
    t.observe('1', ...INSIDE, 'cargo', 0);
    t.observe('1', ...OUTSIDE, 'cargo', 10 * MIN);
    assert.equal(count(), 1);
  });

  // Production on 2026-10-08: 30 vessels sat inside the Malacca zone while it
  // recorded no crossing in 51 hours. The relay dropped zone membership with
  // the vessel after 30 silent minutes, so a sparse-coverage exit never
  // matched its entry.
  it('counts an exit reported after the vessel table has dropped the vessel', () => {
    const { t, count } = tracker();
    t.observe('1', ...INSIDE, 'tanker', 0);
    t.prune(45 * MIN);
    t.observe('1', ...OUTSIDE, 'tanker', 90 * MIN);
    assert.equal(count(), 1);
  });

  it('keeps the original entry time when a vessel reappears inside after a gap', () => {
    const { t, count } = tracker();
    t.observe('1', ...INSIDE, 'cargo', 0);
    t.observe('1', ...INSIDE, 'cargo', 3 * HOUR);
    t.observe('1', ...OUTSIDE, 'cargo', 3 * HOUR + MIN);
    assert.equal(count(), 1);
  });

  it('starts a new visit when a vessel reappears inside after the exit gap bound', () => {
    const gap = relayConst('TRANSIT_MAX_EXIT_GAP_MS');
    const { t, count } = tracker();
    t.observe('1', ...INSIDE, 'cargo', 0);
    t.observe('1', ...INSIDE, 'cargo', gap + HOUR);
    t.observe('1', ...OUTSIDE, 'cargo', gap + HOUR + MIN);
    assert.equal(count(), 0);
  });

  it('does not count an exit reported after the exit gap bound', () => {
    const gap = relayConst('TRANSIT_MAX_EXIT_GAP_MS');
    const { t, count } = tracker();
    t.observe('1', ...INSIDE, 'cargo', 0);
    t.observe('1', ...OUTSIDE, 'cargo', gap + MIN);
    assert.equal(count(), 0);
  });

  it('forgets membership after the exit gap bound', () => {
    const gap = relayConst('TRANSIT_MAX_EXIT_GAP_MS');
    const { t } = tracker();
    t.observe('1', ...INSIDE, 'cargo', 0);
    t.prune(gap + MIN);
    assert.equal(t.memberships.size, 0);
  });

  it('does not count a visit shorter than the dwell time', () => {
    const { t, count } = tracker();
    t.observe('1', ...INSIDE, 'cargo', 0);
    t.observe('1', ...OUTSIDE, 'cargo', 4 * MIN);
    assert.equal(count(), 0);
  });

  it('counts one crossing per vessel per cooldown', () => {
    const { t, count } = tracker();
    t.observe('1', ...INSIDE, 'cargo', 0);
    t.observe('1', ...OUTSIDE, 'cargo', 10 * MIN);
    t.observe('1', ...INSIDE, 'cargo', 11 * MIN);
    t.observe('1', ...OUTSIDE, 'cargo', 20 * MIN);
    assert.equal(count(), 1);
    t.observe('1', ...INSIDE, 'cargo', 50 * MIN);
    t.observe('1', ...OUTSIDE, 'cargo', 60 * MIN);
    assert.equal(count(), 2);
  });

  it('records the vessel type and exit time', () => {
    const { t, crossings } = tracker();
    t.observe('9', ...INSIDE, 'tanker', 0);
    t.observe('9', ...OUTSIDE, 'tanker', 10 * MIN);
    assert.deepEqual(crossings.get(MALACCA.name), [{ mmsi: '9', type: 'tanker', ts: 10 * MIN }]);
  });

  it('holds membership longer than the relay keeps a silent vessel', () => {
    assert.ok(relayConst('TRANSIT_MAX_EXIT_GAP_MS') > relayConst('DENSITY_WINDOW'));
  });
});
