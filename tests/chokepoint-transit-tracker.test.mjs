import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTransitTracker } from '../shared/chokepoint-transit-tracker.js';
import { CHOKEPOINT_TRANSIT_GATES } from '../shared/chokepoint-transit-gates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(resolve(__dirname, '../scripts/ais-relay.cjs'), 'utf-8');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const HORMUZ = 'Strait of Hormuz';
const GULF = [26.45, 55.95];
const GULF_OF_OMAN = [26.2, 56.85];

function relayConst(name) {
  const m = relaySrc.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `${name} not found in relay source`);
  return Number(new Function(`return (${m[1]})`)());
}

function tracker(name = HORMUZ) {
  const crossings = new Map();
  const t = createTransitTracker({
    gates: CHOKEPOINT_TRANSIT_GATES,
    maxTransitMs: relayConst('TRANSIT_MAX_GATE_GAP_MS'),
    cooldownMs: relayConst('TRANSIT_COOLDOWN_MS'),
    crossings,
  });
  const count = () => (crossings.get(name) || []).length;
  return { t, crossings, count };
}

function inside(lat, lon, [clat, clon, r]) {
  return (lat - clat) ** 2 + (lon - clon) ** 2 <= r * r;
}

describe('chokepoint transit tracker', () => {
  // Production on 2026-10-22: the counter published 38 Hormuz transits while
  // IMF PortWatch and independent AIS counts showed about 4. It counted any
  // vessel leaving a 2-degree circle, so Dubai, Fujairah and Bandar Abbas
  // port traffic was reported as strait transits.
  it('does not count port and anchorage traffic that stays on one side', () => {
    const { t, count } = tracker();
    const moves = [
      [[25.27, 55.29], [24.53, 54.38]], // Dubai to Abu Dhabi
      [[25.15, 56.35], [24.37, 56.75]], // Fujairah anchorage to Sohar
      [[27.15, 56.2], [26.95, 55.6]], // Bandar Abbas to Qeshm
    ];
    let now = 0;
    for (const [i, [from, to]] of moves.entries()) {
      t.observe(String(i), ...from, 'cargo', now += 10 * MIN);
      t.observe(String(i), ...to, 'cargo', now += 4 * HOUR);
    }
    assert.equal(count(), 0);
  });

  it('counts a vessel seen in the gate on each side, with its direction', () => {
    const { t, crossings } = tracker();
    t.observe('1', ...GULF, 'tanker', 0);
    t.observe('1', ...GULF_OF_OMAN, 'tanker', 5 * HOUR);
    t.observe('2', ...GULF_OF_OMAN, 'cargo', HOUR);
    t.observe('2', ...GULF, 'cargo', 6 * HOUR);
    assert.deepEqual(crossings.get(HORMUZ), [
      { mmsi: '1', type: 'tanker', ts: 5 * HOUR, direction: 'ab' },
      { mmsi: '2', type: 'cargo', ts: 6 * HOUR, direction: 'ba' },
    ]);
  });

  it('does not count a vessel that stays in one gate', () => {
    const { t, count } = tracker();
    for (let i = 0; i < 20; i++) t.observe('1', GULF[0] + i * 0.01, GULF[1], 'cargo', i * 30 * MIN);
    assert.equal(count(), 0);
  });

  it('counts a transit reported after the vessel table has dropped the vessel', () => {
    const { t, count } = tracker();
    t.observe('1', ...GULF, 'tanker', 0);
    t.prune(45 * MIN);
    t.observe('1', ...GULF_OF_OMAN, 'tanker', 8 * HOUR);
    assert.equal(count(), 1);
  });

  it('does not count when the second gate sighting is beyond the gap bound', () => {
    const gap = relayConst('TRANSIT_MAX_GATE_GAP_MS');
    const { t, count } = tracker();
    t.observe('1', ...GULF, 'cargo', 0);
    t.observe('1', ...GULF_OF_OMAN, 'cargo', gap + MIN);
    assert.equal(count(), 0);
  });

  it('forgets a gate sighting after the gap bound', () => {
    const gap = relayConst('TRANSIT_MAX_GATE_GAP_MS');
    const { t } = tracker();
    t.observe('1', ...GULF, 'cargo', 0);
    t.prune(gap + MIN);
    assert.equal(t.sightings.size, 0);
  });

  it('counts one transit per vessel per cooldown', () => {
    const { t, count } = tracker();
    t.observe('1', ...GULF, 'cargo', 0);
    t.observe('1', ...GULF_OF_OMAN, 'cargo', 10 * MIN);
    t.observe('1', ...GULF, 'cargo', 20 * MIN);
    assert.equal(count(), 1);
    t.observe('1', ...GULF_OF_OMAN, 'cargo', 60 * MIN);
    assert.equal(count(), 2);
  });

  it('counts a transit through either channel of a two-channel strait', () => {
    const { t, count } = tracker('Korea Strait');
    const { a, b } = CHOKEPOINT_TRANSIT_GATES['Korea Strait'];
    t.observe('1', a[1][0], a[1][1], 'cargo', 0);
    t.observe('1', b[1][0], b[1][1], 'cargo', 6 * HOUR);
    t.observe('2', a[0][0], a[0][1], 'cargo', 0);
    t.observe('2', b[0][0], b[0][1], 'cargo', 6 * HOUR);
    assert.equal(count(), 2);
  });

  it('keeps a sighting longer than the relay keeps a silent vessel', () => {
    assert.ok(relayConst('TRANSIT_MAX_GATE_GAP_MS') > relayConst('DENSITY_WINDOW'));
  });
});

describe('chokepoint transit gates', () => {
  it('defines gates for every chokepoint the relay publishes', () => {
    const map = relaySrc.match(/const RELAY_NAME_TO_ID = \{([\s\S]*?)\};/);
    assert.ok(map, 'RELAY_NAME_TO_ID not found in relay source');
    const names = [...map[1].matchAll(/'([^']+)':\s*'[a-z_]+'/g)].map((m) => m[1]);
    assert.ok(names.length >= 13);
    for (const name of names) assert.ok(CHOKEPOINT_TRANSIT_GATES[name], `${name} has no transit gates`);
  });

  it('never lets one position sit in gates on both sides', () => {
    for (const [name, { a, b }] of Object.entries(CHOKEPOINT_TRANSIT_GATES)) {
      for (const ca of a) {
        for (const cb of b) {
          const gap = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
          assert.ok(gap > ca[2] + cb[2], `${name} gates overlap`);
        }
      }
    }
  });

  it('keeps the Hormuz ports and anchorages out of both gates', () => {
    const ports = { Dubai: [25.27, 55.29], Fujairah: [25.15, 56.35], 'Bandar Abbas': [27.15, 56.2], Larak: [26.85, 56.35], Khasab: [26.18, 56.25], Dibba: [25.6, 56.27] };
    const { a, b } = CHOKEPOINT_TRANSIT_GATES[HORMUZ];
    for (const [port, [lat, lon]] of Object.entries(ports)) {
      for (const circle of [...a, ...b]) assert.ok(!inside(lat, lon, circle), `${port} is inside a Hormuz gate`);
    }
  });

  it('is what the relay counts with', () => {
    assert.match(relaySrc, /createDurableTransitTracker\(\{\s*gates: CHOKEPOINT_TRANSIT_GATES,/);
  });
});
