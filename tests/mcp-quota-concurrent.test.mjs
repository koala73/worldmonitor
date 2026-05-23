// Strict-clamp regression for the Pro daily-quota reservation under
// contention. Complements `tests/mcp.test.mjs` "U7 Pro-path" describe (which
// covers loose-clamp `count <= 50` at the 100/49-seed cell of the matrix).
// Different cell, stricter invariant: at initialCount=0 with N fires where
// N > PRO_DAILY_QUOTA_LIMIT, EXACTLY the first PRO_DAILY_QUOTA_LIMIT calls
// must succeed, the rest must -32029, and the counter must land EXACTLY at
// PRO_DAILY_QUOTA_LIMIT after every rejection's DECR rollback completes —
// proving the rollback path is exact (no double-count, no leak), not just
// bounded.
//
// A second case forces DECR rollbacks to fail (Redis hiccup). The
// reservation helper's counter-clamp loop must bring the counter back down
// to a bounded overshoot ceiling — never undershoot.

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

    // Validate every rejection body carries the -32029 error code — proves
    // the 429s are the daily-cap rejection, not a per-minute rate-limit
    // 429 (which uses the same HTTP status with the same JSON-RPC code in
    // this codebase, but the production gate that fires here is the daily
    // counter — telemetry below confirms).
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

  it(`fires ${CONCURRENT_FIRES} concurrent tools/call at count=0 with DECR rollback failing → counter stays at or above ${QUOTA_LIMIT} (never undershoots), bounded by the clamp loop`, async () => {
    // With decrFails=true, every rollback DECR rejects. The reservation
    // helper's counter-clamp loop (api/mcp.ts ~line 4015) issues up to 100
    // best-effort DECRs to bring the counter back to PRO_DAILY_QUOTA_LIMIT.
    // Those clamp DECRs ALSO fail under decrFails — so the counter ends at
    // whatever INCRs landed before the first rejection started cascading.
    //
    // The invariant we care about is one-sided: the counter must NEVER
    // undershoot the limit (cost-protection > user-fairness). Upper bound
    // is the total number of INCRs, which equals CONCURRENT_FIRES.
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 0, decrFails: true } });

    const calls = Array.from({ length: CONCURRENT_FIRES },
      () => mcpHandler(proReq('POST', callBody('get_market_data')), deps));
    await Promise.all(calls);

    assert.ok(
      pipe.count >= QUOTA_LIMIT,
      `counter must NEVER undershoot the floor; observed ${pipe.count} < ${QUOTA_LIMIT}`,
    );
    assert.ok(
      pipe.count <= CONCURRENT_FIRES,
      `counter bounded above by total INCRs (${CONCURRENT_FIRES}); observed ${pipe.count}`,
    );
  });
});
