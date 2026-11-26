// The classifier's critical/high boundary at the batch size production sends (#10976).
//
// Realtime news alerts go out for `critical` only. The relay labels only cache misses, so
// most of its completions carry few titles: relay logs showed a median of 19 per completion
// before the classify cache (#10987) and about 5 after. The four sibling suites capture at
// 50 per completion. On 2026-11-26 a candidate prompt example passed all of them and, in
// 5-title completions, labelled a judged statement ("Israel says ceasefire with Hezbollah
// could collapse within days") critical in 4 of 10 runs, where the production prompt did not.
//
// The capture asks the relay prompt in 5-title completions: one judged boundary headline
// (the statement and shipping-energy sets) among four tuning headlines, at a random
// position, with fresh neighbours every pass. scripts/lib/classify-eval.mjs builds it.
//
// Registered before any capture at this design:
// - Design: REGISTERED below. A capture with other values, or with many skipped titles,
//   does not count.
// - Count: `critical` on rows judged below critical and not borderline
//   (isClearFalseCritical), summed over every pass. Borderline rows are reported, not counted.
// - Baseline: `relay-baseline`, the first capture of the production prompt at the
//   registered design, kept whatever it shows and never re-captured.
// - Gate: `relay-current`, the prompt production sends, may carry at most the baseline's
//   count plus gateMargin, a one-sided 95% bound on the difference between two independent
//   draws at the baseline's per-row rates. "No more than the baseline" with no margin would
//   fail about 45% of re-captures of an equally good prompt (Monte Carlo at the pilot's rates).
// - Sizing: three incumbent pilots at unregistered seeds put every counted critical on one
//   row, at 6 to 8 of 10 passes. At that rate, 40 passes catch a prompt that adds 0.4 counted
//   criticals per pass (4 of 110, the candidate's rate on the statement set) about 96% of the
//   time, and pass an equally good prompt about 98% of the time.
// - Teeth: the dcc144836c example must fail this gate. If it passes, that is the result;
//   the second positive control is the production prompt without its terms-versus-attack
//   example line ("Iran sets its terms for reopening Hormuz" -> high).
//
// A new prompt is accepted by re-capturing `relay-current` (command below). The baseline
// moves only with a new registration: a different model or changed judged sets.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  batchBoundaryRowsSha,
  buildBatchBoundaryRows,
  isClearFalseCritical,
  planBatchBoundaryPass,
  scoreBatchBoundary,
} from '../scripts/lib/classify-eval.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJudged = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const judged = buildBatchBoundaryRows(readJudged);

const REGISTERED = { path: 'relay', chunk: 5, passes: 40, seed: 1, rowsSha: '7674c400365bdfd0' };
const BASELINE_PROMPT_SHA = 'b610d9e51327d5e3';
const MAX_UNLABELLED_SHARE = 0.05;
const MAX_UNLABELLED_PER_BOUNDARY_ROW = 2;

function gateMargin(rows, baseline) {
  let variance = 0;
  for (const r of rows) {
    const c = baseline.labels[r.title];
    if (!c || !isClearFalseCritical(r, 'critical')) continue;
    const k = c.critical ?? 0;
    variance += k * (1 - k / c.asked);
  }
  return Math.ceil(1.645 * Math.sqrt(2 * variance));
}
const gateThreshold = (rows, baseline) => scoreBatchBoundary(rows, baseline).clearFalseCritical + gateMargin(rows, baseline);

describe('batch-boundary rule', () => {
  const rows = [
    { title: 'statement', judge: 'high', borderline: false, role: 'boundary' },
    { title: 'border', judge: 'high', borderline: true, role: 'boundary' },
    { title: 'event', judge: 'critical', borderline: false, role: 'boundary' },
    { title: 'news', judge: 'info', borderline: false, role: 'fill' },
  ];
  const capture = (labels) => ({ labels });

  it('counts critical only on rows judged below critical and not borderline', () => {
    assert.equal(isClearFalseCritical(rows[0], 'critical'), true);
    assert.equal(isClearFalseCritical(rows[0], 'high'), false);
    assert.equal(isClearFalseCritical(rows[1], 'critical'), false);
    assert.equal(isClearFalseCritical(rows[2], 'critical'), false);
    assert.equal(isClearFalseCritical(rows[3], 'critical'), true);
    const s = scoreBatchBoundary(rows, capture({
      statement: { asked: 40, critical: 3, high: 37 },
      border: { asked: 40, critical: 20, high: 20 },
      event: { asked: 40, critical: 30, high: 9 },
      news: { asked: 10, critical: 1, info: 8 },
    }));
    assert.equal(s.clearFalseCritical, 4);
    assert.equal(s.borderlineFalseCritical, 20);
    assert.deepEqual([s.clearCriticalKept, s.clearCriticalAsked], [30, 40]);
    assert.deepEqual([s.unlabelled, s.asked], [2, 130]);
  });

  it('allows a fresh draw of the baseline and fails 0.4 more counted criticals per pass', () => {
    const baseline = capture({ statement: { asked: 40, critical: 28, high: 12 }, news: { asked: 40, info: 40 } });
    assert.equal(gateMargin(rows, baseline), 7);
    assert.equal(gateThreshold(rows, baseline), 35);
    const clean = capture({ statement: { asked: 40, high: 40 }, news: { asked: 40, info: 40 } });
    assert.equal(gateMargin(rows, clean), 0, 'a clean baseline allows no counted critical');
    const redrawn = capture({ statement: { asked: 40, critical: 33, high: 7 }, news: { asked: 40, info: 40 } });
    const worse = capture({ statement: { asked: 40, critical: 28, high: 12 }, news: { asked: 40, critical: 16, info: 24 } });
    assert.ok(scoreBatchBoundary(rows, redrawn).clearFalseCritical <= gateThreshold(rows, baseline));
    assert.ok(scoreBatchBoundary(rows, worse).clearFalseCritical > gateThreshold(rows, baseline));
  });

  it('asks every boundary row once a pass, beside fill rows no other batch in the pass gets', () => {
    const passes = [0, 1, 2].map((pass) => planBatchBoundaryPass(judged, { seed: REGISTERED.seed, pass, chunk: REGISTERED.chunk }));
    for (const batches of passes) {
      assert.equal(batches.length, judged.boundary.length);
      for (const b of batches) {
        assert.equal(b.length, REGISTERED.chunk);
        assert.equal(b.filter((r) => r.role === 'boundary').length, 1);
      }
      const titles = batches.flat().map((r) => r.title);
      assert.equal(new Set(titles).size, titles.length);
      assert.deepEqual(new Set(batches.map((b) => b.find((r) => r.role === 'boundary').title)), new Set(judged.boundary.map((r) => r.title)));
    }
    assert.notDeepEqual(passes[0], passes[1], 'each pass draws new neighbours');
    assert.deepEqual(passes[0], planBatchBoundaryPass(judged, { seed: REGISTERED.seed, pass: 0, chunk: REGISTERED.chunk }), 'a pass is reproducible from its seed');
    const at = new Set(passes.flatMap((batches) => batches.map((b) => b.findIndex((r) => r.role === 'boundary'))));
    assert.equal(at.size, REGISTERED.chunk, 'the boundary row moves through every position');
  });

  it('is registered on the judged sets as they stand', () => {
    // If this reds, a judged set changed: the counts no longer describe these rows. That is
    // a new registration, so re-capture relay-baseline and relay-current and update rowsSha.
    assert.equal(batchBoundaryRowsSha(judged.rows), REGISTERED.rowsSha);
    assert.equal(judged.boundary.length, 47);
    assert.equal(judged.rows.filter((r) => r.role === 'fill').length, 413);
  });
});
