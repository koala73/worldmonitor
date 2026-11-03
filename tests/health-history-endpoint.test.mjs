// Sprint follow-up — `/api/health?history=1` early-return path.
//
// The /api/health classifier writes `health:last-failure` and
// `health:failure-log` to Redis on every non-OK probe. Pre-2026-05-10 there
// was no read endpoint, so diagnosing UptimeRobot flips required direct
// Upstash credentials. This test exercises the new query-param path that
// surfaces those keys without re-running the (expensive) full freshness
// probe.
//
// We intentionally don't mock Redis — when UPSTASH_REDIS_REST_URL is unset
// (test environment), `redisPipeline` returns null and the handler falls
// through to a `{ lastFailure: null, failureLog: [] }` response. That's
// the correct contract: the endpoint never throws, even when Redis is
// unreachable.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { __testing__ } = await import('../api/health.js?failure-history-plan');

const NOW = Date.parse('2026-09-09T08:00:00.000Z');

function persistencePlan(overrides = {}) {
  const defaults = {
    verdict: {
      overall: 'HEALTHY',
      diagnosticOverall: 'WARNING',
      critCount: 0,
      realWarnCount: 1,
    },
    diagnostics: {
      problemKeys: ['diseaseOutbreaks:STALE_CONTENT(181min)'],
      sigKeys: ['diseaseOutbreaks:STALE_CONTENT'],
    },
    containedWarnCount: 1,
    previousSignature: '',
    now: NOW,
  };
  return __testing__.buildFailureLogPersistencePlan({
    ...defaults,
    ...overrides,
  });
}

describe('api/health diagnostic incident persistence', () => {
  it('writes a contained HEALTHY incident once while retaining diagnostic severity', () => {
    const plan = persistencePlan();

    assert.equal(plan.action, 'persist');
    assert.equal(plan.appendIncident, true);
    assert.deepEqual(plan.entry, {
      at: '2026-09-09T08:00:00.000Z',
      status: 'WARNING',
      availabilityStatus: 'HEALTHY',
      containedWarnCount: 1,
      critCount: 0,
      warnCount: 1,
      problems: ['diseaseOutbreaks:STALE_CONTENT(181min)'],
    });
    assert.deepEqual(plan.commands.map(([op, key]) => [op, key]), [
      ['SET', 'health:last-failure'],
      ['LPUSH', 'health:failure-log'],
      ['LTRIM', 'health:failure-log'],
      ['EXPIRE', 'health:failure-log'],
      ['SET', 'health:failure-log-sig'],
    ]);
  });

  it('refreshes active incident state without appending a duplicate', () => {
    const signature = 'WARNING|diseaseOutbreaks:STALE_CONTENT';
    const plan = persistencePlan({ previousSignature: signature });

    assert.equal(plan.appendIncident, false);
    assert.deepEqual(plan.commands[1], ['EXPIRE', 'health:failure-log', 86400 * 7]);
    assert.deepEqual(plan.commands.map(([op, key]) => [op, key]), [
      ['SET', 'health:last-failure'],
      ['EXPIRE', 'health:failure-log'],
      ['SET', 'health:failure-log-sig'],
    ]);
    assert.deepEqual(plan.commands[2], [
      'SET', 'health:failure-log-sig', signature, 'EX', 86400,
    ]);
  });

  it('appends transitions and keeps broad-impact WARNING as the public verdict', () => {
    const transitioned = persistencePlan({
      previousSignature: 'WARNING|diseaseOutbreaks:STALE_CONTENT',
      diagnostics: {
        problemKeys: ['portwatchPortActivity:COVERAGE_PARTIAL'],
        sigKeys: ['portwatchPortActivity:COVERAGE_PARTIAL'],
      },
    });
    assert.equal(transitioned.appendIncident, true);

    const broad = persistencePlan({
      verdict: {
        overall: 'WARNING',
        diagnosticOverall: 'WARNING',
        critCount: 0,
        realWarnCount: 10,
      },
      containedWarnCount: 10,
      diagnostics: {
        problemKeys: ['manySources:COVERAGE_PARTIAL'],
        sigKeys: ['manySources:COVERAGE_PARTIAL'],
      },
    });
    assert.equal(broad.entry.status, 'WARNING');
    assert.equal(Object.hasOwn(broad.entry, 'availabilityStatus'), false);
    assert.equal(Object.hasOwn(broad.entry, 'containedWarnCount'), false);
  });

  it('clears only after recovery, then appends the same incident when it recurs', () => {
    const recovered = persistencePlan({
      verdict: {
        overall: 'HEALTHY',
        diagnosticOverall: 'HEALTHY',
        critCount: 0,
        realWarnCount: 0,
      },
      containedWarnCount: 0,
      diagnostics: { problemKeys: [], sigKeys: [] },
      previousSignature: 'WARNING|diseaseOutbreaks:STALE_CONTENT',
    });
    assert.deepEqual(recovered, {
      action: 'clear',
      commands: [['DEL', 'health:failure-log-sig']],
    });

    assert.equal(persistencePlan({ previousSignature: '' }).appendIncident, true);
  });

  it('does not persist on-demand or actively pending diagnostics', () => {
    const pendingUntil = new Date(NOW + 60_000).toISOString();
    const { problemKeys, sigKeys } = __testing__.collectFailureLogProblems({
      imdCycloneMarine: { status: 'EMPTY_ON_DEMAND', records: 0, onDemand: true },
      temporalAnomalies: {
        status: 'STALE_CONTENT',
        records: 5,
        staleContentGraceUntil: pendingUntil,
      },
    }, NOW);

    assert.deepEqual(problemKeys, []);
    assert.deepEqual(sigKeys, []);
    assert.equal(persistencePlan({ diagnostics: { problemKeys, sigKeys } }).action, 'clear');
  });
});

describe('api/health ?history=1', () => {
  it('returns lastFailure + failureLog shape, never throws', async () => {
    // Force the no-Redis path so the test is hermetic. The endpoint must
    // gracefully degrade to empty arrays/null when Upstash is unreachable.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.WORLDMONITOR_VALID_KEYS = 'test-health-admin-key';

    const { default: handler } = await import('../api/health.js');
    const req = new Request('https://api.worldmonitor.app/api/health?history=1', {
      headers: { 'x-worldmonitor-key': 'test-health-admin-key' },
    });
    const res = await handler(req);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/json');

    const body = await res.json();
    assert.ok(Object.hasOwn(body, 'lastFailure'), 'body has lastFailure key');
    assert.ok(Object.hasOwn(body, 'failureLog'), 'body has failureLog key');
    assert.ok(Object.hasOwn(body, 'checkedAt'), 'body has checkedAt key');
    assert.equal(body.lastFailure, null, 'lastFailure null when Redis unreachable');
    assert.deepEqual(body.failureLog, [], 'failureLog empty when Redis unreachable');
    assert.match(body.checkedAt, /^\d{4}-\d{2}-\d{2}T/, 'checkedAt is ISO 8601');
  });

  it('does NOT trigger the early-return when ?history is absent or != "1"', async () => {
    // Without ?history=1 the handler MUST take the full classification
    // path. The exact non-history shape varies (REDIS_DOWN short-circuit
    // when Upstash is unconfigured, full {summary, ...} shape when
    // configured) — what we care about is that the history-specific
    // fields (lastFailure, failureLog) are absent.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const { default: handler } = await import('../api/health.js?second-import');
    const req = new Request('https://api.worldmonitor.app/api/health?compact=1');
    const res = await handler(req);

    // With Upstash unconfigured the non-history path short-circuits to
    // REDIS_DOWN, which returns 503 (the one hard-down state that surfaces a
    // non-200 HTTP code — see api/health.js REDIS_DOWN handler). The point of
    // this test is the shape (no history-specific keys), not the status code.
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(
      !Object.hasOwn(body, 'lastFailure'),
      'non-history path must not include lastFailure key',
    );
    assert.ok(
      !Object.hasOwn(body, 'failureLog'),
      'non-history path must not include failureLog key',
    );
  });

  it('treats history values other than exact "1" as non-matching (no false-trigger)', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const { default: handler } = await import('../api/health.js?third-import');
    for (const v of ['0', 'true', 'yes', '01']) {
      const req = new Request(`https://api.worldmonitor.app/api/health?history=${v}`);
      const res = await handler(req);
      const body = await res.json();
      assert.ok(
        !Object.hasOwn(body, 'lastFailure'),
        `history=${v} should NOT trigger early-return (history-specific keys leaked)`,
      );
    }
  });
});
