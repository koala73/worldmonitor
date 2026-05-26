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

describe('api/health ?history=1', () => {
  it('returns lastFailure + failureLog shape, never throws', async () => {
    // Force the no-Redis path so the test is hermetic. The endpoint must
    // gracefully degrade to empty arrays/null when Upstash is unreachable.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const { default: handler } = await import('../api/health.js');
    const req = new Request('https://api.worldmonitor.app/api/health?history=1');
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

    assert.equal(res.status, 200);
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
