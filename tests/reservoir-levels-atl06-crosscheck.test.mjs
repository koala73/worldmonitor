// Accuracy gate for the ATL06 path: ATL06 levels over the Lake Mead, Tharthar and Ataturk
// core boxes, for the whole mission, must match the committed ATL13 baseline pass for pass
// and (Mead) the USBR daily gauge.
//
// Passes are matched by UTC date + flown RGT. A separate time-based assertion checks
// the identity independently: ATL13 must use segment RGT, not granule metadata RGT.
// The fixture holds the raw ATL06 per-pass statistics
// built by scripts/backfill-reservoir-levels.mjs with product "atl06" (no segments). The
// lowest-cluster rule and ATL06_MAX_SLOPE in scripts/_reservoir-levels.mjs were set on this
// comparison; changing them means rebuilding the fixture and keeping these numbers.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyPasses, tupleToPass } from '../scripts/_reservoir-levels.mjs';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const fixture = read('./fixtures/reservoir-levels/atl06-crosscheck.json');
const baseline = read('../scripts/data/reservoir-levels-baseline.json');
const watchlist = read('../scripts/data/strategic-reservoirs.json').reservoirs;
const gaugeFile = read('./fixtures/reservoir-levels/mead-gauge-usbr.json');

// Gate: RMSE after removing the datum offset <= 0.15 m against both the
// gauge and ATL13, and no matched ok pass off by more than 0.5 m.
const GATE_RMSE_M = 0.15;
const GATE_MAX_RESIDUAL_M = 0.5;

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

/** n, median offset (x - y), RMSE and max |residual| after the offset, Pearson r. */
function compare(pairs) {
  const x = pairs.map((p) => p[0]);
  const y = pairs.map((p) => p[1]);
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const diffs = pairs.map((p) => p[0] - p[1]);
  const offset = median(diffs);
  const resid = diffs.map((d) => d - offset);
  return {
    n: pairs.length,
    offset,
    rmse: Math.sqrt(resid.reduce((s, v) => s + v * v, 0) / resid.length),
    maxAbs: Math.max(...resid.map(Math.abs)),
    r: sxy / Math.sqrt(sxx * syy),
  };
}

const okPasses = (tuples) => classifyPasses(tuples.map(tupleToPass)).filter((p) => p.ok);

const MATCH_WINDOW_MS = 15 * 60 * 1000;

/** ATL06 ok passes matched to the ATL13 ok pass of the same overpass. */
function vsAtl13(id) {
  const atl13 = okPasses(baseline.reservoirs[id].passes);
  const pairs = [];
  for (const p of okPasses(fixture.reservoirs[id].passes)) {
    const q = atl13.find((x) => x.time.slice(0, 10) === p.time.slice(0, 10) && x.rgt === p.rgt);
    if (q) pairs.push([p.levelM, q.levelM]);
  }
  return compare(pairs);
}

function meadVsGauge() {
  return compare(okPasses(fixture.reservoirs.mead.passes).map((p) => [p.levelM, gaugeAt(Date.parse(p.time))]).filter((p) => p[1] != null));
}

describe('ATL06 cross-check against ATL13 and the Lake Mead gauge', () => {
  it('fixture boxes are the committed ATL13 core boxes', () => {
    for (const id of Object.keys(fixture.reservoirs)) {
      const entry = watchlist.find((e) => e.id === id);
      assert.deepEqual(fixture.reservoirs[id].core, entry.core, id);
    }
  });

  for (const id of ['mead', 'tharthar', 'ataturk']) {
    it(`${id}: time-matched ATL06 and ATL13 passes agree on flown RGT`, () => {
      const atl13 = okPasses(baseline.reservoirs[id].passes);
      let matched = 0;
      for (const p of okPasses(fixture.reservoirs[id].passes)) {
        const q = atl13.find(x => Math.abs(Date.parse(x.time) - Date.parse(p.time)) <= MATCH_WINDOW_MS);
        if (!q) continue;
        assert.equal(q.rgt, p.rgt, `${p.time}: ATL13/ATL06 track`);
        matched++;
      }
      assert.ok(matched >= 80, `matched ${matched}`);
    });

    it(`${id}: ATL06 matches ATL13 within the gate, pass for pass`, () => {
      const m = vsAtl13(id);
      assert.ok(m.n >= 80, `matched ${m.n}`);
      // Same EGM2008 datum: h_li - geoid_h lands on ATL13's ht_ortho within centimetres.
      assert.ok(Math.abs(m.offset) < 0.1, `offset ${m.offset}`);
      assert.ok(m.rmse <= GATE_RMSE_M, `rmse ${m.rmse}`);
      assert.ok(m.maxAbs <= GATE_MAX_RESIDUAL_M, `max |residual| ${m.maxAbs}`);
      assert.ok(m.r >= 0.999, `r ${m.r}`);
    });
  }

  it('mead: ATL06 matches the USBR gauge within the gate', () => {
    const m = meadVsGauge();
    assert.ok(m.n >= 100, `matched ${m.n}`);
    assert.ok(Math.abs(m.offset) < 0.5, `offset ${m.offset}`);
    assert.ok(m.rmse <= GATE_RMSE_M, `rmse ${m.rmse}`);
    assert.ok(m.maxAbs <= GATE_MAX_RESIDUAL_M, `max |residual| ${m.maxAbs}`);
    assert.ok(m.r >= 0.999, `r ${m.r}`);
  });
});
