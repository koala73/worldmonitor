import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(resolve(root, 'server/worldmonitor/supply-chain/v1/_portwatch-upstream.ts'), 'utf-8');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf-8');

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

  it('does not contain fetch logic (moved to relay)', () => {
    assert.doesNotMatch(src, /cachedFetchJson/);
    assert.doesNotMatch(src, /getPortWatchTransits/);
    assert.doesNotMatch(src, /fetchAllPages/);
  });
});

describe('PortWatch relay seed loop', () => {
  it('uses ArcGIS FeatureServer endpoint', () => {
    assert.match(relaySrc, /arcgis\.com.*FeatureServer/);
  });

  it('writes to supply_chain:portwatch:v1 Redis key', () => {
    assert.match(relaySrc, /supply_chain:portwatch:v1/);
  });

  it('writes seed-meta for portwatch', () => {
    assert.match(relaySrc, /seed-meta:supply_chain:portwatch/);
  });

  it('defines startPortWatchSeedLoop', () => {
    assert.match(relaySrc, /function startPortWatchSeedLoop/);
  });

  it('reads pre-aggregated n_tanker/n_cargo/n_total columns', () => {
    assert.match(relaySrc, /n_tanker/);
    assert.match(relaySrc, /n_cargo/);
    assert.match(relaySrc, /n_total/);
  });

  it('computes week-over-week change percentage in relay', () => {
    assert.match(relaySrc, /pwComputeWowChangePct/);
  });

  it('uses ArcGIS timestamp syntax for date filter (not raw epoch)', () => {
    assert.match(relaySrc, /pwEpochToTimestamp/);
    assert.match(relaySrc, /timestamp '/);
    assert.doesNotMatch(relaySrc, /date >= \$\{sinceEpoch\}/);
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
