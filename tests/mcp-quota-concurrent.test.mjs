// Strict-floor regression for the Pro daily-quota reservation, covering
// two cells the existing `mcp.test.mjs` "U7 Pro-path" suite does not.
//
// Case 1 — strict floor under contention. Complements the existing
// 100-fire-at-count=49 test (which only asserts the loose `count <= 50`
// bound). At initialCount=0 with N fires where N > PRO_DAILY_QUOTA_LIMIT,
// EXACTLY the first PRO_DAILY_QUOTA_LIMIT calls succeed, the rest -32029,
// and the counter lands EXACTLY at PRO_DAILY_QUOTA_LIMIT after every
// rejection's DECR rollback completes — proving the rollback path is
// exact (no double-count, no leak), not just bounded.
//
// Case 2 — F4 overshoot recovery. With the counter pre-seeded ABOVE the
// cap (a Redis-hiccup scenario where a prior burst's DECR rollbacks
// failed and left the counter stuck high), a single over-cap call must
// drive the counter back DOWN to the cap via the F4 INCR-DECR probe +
// clamp loop in `reserveQuota`. Without the clamp the user would be
// 429-locked until the 48 h key TTL. Single-call by design: the F4
// clamp is sized per-rejection (`Math.min(overshoot, 100)` DECRs), so
// stacking concurrent rejections each issue their own full clamp pass
// and over-correct the counter below the cap. That stacked-clamp
// behaviour is a separate concern and isn't asserted here.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  HMAC_SECRET,
  makeProDeps,
  proReq,
  callBody,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

// `PRO_DAILY_QUOTA_LIMIT` is a hardcoded constant in server/_shared/
// pro-mcp-token.ts (NOT env-configurable). Mirroring the literal here keeps
// the test self-contained — if the production limit ever changes, this
// test will reflect the divergence by name (success count off-by-N) rather
// than passing silently against a stale assumption.
const QUOTA_LIMIT = 50;
const CONCURRENT_FIRES = 80;
const EXPECTED_REJECTIONS = CONCURRENT_FIRES - QUOTA_LIMIT;

describe('api/mcp.ts — concurrent quota reservation (strict clamp)', () => {
  let mcpHandler;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_test_key_quota_concurrent';
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    // Telemetry is default-on. Off here so 80 concurrent tools/call don't
    // flood test stdout with JSON lines (matches mcp.test.mjs).
    process.env.MCP_TELEMETRY = 'false';
    // Stub fetch so cache tools return a non-null payload — the F6
    // `cache_all_null` guard would otherwise trip on default-args calls
    // and throw before the quota path can be assessed.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ result: JSON.stringify({ ok: 1 }) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it(`fires ${CONCURRENT_FIRES} concurrent tools/call at count=0 → exactly ${QUOTA_LIMIT} succeed, exactly ${EXPECTED_REJECTIONS} reject with -32029, counter ends at exactly ${QUOTA_LIMIT}`, async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 0 } });

    const calls = Array.from({ length: CONCURRENT_FIRES },
      () => mcpHandler(proReq('POST', callBody('get_market_data')), deps));
    const responses = await Promise.all(calls);

    // Partition by HTTP status. 200 ⇒ tools/call success (counter consumed);
    // 429 ⇒ -32029 daily-cap rejection (counter NOT consumed after rollback).
    const ok = responses.filter((r) => r.status === 200);
    const rejected = responses.filter((r) => r.status === 429);
    const other = responses.filter((r) => r.status !== 200 && r.status !== 429);

    // Validate every rejection body carries the -32029 error code, AND that
    // the post-test `pipe.count === QUOTA_LIMIT` assertion below holds —
    // together these prove the daily-counter path fired (not the per-minute
    // rate-limiter, which uses the same HTTP 429 + JSON-RPC -32029 code but
    // touches a different Redis key and would leave the daily-counter mock
    // at its initial 0).
    const rejectedBodies = await Promise.all(rejected.map((r) => r.json()));
    const wrongCode = rejectedBodies.filter((b) => b?.error?.code !== -32029);

    assert.equal(
      other.length, 0,
      `expected only 200/429 statuses, saw ${other.length} other (statuses=${other.map((r) => r.status).join(',')})`,
    );
    assert.equal(
      ok.length, QUOTA_LIMIT,
      `expected ${QUOTA_LIMIT} successes, got ${ok.length} (rejected=${rejected.length})`,
    );
    assert.equal(
      rejected.length, EXPECTED_REJECTIONS,
      `expected ${EXPECTED_REJECTIONS} rejections, got ${rejected.length} (succeeded=${ok.length})`,
    );
    assert.equal(
      wrongCode.length, 0,
      `every rejection must carry JSON-RPC code -32029; ${wrongCode.length} rejections had a different code`,
    );
    assert.equal(
      pipe.count, QUOTA_LIMIT,
      `counter must land at exactly ${QUOTA_LIMIT} after all rollbacks; observed ${pipe.count}`,
    );
  });

  // F4 overshoot recovery — single call. Pre-seed the counter ABOVE the
  // cap to simulate the scenario the clamp loop is designed for: a prior
  // burst's DECR rollbacks failed and left the counter stuck high.
  // One over-cap tools/call must trigger:
  //   (1) INCR → newCount = overshoot+1 (above cap+1, so probe runs)
  //   (2) rollback DECR → counter back to seed
  //   (3) probe INCR+DECR → reads postRollbackCount = seed
  //   (4) clamp `seed - cap` DECRs → counter ends at cap exactly
  // The discriminating signal is `pipe.count === QUOTA_LIMIT`. Removing
  // the clamp loop leaves the counter at the seed value (e.g. 80) and
  // fails this assertion by exact diff.
  const PRESEED_OVERSHOOT = 30;

  it(`with counter pre-seeded at ${QUOTA_LIMIT + PRESEED_OVERSHOOT} (above cap), a single tools/call drives the F4 clamp; counter converges to exactly ${QUOTA_LIMIT}`, async () => {
    const { deps, pipe } = makeProDeps({
      pipelineOpts: { initialCount: QUOTA_LIMIT + PRESEED_OVERSHOOT },
    });

    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);

    assert.equal(
      res.status, 429,
      `call must reject when counter starts above cap; got status ${res.status}`,
    );
    assert.equal(
      pipe.count, QUOTA_LIMIT,
      `F4 clamp must drive counter from ${QUOTA_LIMIT + PRESEED_OVERSHOOT} down to exactly ${QUOTA_LIMIT}; observed ${pipe.count}`,
    );
  });
});
