// Pins for the L9 matrix's verdict classifier (scripts/qa-l9-matrix.mjs).
//
// The matrix is a RELEASE GATE, so the only bug class that really matters is a
// check that reports green without verifying anything. Every assertion here
// locks one path where that was possible. Mirrors src/unitTestRunner.test.mjs,
// which likewise pins logic that lives under scripts/.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PASS, PASS_SKIPS, FAIL, CRASH, SKIP, OUTCOMES,
  normalizeVerdict, classifyNoScoreboard, readResultLine, readCockpit,
  readFloorVerdict, keyGuard, applyKnownConditions, requiredCreditFor, satisfiesEngines,
  isCalibratedAllocationRuntime, trafficFlowInconclusive,
  CREDIT_EXPECTATIONS, CREDIT_EXEMPT_LAYERS,
} from '../scripts/qa-l9-matrix.mjs';

const run = (over = {}) => ({ code: 0, out: '', err: '', timedOut: false, ...over });

// ── the closed outcome enum ───────────────────────────────────────────────
test('a malformed verdict cannot slip through as a silent skip', () => {
  // Previously these rendered as SKIPPED[undefined], landed in no counter, and
  // left the run green.
  for (const bad of [undefined, null, 'PASS', 42, [], {}]) {
    const v = normalizeVerdict(bad);
    assert.equal(v.status, CRASH, `expected CRASH for ${JSON.stringify(bad)}`);
    assert.match(v.detail, /verified nothing|unknown outcome/);
  }
});

test('an unknown status is a runner bug, not an outcome', () => {
  const v = normalizeVerdict({ status: 'MOSTLY_FINE', detail: 'x' });
  assert.equal(v.status, CRASH);
  assert.match(v.detail, /unknown outcome "MOSTLY_FINE"/);
});

test('a SKIPPED verdict must name its reason', () => {
  assert.equal(normalizeVerdict({ status: SKIP, detail: 'x' }).status, CRASH);
  assert.equal(normalizeVerdict({ status: SKIP, detail: 'x', tag: 'NOPE' }).status, CRASH);
  assert.equal(normalizeVerdict({ status: SKIP, detail: 'x', tag: 'ENV' }).status, SKIP);
});

test('valid verdicts pass through untouched', () => {
  for (const status of OUTCOMES) {
    const input = status === SKIP ? { status, detail: 'd', tag: 'OWNER-RUN' } : { status, detail: 'd' };
    assert.equal(normalizeVerdict(input), input);
  }
});

// ── harness scoreboard reading ────────────────────────────────────────────
test('a missing scoreboard is a harness crash, not an environment skip', () => {
  // Exit 2 is NOT evidence of environment: several harnesses use it for
  // arbitrary top-level exceptions.
  const v = classifyNoScoreboard('RESULT', run({ code: 2, err: 'TypeError: boom' }));
  assert.equal(v.status, CRASH);
});

test('ENV is only claimed when the harness itself says the server was absent', () => {
  const v = classifyNoScoreboard('RESULT', run({ code: 2, err: 'Dev server not reachable at http://localhost:4220' }));
  assert.equal(v.status, SKIP);
  assert.equal(v.tag, 'ENV');
});

test('unrun assertions are surfaced, never folded into a plain pass', () => {
  const v = readResultLine(run({ out: 'RESULT: 9 passed, 0 failed, 3 skipped' }));
  assert.equal(v.status, PASS_SKIPS);
  assert.equal(v.unrun, 3);
});

test('a scoreboard that asserted nothing is not a pass', () => {
  assert.equal(readResultLine(run({ out: 'RESULT: 0 passed, 0 failed' })).status, CRASH);
});

test('failures and post-report exits are never green', () => {
  assert.equal(readResultLine(run({ out: 'RESULT: 8 passed, 1 failed' })).status, FAIL);
  assert.equal(readResultLine(run({ code: 3, out: 'RESULT: 8 passed, 0 failed' })).status, CRASH);
  assert.equal(readResultLine(run({ timedOut: true })).status, FAIL);
  assert.equal(readResultLine(run({ out: 'RESULT: 8 passed, 0 failed' })).status, PASS);
});

// ── anchored, single-verdict parsing ──────────────────────────────────────
test('a scoreboard line with trailing garbage is not a scoreboard', () => {
  // Non-anchored matching accepted this and reported a clean pass.
  const v = readResultLine(run({ out: 'RESULT: 8 passed, 0 failed AND THEN EVERYTHING EXPLODED' }));
  assert.equal(v.status, CRASH);
});

test('two contradictory scoreboards are a crash, not "first one wins"', () => {
  const v = readResultLine(run({ out: 'RESULT: 8 passed, 0 failed\nRESULT: 3 passed, 5 failed' }));
  assert.equal(v.status, CRASH);
  assert.match(v.detail, /contradictory/i);
});

test('a duplicated scoreboard is a crash — which run is it reporting?', () => {
  const v = readResultLine(run({ out: 'RESULT: 8 passed, 0 failed\nRESULT: 8 passed, 0 failed' }));
  assert.equal(v.status, CRASH);
  assert.match(v.detail, /duplicated/i);
});

test('duplicate cockpit and floor verdicts are crashes too', () => {
  assert.equal(readCockpit(run({ out: 'RESULT: READY (0 failures)\nRESULT: NOT_READY (2 failures)' })).status, CRASH);
  assert.equal(readFloorVerdict(run({ out: 'VERDICT: PASS\nVERDICT: FAIL' })).status, CRASH);
});

test('a single well-formed line still parses, indentation and all', () => {
  assert.equal(readResultLine(run({ out: 'noise\n  RESULT: 8 passed, 0 failed  \nmore noise' })).status, PASS);
  assert.equal(readCockpit(run({ out: '  RESULT: READY (0 failures)' })).status, PASS);
  assert.equal(readFloorVerdict(run({ out: 'low contacts...\nVERDICT: PASS' })).status, PASS);
});

// ── engines range, not just the major version ─────────────────────────────
test('the engines floor is enforced, not just the major version', () => {
  const range = '>=24.14.0 <25 || >=26 <27';
  assert.equal(satisfiesEngines('24.0.0', range), false, '24.0.0 is below the 24.14.0 floor');
  assert.equal(satisfiesEngines('24.13.9', range), false);
  assert.equal(satisfiesEngines('24.14.0', range), true);
  assert.equal(satisfiesEngines('24.19.0', range), true);
  assert.equal(satisfiesEngines('25.6.1', range), false, 'Node 25 is excluded on purpose');
  assert.equal(satisfiesEngines('26.0.0', range), true);
  assert.equal(satisfiesEngines('27.0.0', range), false);
});

test('an unevaluable engines range reports unknown rather than guessing', () => {
  assert.equal(satisfiesEngines('24.19.0', '^24.14.0'), null);
});

// ── A3 pins the runtime it actually invoked ───────────────────────────────
// A full pass run under `mise exec node@24 --` still re-execed system Node 25
// through npm; the forced gate refused ("received 25.6.1") and A3 reported it
// as a product failure. A3 now invokes the binary directly and checks it.
test('only a parseable Node 24 counts as the calibrated allocation runtime', () => {
  assert.equal(isCalibratedAllocationRuntime('v24.19.0'), true);
  assert.equal(isCalibratedAllocationRuntime('24.19.0'), true, 'the v prefix is optional');
  assert.equal(isCalibratedAllocationRuntime('v25.6.1'), false, 'the npm re-resolution case');
  assert.equal(isCalibratedAllocationRuntime('v22.21.1'), false);
  for (const junk of ['', '   ', 'node', undefined, null]) {
    assert.equal(isCalibratedAllocationRuntime(junk), false, `unparseable input must not pass: ${junk}`);
  }
});

// ── C10 separates "never fetched" from "fetched and empty" ────────────────
test('traffic is inconclusive only when the flow fetch never landed', () => {
  // The observed full-pass shape: road graph answered, flow tiles still in
  // flight when the budget expired. Nothing was observed, so nothing is claimed.
  assert.equal(trafficFlowInconclusive({ mode: 'live', tilesFetched: 0, loading: true, count: 900 }), true);
  assert.equal(trafficFlowInconclusive({ mode: 'live', tilesFetched: 0, loadingLabel: 'SYNCING…' }), true,
    'a live loading label is the same evidence as the loading flag');
});

test('a traffic result that landed empty keeps failing', () => {
  // The Overpass-outage signature: tiles fetched, no road graph to colour.
  // Absorbing this into "inconclusive" would hide a real outage.
  assert.equal(trafficFlowInconclusive({ mode: 'live', tilesFetched: 4, loading: true, flowBuckets: {} }), false);
  assert.equal(trafficFlowInconclusive({ mode: 'live', tilesFetched: 0, loading: false }), false,
    'settled with no fetch attempted is a failure, not a slow measurement');
  assert.equal(trafficFlowInconclusive({ mode: 'live', tilesFetched: 0, loading: true, error: 'flow status unavailable' }), false,
    'an error is an answer — it must not be softened');
  assert.equal(trafficFlowInconclusive({ mode: 'sim', tilesFetched: 0, loading: true }), false,
    'the keyless branch has its own verdict');
  assert.equal(trafficFlowInconclusive(null), false);
});

// ── finding 6: contradictory cockpit output ───────────────────────────────
test('READY with a nonzero failure count is contradictory, not a pass', () => {
  const v = readCockpit(run({ out: 'RESULT: READY (3 failures)' }));
  assert.equal(v.status, CRASH);
  assert.match(v.detail, /contradictory/i);
});

test('cockpit READY passes only at zero failures', () => {
  assert.equal(readCockpit(run({ out: 'RESULT: READY (0 failures)' })).status, PASS);
  assert.equal(readCockpit(run({ out: 'RESULT: NOT_READY (2 failures)' })).status, FAIL);
});

// ── the floor oracle's preconditions ──────────────────────────────────────
test('an inconclusive floor verdict fails the oracle, it does not skip it', () => {
  const v = readFloorVerdict(run({ out: 'low contacts with plausible mesh readings: 0; buried (< -2m): 0\nVERDICT: INCONCLUSIVE' }));
  assert.equal(v.status, FAIL);
  assert.match(v.detail, /no candidates/i);
});

// ── key-state guard ───────────────────────────────────────────────────────
test('an unknown key state fails; it never becomes an owner-run skip', () => {
  const v = keyGuard('FIRMS', 'error');
  assert.equal(v.status, FAIL);
  assert.equal(keyGuard('FIRMS', null).status, SKIP);
  assert.equal(keyGuard('FIRMS', true), null, 'a known key state does not short-circuit');
  assert.equal(keyGuard('FIRMS', false), null);
});

// ── finding 5: known conditions explain, never excuse ─────────────────────
test('a known condition annotates a failure without changing it', () => {
  const conditions = [{ when: /no console errors[\s\S]{0,300}?503/, note: 'not key-tolerant' }];
  const annotated = applyKnownConditions(fail('8 passed, 1 failed'), conditions,
    '[FAIL] B4: no console errors during QA run — 503 Service Unavailable');
  assert.equal(annotated.status, FAIL, 'the verdict must stay a FAIL');
  assert.equal(annotated.note, 'not key-tolerant');
});

test('a known condition is evidence-gated and never touches a pass', () => {
  const conditions = [{ when: /503/, note: 'should not appear' }];
  assert.equal(applyKnownConditions(fail('x'), conditions, 'unrelated output').note, undefined);
  assert.equal(applyKnownConditions({ status: PASS, detail: 'x' }, conditions, '503 everywhere').note, undefined);
});

function fail(detail) { return { status: FAIL, detail }; }

// ── finding 4: attribution coverage fails closed ──────────────────────────
test('every layer the matrix can enable has an attribution expectation', () => {
  // C11 enables military-installations, which the old check filtered out.
  for (const id of ['flights', 'satellites', 'earthquakes', 'cctv', 'traffic',
    'ais-live-vessels', 'military-installations', 'local-datacenters', 'local-dams',
    'local-firms', 'telegeography-submarine-cables']) {
    const expectation = requiredCreditFor(id);
    assert.ok(expectation?.regex, `${id} needs a credit expectation`);
  }
});

test('an unmapped layer fails closed rather than passing unchecked', () => {
  assert.equal(requiredCreditFor('some-future-layer'), null);
});

test('credit exemptions are explicit and carry a reason', () => {
  for (const [id, reason] of Object.entries(CREDIT_EXEMPT_LAYERS)) {
    assert.equal(requiredCreditFor(id).exempt, reason);
    assert.ok(reason.length > 20, `${id}'s exemption needs a real reason`);
  }
});

test('expectation and exemption lists never overlap', () => {
  for (const id of Object.keys(CREDIT_EXEMPT_LAYERS)) {
    assert.equal(CREDIT_EXPECTATIONS[id], undefined, `${id} cannot be both expected and exempt`);
  }
});
