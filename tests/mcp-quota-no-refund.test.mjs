// Regression for GHSA-hcq5-jm84-2395 — MCP daily cost-cap bypass via
// quota slot refunded AFTER the tool already executed.
//
// dispatchToolsCall reserves a daily-quota slot (INCR) BEFORE running the
// tool, which is correct. The bug: it then DECR-refunded that slot on two
// attacker-reachable, POST-execution outcomes — (1) output over budget and
// (2) any tool-execution error — even though `_execute()` had already done
// the full upstream fetch/compute. Net quota charged for an already-executed,
// cost-incurring call was therefore zero, so a Pro token could drive real
// upstream cost far past the 50/day cap by always exceeding budget or erroring.
//
// The fix keeps the slot charged once `_execute()` has run: refunds happen
// only on PRE-execution failures (reservation/validation), which the reserve
// path already handles internally. These tests assert the counter STAYS
// consumed (`pipe.count === 1`) after each post-execution outcome — RED before
// the fix (the refund drove it back to 0), GREEN after.

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

/** URL-aware upstash GET stub (mirrors mcp.test.mjs `mockCacheKeys`). */
function stubCacheFetch(keyMap) {
  globalThis.fetch = async (url) => {
    const u = url.toString();
    for (const [k, v] of Object.entries(keyMap)) {
      if (u.includes(`/get/${encodeURIComponent(k)}`)) {
        return new Response(JSON.stringify({ result: v === null ? null : JSON.stringify(v) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    // Any other cache key → miss. `{result:null}` so all-null reads trip the
    // tool's `cache_all_null` guard in the error-path test.
    if (u.includes('/get/')) {
      return new Response(JSON.stringify({ result: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

describe('api/mcp.ts — Pro daily quota is NOT refunded after execution (GHSA-hcq5)', () => {
  let mcpHandler;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_test_key_quota_no_refund';
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
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

  it('over-budget dispatch keeps the reserved slot charged (counter stays at 1, not refunded to 0)', async () => {
    // 3000 quotes + limit:0 → response exceeds the 128 KB cache-tool budget
    // (same payload shape as mcp.test.mjs "budget: exceeding budget" case).
    const hugeQuotes = Array.from({ length: 3000 }, (_, i) => ({
      symbol: `SYM${String(i).padStart(4, '0')}`,
      price: i + 1,
      change: 0.01 * i,
      volume: 1_000_000 + i,
    }));
    stubCacheFetch({
      'market:stocks-bootstrap:v1': { quotes: hugeQuotes },
      'market:crypto:v1': { quotes: [] },
      'seed-meta:market:stocks': { fetchedAt: Date.now() - 60_000, recordCount: hugeQuotes.length },
    });

    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 0 } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data', { limit: 0 })), deps);

    assert.equal(res.status, 200, 'budget-exceeded is a successful dispatch (200 with an envelope)');
    const body = await res.json();
    const out = JSON.parse(body.result.content[0].text);
    assert.equal(out._budget_exceeded, true, 'sanity: response is the budget-exceeded envelope');
    assert.equal(
      pipe.count, 1,
      'the tool already executed (full upstream cost incurred), so the daily slot must stay charged — refunding it is the GHSA-hcq5 cost-cap bypass',
    );
  });

  it('errored dispatch keeps the reserved slot charged (counter stays at 1, not refunded to 0)', async () => {
    // All cache reads null → get_market_data throws `cache_all_null`, which
    // dispatchToolsCall's catch turns into a -32603 error AFTER _execute ran.
    stubCacheFetch({
      'market:stocks-bootstrap:v1': null,
      'market:crypto:v1': null,
    });

    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 0 } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);

    assert.equal(res.status, 200, 'JSON-RPC tool errors are returned as 200 + error body');
    const body = await res.json();
    assert.ok(body.error, `errored dispatch must carry a JSON-RPC error (got ${JSON.stringify(body)})`);
    assert.equal(
      pipe.count, 1,
      'the tool already executed before throwing, so the daily slot must stay charged — refunding it is the GHSA-hcq5 cost-cap bypass',
    );
  });
});
