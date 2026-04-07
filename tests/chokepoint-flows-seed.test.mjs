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

// useDwt requires majority DWT coverage in the baseline window
function resolveUseDwt(prev90) {
  const dwtDays = prev90.filter(d => (d.capTanker ?? 0) > 0).length;
  return dwtDays >= Math.ceil(prev90.length / 2);
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

  it('determines useDwt from 90-day baseline window, not recent 7 days', () => {
    assert.match(src, /dwtBaselineDays/);
    assert.doesNotMatch(src, /const capSum = last7/);
    assert.doesNotMatch(src, /capBaselineSum > 0/);
  });

  it('requires majority DWT coverage in baseline (Math.ceil length / 2)', () => {
    assert.match(src, /Math\.ceil\(prev90\.length\s*\/\s*2\)/);
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

  it('stays on DWT path when recent capTanker collapses to zero (disruption)', () => {
    // Baseline has DWT data; recent week has zero capTanker (severe disruption)
    // Seeder must NOT fall back to tanker counts — zero DWT IS the signal
    const history = [
      ...makeDays(7, 5, 0, 0),       // last 7 days: tanker=5, capTanker=0 (disrupted)
      ...makeDays(90, 60, 50000, 7),  // baseline 90 days: tanker=60, capTanker=50000 (normal)
    ].sort((a, b) => a.date.localeCompare(b.date));
    const last7 = history.slice(-7);
    const prev90 = history.slice(-97, -7);

    const useDwt = resolveUseDwt(prev90); // baseline has DWT → useDwt = true
    assert.equal(useDwt, true, 'useDwt should be true (DWT present in baseline)');

    const ratioDwt = computeFlowRatio(last7, prev90, true);    // capTanker: 0/50000 ≈ 0
    const ratioCount = computeFlowRatio(last7, prev90, false);  // tanker: 5/60 ≈ 0.083

    // DWT correctly signals near-total disruption
    assert.ok(ratioDwt < 0.05, `DWT ratio should be ~0 (total disruption), got ${ratioDwt}`);
    // Count-based estimate would be misleadingly higher
    assert.ok(ratioCount > 0.05, `Count ratio should be higher (5/60), got ${ratioCount}`);
    // DWT gives more accurate (lower) disruption signal
    assert.ok(ratioDwt < ratioCount, 'DWT ratio should be lower than count ratio during DWT-collapse disruption');
  });

  it('does NOT activate DWT mode on sparse baseline (< 50% days with DWT)', () => {
    // Only 3 of 30 baseline days have DWT data — should fall back to counts
    const sparseBaseline = [
      ...makeDays(3, 60, 50000, 7),   // 3 days with DWT
      ...makeDays(27, 60, 0, 10),     // 27 days without DWT
    ].sort((a, b) => a.date.localeCompare(b.date));
    assert.equal(resolveUseDwt(sparseBaseline), false, 'should not use DWT with <50% baseline coverage');
  });

  it('activates DWT mode when majority of baseline has DWT data', () => {
    const denseBaseline = makeDays(90, 60, 50000, 7); // all 90 days have DWT
    assert.equal(resolveUseDwt(denseBaseline), true, 'should use DWT with full baseline coverage');
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
