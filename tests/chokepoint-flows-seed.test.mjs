import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src = readFileSync(resolve(root, 'scripts/seed-chokepoint-flows.mjs'), 'utf-8');
const baselinesSrc = readFileSync(resolve(root, 'scripts/seed-chokepoint-baselines.mjs'), 'utf-8');

// ── flow computation helpers ──────────────────────────────────────────────────

function makeDays(count, tanker, capTanker, startOffset = 0) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.now() - (startOffset + i) * 86400000);
    days.push({
      date: d.toISOString().slice(0, 10),
      tanker,
      capTanker,
      cargo: 0, other: 0, total: tanker,
      container: 0, dryBulk: 0, generalCargo: 0, roro: 0,
      capContainer: 0, capDryBulk: 0, capGeneralCargo: 0, capRoro: 0,
    });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

function computeFlowRatio(last7, prev90, useDwt) {
  const key = useDwt ? 'capTanker' : 'tanker';
  const current7d = last7.reduce((s, d) => s + d[key], 0) / last7.length;
  const baseline90d = prev90.reduce((s, d) => s + d[key], 0) / prev90.length;
  if (baseline90d <= 0) return 1;
  return Math.min(1.5, Math.max(0, current7d / baseline90d));
}

function isDisrupted(history, baseline90d, useDwt) {
  const last3 = history.slice(-3);
  const key = useDwt ? 'capTanker' : 'tanker';
  return last3.length === 3 && last3.every(d => baseline90d > 0 && (d[key] / baseline90d) < 0.85);
}

// ── seeder source assertions ──────────────────────────────────────────────────

describe('seed-chokepoint-flows.mjs exports', () => {
  it('exports fetchAll', () => {
    assert.match(src, /export\s+async\s+function\s+fetchAll/);
  });

  it('exports validateFn', () => {
    assert.match(src, /export\s+function\s+validateFn/);
  });

  it('writes to energy:chokepoint-flows:v1', () => {
    assert.match(src, /energy:chokepoint-flows:v1/);
  });

  it('reads supply_chain:portwatch:v1', () => {
    assert.match(src, /supply_chain:portwatch:v1/);
  });

  it('reads energy:chokepoint-baselines:v1', () => {
    assert.match(src, /energy:chokepoint-baselines:v1/);
  });

  it('has 7 chokepoints with EIA baselines', () => {
    const matches = src.match(/canonicalId:/g);
    assert.ok(matches && matches.length === 7, `expected 7 canonicalId entries, got ${matches?.length ?? 0}`);
  });

  it('has TTL of 259200 (3 days)', () => {
    assert.match(src, /259[_\s]*200/);
  });

  it('prefers DWT (capTanker) when available', () => {
    assert.match(src, /capTanker/);
    assert.match(src, /useDwt/);
  });

  it('caps flow ratio at 1.5', () => {
    assert.match(src, /1\.5/);
  });

  it('disruption threshold is 0.85', () => {
    assert.match(src, /0\.85/);
  });

  it('wraps runSeed in isMain guard', () => {
    assert.match(src, /isMain.*=.*process\.argv/s);
    assert.match(src, /if\s*\(isMain\)/);
  });
});

describe('seed-chokepoint-baselines.mjs relayId', () => {
  it('each chokepoint has a relayId field', () => {
    assert.match(baselinesSrc, /relayId:\s*'hormuz_strait'/);
    assert.match(baselinesSrc, /relayId:\s*'malacca_strait'/);
    assert.match(baselinesSrc, /relayId:\s*'suez'/);
    assert.match(baselinesSrc, /relayId:\s*'bab_el_mandeb'/);
    assert.match(baselinesSrc, /relayId:\s*'bosphorus'/);
    assert.match(baselinesSrc, /relayId:\s*'dover_strait'/);
    assert.match(baselinesSrc, /relayId:\s*'panama'/);
  });
});

// ── flow computation unit tests ───────────────────────────────────────────────

describe('flow ratio computation', () => {
  it('normal operations: 60/day vs 60/day baseline = ratio 1.0', () => {
    const history = makeDays(97, 60, 0);
    const last7 = history.slice(-7);
    const prev90 = history.slice(-97, -7);
    const ratio = computeFlowRatio(last7, prev90, false);
    assert.ok(Math.abs(ratio - 1.0) < 0.01, `expected ~1.0, got ${ratio}`);
  });

  it('Hormuz disruption: 5/day recent vs 60/day baseline ≈ ratio 0.083', () => {
    const history = [...makeDays(7, 5, 0, 0), ...makeDays(90, 60, 0, 7)].sort((a, b) => a.date.localeCompare(b.date));
    const last7 = history.slice(-7);
    const prev90 = history.slice(-97, -7);
    const ratio = computeFlowRatio(last7, prev90, false);
    assert.ok(ratio < 0.2, `expected disrupted ratio <0.2, got ${ratio}`);
  });

  it('caps at 1.5 for surge scenarios', () => {
    const history = [...makeDays(7, 120, 0, 0), ...makeDays(90, 60, 0, 7)].sort((a, b) => a.date.localeCompare(b.date));
    const last7 = history.slice(-7);
    const prev90 = history.slice(-97, -7);
    const ratio = computeFlowRatio(last7, prev90, false);
    assert.ok(ratio <= 1.5, `ratio should be capped at 1.5, got ${ratio}`);
  });

  it('DWT variant uses capTanker instead of tanker', () => {
    // Mix: tanker=10 (reduced), capTanker=50000 (normal) — DWT shows no disruption
    const history = [...makeDays(7, 10, 50000, 0), ...makeDays(90, 60, 50000, 7)].sort((a, b) => a.date.localeCompare(b.date));
    const last7 = history.slice(-7);
    const prev90 = history.slice(-97, -7);
    const ratioCount = computeFlowRatio(last7, prev90, false); // tanker: 10/60 ≈ 0.17
    const ratioDwt = computeFlowRatio(last7, prev90, true);    // capTanker: 50000/50000 = 1.0
    assert.ok(ratioCount < 0.3, `count ratio should be low (tanker disrupted), got ${ratioCount}`);
    assert.ok(Math.abs(ratioDwt - 1.0) < 0.01, `DWT ratio should be ~1.0 (no DWT disruption), got ${ratioDwt}`);
  });
});

describe('disrupted flag', () => {
  it('flags disrupted when each of last 3 days is below 0.85', () => {
    const history = [...makeDays(7, 5, 0, 0), ...makeDays(90, 60, 0, 7)].sort((a, b) => a.date.localeCompare(b.date));
    const baseline90d = 60;
    assert.equal(isDisrupted(history, baseline90d, false), true);
  });

  it('does NOT flag when last 3 days are above 0.85', () => {
    const history = makeDays(97, 55, 0); // 55/60 = 0.917 > 0.85
    const baseline90d = 60;
    assert.equal(isDisrupted(history, baseline90d, false), false);
  });

  it('does NOT flag with zero baseline', () => {
    const history = makeDays(97, 0, 0);
    assert.equal(isDisrupted(history, 0, false), false);
  });
});
