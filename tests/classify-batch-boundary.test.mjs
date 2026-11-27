// The classifier's critical/high boundary at the batch size production sends (#10976).
//
// Realtime news alerts go out for `critical` only. The relay labels only cache misses, so
// most of its completions carry few titles: relay logs showed a median of 19 per completion
// before the classify cache (#10987) and about 5 after. The four sibling suites capture at
// 50 per completion. On 2026-11-26 a candidate prompt example passed all of them and, in
// 5-title completions, labelled a judged statement ("Israel says ceasefire with Hezbollah
// could collapse within days") critical in 4 of 10 runs. The production prompt did not, but
// only with that probe's one fixed set of neighbours.
//
// The capture asks the relay prompt in 5-title completions: one judged boundary headline
// (the statement and shipping-energy sets) among four tuning headlines, at a random
// position, with fresh neighbours every pass. scripts/lib/classify-eval.mjs builds it.
//
// Registered before any capture at this design:
// - Design: REGISTERED below. A capture with other values, or with many skipped titles,
//   does not count.
// - Count, as first registered (e0e31e1692): `critical` on rows judged below critical and
//   not borderline. Re-registered 2026-11-26 by the maintainer, after the first result and
//   with every capture's score under both wordings in hand: `critical` on every row judged
//   below critical, borderline rows included (isFalseCritical), summed over every pass. A
//   borderline high labelled critical still pages users on a story the judge called high.
//   The design, baseline capture and margin method did not change.
// - Baseline: `relay-baseline`, the first capture of the production prompt at the
//   registered design, kept whatever it shows and never re-captured.
// - Gate: `relay-current`, the prompt production sends, may carry at most the baseline's
//   count plus gateMargin, a one-sided 95% bound on the difference between two independent
//   draws at the baseline's per-row rates. "No more than the baseline" with no margin would
//   fail about 45% of re-captures of an equally good prompt (Monte Carlo at the pilot's rates).
//   The re-registration keeps this margin and the frozen baseline capture.
// - Sizing: 40 passes. Under the first count, the pilots' one counted row (6 to 8 of 10)
//   gave about 96% detection of 0.4 more counted criticals per pass. Under the re-registered
//   count, at relay-baseline's own per-row rates (six rows between 0.53 and 1.0), 40 passes
//   detect 0.4 more per pass about 53% of the time, 0.8 more about 97%, and pass an equally
//   good prompt about 96% of the time (Monte Carlo).
// - Teeth: the dcc144836c example must fail this gate. If it passes, that is the result;
//   the second positive control is the production prompt without its terms-versus-attack
//   example line ("Iran sets its terms for reopening Hormuz" -> high).
//
// Result under the first count, 2026-11-26, seed 1.
// - The production prompt labels the ceasefire statement critical in 23 of 40 passes
//   (relay-baseline), against 0 of 10 with the probe's fixed neighbours. It was the only
//   non-borderline critical.
// - The dcc144836c example passed, at 24 against a threshold of 31. Its extra criticals were
//   on two borderline shipping-attack rows: borderline criticals rose from 138 to 171.
// - The second positive control failed, at 211.
//
// Result under the re-registered count, from the same captures, seed 1. Threshold 175: the
// baseline's 161 plus a margin of 14.
// - The production prompt counts 161 (relay-baseline) and 167 on its 2026-11-26 re-capture.
//   An off-design capture of it at seed 2 counts 165. 138 of the baseline's 161 are on five
//   borderline rows, four of them shipping attacks and closures around Hormuz.
// - The dcc144836c example fails, at 195.
// - The second positive control fails, at 457.
//
// #11432, 2026-11-27: the relay prompt now says critical needs the event to have happened,
// and that a warning, threat, vow, condition or prediction is high. Added after the score
// log showed three threats and vows labelled critical and delivered 72 times in five days.
// Two more checks on relay-current. The ceasefire warning at most 10 of 40 was set before any
// candidate ran. Clear-critical labels were first held to the baseline's 863 with no margin;
// after three candidates had been captured (838, 859, 874) that bar was replaced with the
// baseline minus the gate's own kind of margin (floor 846), because same-prompt captures
// ran 863 to 874. Not blind: 859 fails the first bar and passes this one. The rule alone
// (874 kept, false critical 127) demoted a real Saudi Civil Defense post reporting the
// Houthi attack on a Riyadh tower, critical in production: alone in a completion it went
// from 39 to 17 of 40. The shipped prompt adds an example of an attack the target reports
// and passes both checks: ceasefire warning 0 of 40, false critical 145, clear-critical kept
// 976 of 1017. Off-design at seed 2: 0 of 40, 158, 973 of 1016. A scratch wording with no reported-event sentence, whose threat sentence
// ended "whoever says it", kept 838 at seed 1 and fails the floor: it demoted attacks
// reported through a party ("Pentagon says US jets struck ...").
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
  extractRelayOpenRouterModel,
  extractRelayPrompt,
  incompleteBoundaryRows,
  isFalseCritical,
  planBatchBoundaryPass,
  promptSha,
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
    if (!c || !isFalseCritical(r, 'critical')) continue;
    const k = c.critical ?? 0;
    variance += k * (1 - k / c.asked);
  }
  return Math.ceil(1.645 * Math.sqrt(2 * variance));
}
const gateThreshold = (rows, baseline) => scoreBatchBoundary(rows, baseline).falseCritical + gateMargin(rows, baseline);
// The same bound on the rows scoreBatchBoundary counts as clear-critical: judged critical
// and not borderline.
function clearCriticalMargin(rows, baseline) {
  let variance = 0;
  for (const r of rows) {
    const c = baseline.labels[r.title];
    if (!c || r.judge !== 'critical' || r.borderline) continue;
    const k = c.critical ?? 0;
    variance += k * (1 - k / c.asked);
  }
  return Math.ceil(1.645 * Math.sqrt(2 * variance));
}

describe('batch-boundary rule', () => {
  const rows = [
    { title: 'statement', judge: 'high', borderline: false, role: 'boundary' },
    { title: 'border', judge: 'high', borderline: true, role: 'boundary' },
    { title: 'event', judge: 'critical', borderline: false, role: 'boundary' },
    { title: 'news', judge: 'info', borderline: false, role: 'fill' },
  ];
  const capture = (labels) => ({ labels });

  it('counts critical on every row judged below critical, borderline rows included', () => {
    assert.equal(isFalseCritical(rows[0], 'critical'), true);
    assert.equal(isFalseCritical(rows[0], 'high'), false);
    assert.equal(isFalseCritical(rows[1], 'critical'), true);
    assert.equal(isFalseCritical(rows[2], 'critical'), false);
    assert.equal(isFalseCritical(rows[3], 'critical'), true);
    const s = scoreBatchBoundary(rows, capture({
      statement: { asked: 40, critical: 3, high: 37 },
      border: { asked: 40, critical: 20, high: 20 },
      event: { asked: 40, critical: 30, high: 9 },
      news: { asked: 10, critical: 1, info: 8 },
    }));
    assert.equal(s.falseCritical, 24);
    assert.equal(s.borderlineFalseCritical, 20);
    assert.deepEqual(s.falseCriticalTitles, ['3/40 statement', '20/40 (borderline) border', '1/10 news']);
    assert.deepEqual([s.clearCriticalKept, s.clearCriticalAsked], [30, 40]);
    assert.deepEqual([s.unlabelled, s.asked], [2, 130]);
  });

  it('refuses a capture that skipped a boundary row, however few skips there are overall', () => {
    const boundary = rows.slice(0, 3);
    const answered = { asked: 40, high: 40 };
    const ok = capture({ statement: answered, border: answered, event: { asked: 40, critical: 38, high: 0 } });
    assert.deepEqual(incompleteBoundaryRows(boundary, ok, { passes: 40, maxPerRow: 2 }), []);
    const skipped = capture({ statement: answered, border: answered, event: { asked: 40, critical: 37 } });
    assert.deepEqual(incompleteBoundaryRows(boundary, skipped, { passes: 40, maxPerRow: 2 }), ['unlabelled 3 of 40: event']);
    const short = capture({ statement: answered, border: { asked: 39, high: 39 }, event: { asked: 40, critical: 40 } });
    assert.deepEqual(incompleteBoundaryRows(boundary, short, { passes: 40, maxPerRow: 2 }), ['asked 39 of 40: border']);
  });

  it('allows a fresh draw of the baseline and fails a borderline row pushed to critical', () => {
    const baseline = capture({ statement: { asked: 40, critical: 28, high: 12 }, border: { asked: 40, critical: 20, high: 20 }, news: { asked: 40, info: 40 } });
    assert.equal(gateMargin(rows, baseline), 10, 'ceil(1.645 * sqrt(2 * (8.4 + 10)))');
    assert.equal(gateThreshold(rows, baseline), 58);
    const clean = capture({ statement: { asked: 40, high: 40 }, border: { asked: 40, high: 40 }, news: { asked: 40, info: 40 } });
    assert.equal(gateMargin(rows, clean), 0, 'a clean baseline allows no counted critical');
    const redrawn = capture({ statement: { asked: 40, critical: 31, high: 9 }, border: { asked: 40, critical: 24, high: 16 }, news: { asked: 40, info: 40 } });
    const worse = capture({ statement: { asked: 40, critical: 28, high: 12 }, border: { asked: 40, critical: 40 }, news: { asked: 40, info: 40 } });
    assert.ok(scoreBatchBoundary(rows, redrawn).falseCritical <= gateThreshold(rows, baseline));
    assert.ok(scoreBatchBoundary(rows, worse).falseCritical > gateThreshold(rows, baseline));
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

const { captures } = readJudged('tests/fixtures/classify-batch-boundary.json');
// Written from relay-baseline under the re-registered count; the test below holds them to it.
const BASELINE = { falseCritical: 161, threshold: 175, clearCriticalKept: 863, clearCriticalFloor: 846 };
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');

describe('batch-boundary captures', () => {
  it('are the registered design, with every boundary row answered', () => {
    for (const name of ['relay-baseline', 'relay-current']) {
      const c = captures[name];
      assert.ok(c, name);
      assert.deepEqual({ path: c.path, chunk: c.chunk, passes: c.passes, seed: c.seed, rowsSha: c.rowsSha }, REGISTERED, name);
      assert.equal(c.completions, REGISTERED.passes * judged.boundary.length, name);
      const s = scoreBatchBoundary(judged.rows, c);
      assert.equal(s.asked, c.completions * REGISTERED.chunk, name);
      assert.ok(s.unlabelled <= s.asked * MAX_UNLABELLED_SHARE, `${name}: ${s.unlabelled} unlabelled`);
      assert.deepEqual(incompleteBoundaryRows(judged.boundary, c, { passes: REGISTERED.passes, maxPerRow: MAX_UNLABELLED_PER_BOUNDARY_ROW }), [], name);
    }
  });

  it('relay-baseline is the prompt the gate was registered on, and sets the threshold', () => {
    const b = captures['relay-baseline'];
    assert.equal(b.promptSha, BASELINE_PROMPT_SHA);
    assert.equal(scoreBatchBoundary(judged.rows, b).falseCritical, BASELINE.falseCritical);
    assert.equal(gateThreshold(judged.rows, b), BASELINE.threshold);
  });

  it('records the false criticals the baseline already carries', () => {
    // At 50 titles per completion the production prompt labels the ceasefire statement high
    // (classify-judged-statements.json). In 5-title completions it is critical in 23 of 40.
    const s = scoreBatchBoundary(judged.rows, captures['relay-baseline']);
    assert.deepEqual(s.falseCriticalTitles, [
      '23/40 Israel says ceasefire with Hezbollah could collapse within days',
      '26/40 (borderline) UN says 25 seafarers killed in, around Hormuz since US-Israel war on Iran',
      '40/40 (borderline) Three Tankers Attacked in Two Days in Strait of Hormuz Crisis - The Maritime Executive',
      '40/40 (borderline) Trump faces escalating oil crisis over Iran blocking Strait of Hormuz - ABC News - Breaking News, Latest News and Videos',
      "21/40 (borderline) IAEA raises alarm over Iran's nuclear program as tanker hits mine in Strait of Hormuz - Ynetnews",
      '11/17 (borderline) \u2018Run! Get away!\u2019: witnesses recount Israeli \u2018double tap\u2019 strike that killed child and medic in Gaza',
    ]);
  });

  it('relay-current is the prompt and model production sends today', () => {
    // If this reds, re-capture (about $0.23, 3 minutes):
    //   node --env-file=.env.local scripts/eval-classify-labels.mjs --batch-boundary --capture relay-current --force
    // and review the per-title counts with: node scripts/eval-classify-labels.mjs --batch-boundary
    assert.equal(captures['relay-current'].promptSha, promptSha(extractRelayPrompt(relaySrc)));
    assert.equal(captures['relay-current'].model, extractRelayOpenRouterModel(relaySrc));
    assert.equal(captures['relay-current'].model, captures['relay-baseline'].model, 'a model change is a new registration');
  });

  it('relay-current carries no more false criticals than the baseline allows', () => {
    const s = scoreBatchBoundary(judged.rows, captures['relay-current']);
    assert.ok(s.falseCritical <= BASELINE.threshold,
      `${s.falseCritical} false criticals over ${REGISTERED.passes} passes, threshold ${BASELINE.threshold}:\n${s.falseCriticalTitles.join('\n')}`);
  });

  it('relay-current labels the ceasefire warning critical in at most a quarter of passes (#11432)', () => {
    // A warning that a ceasefire could collapse is not a collapse. The production prompt
    // before #11432 labelled it critical in 23 and 24 of 40 passes (relay-baseline and its
    // re-capture) and 19 of 40 at seed 2. 10 of 40 sits below that whole spread.
    const c = captures['relay-current'].labels['Israel says ceasefire with Hezbollah could collapse within days'];
    assert.equal(c.asked, REGISTERED.passes);
    assert.ok((c.critical ?? 0) <= 10, `critical in ${c.critical} of ${c.asked} passes`);
  });

  it('relay-current keeps the baseline\'s clear-critical labels, within the noise margin (#11432)', () => {
    // The false-critical gate never counts misses, so a prompt that demotes real attacks
    // and closures to high would pass it. The floor is the baseline's count minus the same
    // one-sided 95% margin, taken over the clear-critical rows.
    const b = captures['relay-baseline'];
    const kept = (c) => scoreBatchBoundary(judged.rows, c).clearCriticalKept;
    assert.equal(kept(b), BASELINE.clearCriticalKept);
    assert.equal(kept(b) - clearCriticalMargin(judged.rows, b), BASELINE.clearCriticalFloor);
    assert.ok(kept(captures['relay-current']) >= BASELINE.clearCriticalFloor,
      `kept ${kept(captures['relay-current'])} clear-critical labels, floor ${BASELINE.clearCriticalFloor}`);
  });
});
