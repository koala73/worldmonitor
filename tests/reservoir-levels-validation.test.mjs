// Accuracy gate for the committed reservoir baseline: the ICESat-2 Lake Mead series must
// match the USBR daily gauge (SDI 1930). The per-pass quality rules and the despike in
// scripts/_reservoir-levels.mjs were tuned on this comparison; loosening them or moving
// the Mead core box must keep these numbers.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyPasses, tupleToPass } from '../scripts/_reservoir-levels.mjs';

const baseline = JSON.parse(readFileSync(new URL('../scripts/data/reservoir-levels-baseline.json', import.meta.url), 'utf8'));
const gaugeFile = JSON.parse(readFileSync(new URL('./fixtures/reservoir-levels/mead-gauge-usbr.json', import.meta.url), 'utf8'));

// End-of-day reading for local date D is taken at D+1 00:00 MST (07:00 UTC).
const gauge = gaugeFile.data.map(([d, m]) => ({ t: Date.parse(`${d}T07:00:00Z`) + 86_400_000, m }));

function gaugeAt(t) {
  let lo = 0;
  let hi = gauge.length - 1;
  if (t < gauge[0].t || t > gauge[hi].t) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (gauge[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = gauge[lo], b = gauge[hi];
  if (b.t - a.t > 3 * 86_400_000) return null;
  return a.m + (b.m - a.m) * (t - a.t) / (b.t - a.t || 1);
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

function meadComparison() {
  const passes = classifyPasses(baseline.reservoirs.mead.passes.map(tupleToPass)).filter((p) => p.ok);
  const matched = passes.map((p) => ({ ...p, gauge: gaugeAt(Date.parse(p.time)) })).filter((p) => p.gauge != null);
  const x = matched.map((p) => p.levelM);
  const y = matched.map((p) => p.gauge);
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const diffs = matched.map((p) => p.levelM - p.gauge);
  const offset = median(diffs);
  const resid = diffs.map((d) => d - offset);
  return {
    matched: matched.length,
    r: sxy / Math.sqrt(sxx * syy),
    offset,
    rmse: Math.sqrt(resid.reduce((s, v) => s + v * v, 0) / resid.length),
    maxAbs: Math.max(...resid.map(Math.abs)),
    gaugeRange: Math.max(...y) - Math.min(...y),
  };
}

describe('Lake Mead validation of the committed baseline', () => {
  const m = meadComparison();

  it('matches enough passes across a real level range', () => {
    assert.ok(m.matched >= 100, `matched ${m.matched}`);
    assert.ok(m.gaugeRange > 10, `gauge range ${m.gaugeRange}`);
  });

  it('RMSE <= 0.10 m after removing the datum offset, r >= 0.999, no pass off by more than 0.3 m', () => {
    assert.ok(Math.abs(m.offset) < 0.5, `offset ${m.offset}`);
    assert.ok(m.rmse <= 0.10, `rmse ${m.rmse}`);
    assert.ok(m.r >= 0.999, `r ${m.r}`);
    assert.ok(m.maxAbs <= 0.3, `max |residual| ${m.maxAbs}`);
  });
});
