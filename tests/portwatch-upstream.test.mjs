import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(resolve(root, 'server/worldmonitor/supply-chain/v1/_portwatch-upstream.ts'), 'utf-8');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf-8');
const seederSrc = readFileSync(resolve(root, 'scripts/seed-portwatch.mjs'), 'utf-8');

function classifyVesselType(name) {
  const lower = name.toLowerCase();
  if (lower.includes('tanker') || lower.includes('lng') || lower.includes('lpg')) return 'tanker';
  if (lower.includes('cargo') || lower.includes('container') || lower.includes('bulk')) return 'cargo';
  return 'other';
}

function computeWowChangePct(history) {
  if (history.length < 14) return 0;
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  let thisWeek = 0;
  let lastWeek = 0;
  for (let i = 0; i < 7 && i < sorted.length; i++) thisWeek += sorted[i].total;
  for (let i = 7; i < 14 && i < sorted.length; i++) lastWeek += sorted[i].total;
  if (lastWeek === 0) return 0;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 1000) / 10;
}

function makeDays(count, dailyTotal, startOffset) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.now() - (startOffset + i) * 86400000);
    days.push({
      date: d.toISOString().slice(0, 10),
      tanker: 0,
      cargo: dailyTotal,
      other: 0,
      total: dailyTotal,
    });
  }
  return days;
}

describe('PortWatch type exports', () => {
  it('exports TransitDayCount interface', () => {
    assert.match(src, /export\s+interface\s+TransitDayCount/);
  });

  it('exports PortWatchData interface', () => {
    assert.match(src, /export\s+interface\s+PortWatchData/);
  });

  it('exports PortWatchChokepointData interface', () => {
    assert.match(src, /export\s+interface\s+PortWatchChokepointData/);
  });

  it('does not contain fetch logic (moved to seed-portwatch.mjs)', () => {
    assert.doesNotMatch(src, /cachedFetchJson/);
    assert.doesNotMatch(src, /getPortWatchTransits/);
    assert.doesNotMatch(src, /fetchAllPages/);
  });
});

describe('PortWatch standalone seeder (seed-portwatch.mjs)', () => {
  it('exports fetchAll and validateFn', () => {
    assert.match(seederSrc, /export\s+async\s+function\s+fetchAll/);
    assert.match(seederSrc, /export\s+function\s+validateFn/);
  });

  it('uses ArcGIS FeatureServer endpoint', () => {
    assert.match(seederSrc, /arcgis\.com.*FeatureServer/);
  });

  it('writes to supply_chain:portwatch:v1 Redis key', () => {
    assert.match(seederSrc, /supply_chain:portwatch:v1/);
  });

  it('fetches all 5 vessel type count fields', () => {
    assert.match(seederSrc, /n_container/);
    assert.match(seederSrc, /n_dry_bulk/);
    assert.match(seederSrc, /n_general_cargo/);
    assert.match(seederSrc, /n_roro/);
    assert.match(seederSrc, /n_tanker/);
  });

  it('fetches all 5 DWT capacity fields', () => {
    assert.match(seederSrc, /capacity_container/);
    assert.match(seederSrc, /capacity_dry_bulk/);
    assert.match(seederSrc, /capacity_general_cargo/);
    assert.match(seederSrc, /capacity_roro/);
    assert.match(seederSrc, /capacity_tanker/);
  });

  it('computes week-over-week change percentage', () => {
    assert.match(seederSrc, /computeWow/);
  });

  it('uses ArcGIS timestamp syntax for date filter', () => {
    assert.match(seederSrc, /epochToTimestamp/);
    assert.match(seederSrc, /timestamp '/);
  });

  it('covers 180 days of history', () => {
    assert.match(seederSrc, /HISTORY_DAYS\s*=\s*180/);
  });

  it('relay no longer defines startPortWatchSeedLoop', () => {
    assert.doesNotMatch(relaySrc, /function startPortWatchSeedLoop/);
  });

  it('relay reads PORTWATCH_REDIS_KEY fresh every seedTransitSummaries cycle (no stale in-memory guard)', () => {
    assert.match(relaySrc, /supply_chain:portwatch:v1/);
    assert.doesNotMatch(relaySrc, /let latestPortwatchData/);
    assert.doesNotMatch(relaySrc, /if\s*\(\s*!latestPortwatchData\s*\)/);
  });
});

describe('classifyVesselType', () => {
  it('"Oil Tanker" -> tanker', () => {
    assert.equal(classifyVesselType('Oil Tanker'), 'tanker');
  });

  it('"Container Ship" -> cargo', () => {
    assert.equal(classifyVesselType('Container Ship'), 'cargo');
  });

  it('"General Cargo" -> cargo', () => {
    assert.equal(classifyVesselType('General Cargo'), 'cargo');
  });

  it('"LNG Carrier" -> tanker', () => {
    assert.equal(classifyVesselType('LNG Carrier'), 'tanker');
  });

  it('"Fishing Vessel" -> other', () => {
    assert.equal(classifyVesselType('Fishing Vessel'), 'other');
  });
});

describe('computeWowChangePct', () => {
  it('7 days at 50/day vs previous 7 at 40/day = +25%', () => {
    const history = [...makeDays(7, 50, 0), ...makeDays(7, 40, 7)];
    assert.equal(computeWowChangePct(history), 25);
  });

  it('zero previous week returns 0 (no division by zero)', () => {
    const history = [...makeDays(7, 50, 0), ...makeDays(7, 0, 7)];
    assert.equal(computeWowChangePct(history), 0);
  });

  it('fewer than 14 days returns 0', () => {
    assert.equal(computeWowChangePct(makeDays(10, 50, 0)), 0);
  });
});

import { detectTrafficAnomaly } from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';

describe('detectTrafficAnomaly', () => {
  it('flags >50% drop in war_zone as signal', () => {
    // 7 recent days at 5/day, 30 baseline days at 100/day
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.signal, 'should flag as signal');
    assert.ok(result.dropPct >= 90, `expected >90% drop, got ${result.dropPct}%`);
  });

  it('does NOT flag >50% drop in normal threat chokepoint', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'normal');
    assert.equal(result.signal, false);
  });

  it('does NOT flag when drop is <50%', () => {
    // 7 days at 60/day, 30 baseline at 100/day = 40% drop
    const history = [...makeDays(7, 60, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.signal, false);
  });

  it('returns no signal with <37 days of history (needs 7 recent + 30 baseline)', () => {
    const result = detectTrafficAnomaly(makeDays(36, 100, 0), 'war_zone');
    assert.equal(result.signal, false);
    assert.equal(result.dropPct, 0);
  });

  it('flags critical threat level same as war_zone', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    assert.ok(detectTrafficAnomaly(history, 'critical').signal);
  });

  it('ignores low-baseline chokepoints (< 2 vessels/day avg)', () => {
    const history = [...makeDays(7, 0, 0), ...makeDays(30, 1, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.signal, false);
  });
});
