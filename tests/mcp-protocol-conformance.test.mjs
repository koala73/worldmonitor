// End-to-end MCP session lifecycle (in-process). Walks a single thread:
//
//   unauth tools/call (gated 401) → unauth initialize + tools/list (public 200)
//   → initialize → tools/list → describe_tool (quota-exempt)
//   → tools/call (pre-seeded near cap, success) → tools/call (cap exceeded)
//   → re-initialize → tools/call (still cap exceeded)
//
// Asserts the JSON-RPC envelope at each hop, the `Mcp-Session-Id` response
// header on `initialize`, the auth split (discovery is public; tools/call is
// gated), and that the Pro daily quota counter is the load-bearing reservoir —
// neither `describe_tool` nor re-`initialize` mutates it.
//
// Why one `it()` for the whole sequence: the value here is the LIFECYCLE
// thread, not any single envelope check (those are covered per-method in
// `mcp.test.mjs`). Per-step assertions name the step number so a failure
// points at the lifecycle position, not just the assertion.
//
// Scope is explicitly in-process. Transport-layer concerns (real HTTP
// listener, SSE upgrade, `Last-Event-ID` replay, session-ID round-trip
// across reconnect) belong to a separate suite.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  BASE_URL,
  HMAC_SECRET,
  makeProDeps,
  proReq,
  callBody,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

// PRO_DAILY_QUOTA_LIMIT is hardcoded in server/_shared/pro-mcp-token.ts
// (NOT env-configurable). Mirroring the literal here keeps the test
// self-contained; if the production cap ever changes, the step labels and
// counter-floor assertions below will diverge by exact diff rather than
// pass silently.
const QUOTA_LIMIT = 50;
// Pre-seed value for steps e-h. One success ramps the counter to the cap;
// the next call must trip the daily-cap rejection. Sized to PROVE the
// lifecycle through the boundary, not to re-prove the cap math (covered
// per-call in mcp-quota-concurrent.test.mjs).
const PRESEED_BELOW_CAP = QUOTA_LIMIT - 1;

describe('api/mcp.ts — protocol conformance lifecycle (in-process)', () => {
  let mcpHandler;

  beforeEach(async () => {
    // UPSTASH env vars are SET (not deleted as in `mcp.test.mjs`'s default
    // beforeEach) because `readJsonFromUpstash` in api/_upstash-json.js short-
    // circuits to `null` when they're missing — that would trip the F6
    // `cache_all_null` guard on every `get_market_data` call and surface as
    // -32603 before the quota path under test could fire. Setting them keeps
    // the cache-read path live so the fetch stub below can answer the GETs.
    //
    // Side effect of setting them: `getMcpProMinRatelimit()` constructs a real
    // `Ratelimit` instance which calls `globalThis.fetch` with an EVALSHA
    // pipeline shape that the cache-tuned stub does NOT satisfy. The thrown
    // response is swallowed by `applyPerMinuteLimit`'s
    // `catch { /* graceful degradation */ }`, so the 60/min gate is a no-op
    // on every authenticated step here. That's INTENTIONAL: this suite's
    // scope is the daily-quota lifecycle; the per-minute path is covered
    // separately by `mcp.test.mjs::'returns JSON-RPC -32029 when rate
    // limited'` and `mcp-quota-concurrent.test.mjs`. Same posture as both
    // sister suites — documenting it here so it doesn't read like a latent
    // bypass to a future reader.
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    // Telemetry default-on in prod; off here so the JSON line per
    // tools/call doesn't pollute test stdout (matches the convention in
    // mcp.test.mjs / mcp-quota-concurrent.test.mjs).
    process.env.MCP_TELEMETRY = 'false';

    // Cache reads on the Pro path go through real `executeTool` → `fetch`.
    // Returning a non-null `{ok: 1}` payload for any GET keeps the F6
    // `cache_all_null` guard from tripping on default-args `get_market_data`.
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

  it('walks initialize → tools/list → describe_tool → tools/call × N → re-init → still-locked-out', async () => {
    // Step 1 — the auth wall is a DATA/quota method (tools/call). An
    // unauthenticated tools/call is gated BEFORE the session touches any
    // backend. Asserts the 401 envelope (HTTP status, WWW-Authenticate Bearer
    // realm, JSON-RPC code -32001) so a regression that drops the gate is
    // caught at the very first hop.
    //
    // Deps bundle is intentionally a thrower-stub: `resolveAuthContext` must
    // return 401 BEFORE consulting any dep — no Bearer header means no
    // `resolveBearerToContext` call, no API key means no validation, and 401
    // returns before `applyPerMinuteLimit` runs. A throwing stub turns "the
    // gate leaks and lets the request reach the deps" into a loud failure
    // (the throw escapes the handler as a -32603, which would fail the 401
    // assertion below). Using `makeProDeps().deps` here would mask that —
    // the stub would silently answer instead of signaling the breach.
    const unreachable = (name) => async () => {
      throw new Error(`unauth path must not touch deps.${name}`);
    };
    const step1Deps = {
      resolveBearerToContext: unreachable('resolveBearerToContext'),
      validateProMcpToken: unreachable('validateProMcpToken'),
      getEntitlements: unreachable('getEntitlements'),
      redisPipeline: unreachable('redisPipeline'),
    };
    const unauthReq = (body) => new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const step1Res = await mcpHandler(
      unauthReq({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_market_data', arguments: {} },
      }),
      step1Deps,
    );
    assert.equal(step1Res.status, 401, 'step 1 (unauth tools/call): expected HTTP 401');
    assert.ok(
      (step1Res.headers.get('www-authenticate') ?? '').includes('Bearer realm="worldmonitor"'),
      'step 1 (unauth tools/call): WWW-Authenticate Bearer realm missing',
    );
    const step1Body = await step1Res.json();
    assert.equal(step1Body.error?.code, -32001, 'step 1 (unauth tools/call): JSON-RPC code must be -32001');

    // Step 1b — discovery is PUBLIC. Unauthenticated initialize + tools/list
    // succeed WITHOUT touching any dep (thrower-stub bundle stays untouched),
    // proving the discovery surface bypasses the auth wall cleanly.
    const step1bInit = await mcpHandler(
      unauthReq({
        jsonrpc: '2.0', id: '1b', method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '1.0' } },
      }),
      step1Deps,
    );
    assert.equal(step1bInit.status, 200, 'step 1b (unauth initialize): discovery must be public');
    assert.ok(step1bInit.headers.get('mcp-session-id'), 'step 1b: anonymous initialize must still issue a session id');

    const step1bList = await mcpHandler(
      unauthReq({ jsonrpc: '2.0', id: '1c', method: 'tools/list', params: {} }),
      step1Deps,
    );
    assert.equal(step1bList.status, 200, 'step 1b (unauth tools/list): discovery must be public');
    const step1bListBody = await step1bList.json();
    assert.ok(Array.isArray(step1bListBody.result?.tools) && step1bListBody.result.tools.length >= 3,
      'step 1b: anonymous tools/list must expose the tool catalog');

    // Steps 2-4 share one Pro deps bundle with the counter at 0. `describe_tool`
    // is the metadata-exempt tool — using the same deps proves the counter
    // truly didn't move (vs. it moving but in a separately-seeded bundle).
    const { deps: depsFresh, pipe: pipeFresh } = makeProDeps({ pipelineOpts: { initialCount: 0 } });

    // Step 2 — initialize on a Pro Bearer succeeds, returns the negotiated
    // protocol version, advertises capabilities, and emits the session ID
    // as a response header. Capture the ID for the re-init compare below.
    const step2Res = await mcpHandler(
      proReq('POST', {
        jsonrpc: '2.0', id: 2, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '1.0' } },
      }),
      depsFresh,
    );
    assert.equal(step2Res.status, 200, 'step 2 (Pro initialize): expected HTTP 200');
    const sessionId1 = step2Res.headers.get('mcp-session-id');
    assert.ok(sessionId1, 'step 2 (Pro initialize): Mcp-Session-Id header missing');
    assert.ok(sessionId1.length > 0, 'step 2 (Pro initialize): Mcp-Session-Id header is empty string');
    const step2Body = await step2Res.json();
    assert.equal(step2Body.jsonrpc, '2.0', 'step 2: envelope jsonrpc field must be "2.0"');
    assert.equal(step2Body.id, 2, 'step 2: envelope id must echo the request id');
    assert.equal(step2Body.result?.protocolVersion, '2025-03-26', 'step 2: protocolVersion must echo the client request when supported');
    assert.equal(step2Body.result?.serverInfo?.name, 'worldmonitor', 'step 2: serverInfo.name must be "worldmonitor"');
    assert.ok(step2Body.result?.capabilities, 'step 2: capabilities object must be present');
    assert.equal(
      pipeFresh.count, 0,
      `step 2: initialize must NOT touch the daily counter; observed ${pipeFresh.count}`,
    );

    // Step 3 — tools/list returns the registry. Quota-untouched (read-only
    // metadata). Every entry MUST carry `outputSchema` per the 2025-06-18
    // spec field, which is what the per-tool contract suite leans on.
    const step3Res = await mcpHandler(
      proReq('POST', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      depsFresh,
    );
    assert.equal(step3Res.status, 200, 'step 3 (tools/list): expected HTTP 200');
    const step3Body = await step3Res.json();
    assert.ok(Array.isArray(step3Body.result?.tools), 'step 3: result.tools must be an array');
    assert.ok(
      step3Body.result.tools.length >= 39,
      `step 3: expected >= 40 tools, got ${step3Body.result.tools.length}`,
    );
    for (const tool of step3Body.result.tools) {
      assert.ok(
        tool.outputSchema,
        `step 3: tool ${tool.name} missing outputSchema (2025-06-18 spec field)`,
      );
    }
    assert.equal(
      pipeFresh.count, 0,
      `step 3: tools/list must NOT touch the daily counter; observed ${pipeFresh.count}`,
    );

    // Step 4 — `describe_tool` is the only quota-exempt tool today (the
    // explicit-by-name check in dispatchToolsCall). A successful call MUST
    // leave the counter at 0. A future tool added to the exempt list would
    // shift this assertion — hardcoding `describe_tool` keeps the signal
    // narrow on a real regression (exemption removed) rather than broad
    // (a new exempt tool changed accounting).
    const step4Res = await mcpHandler(
      proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' }, 4)),
      depsFresh,
    );
    assert.equal(step4Res.status, 200, 'step 4 (describe_tool): expected HTTP 200');
    const step4Body = await step4Res.json();
    assert.ok(
      step4Body.result?.content?.[0]?.text,
      'step 4 (describe_tool): tools/call response missing content[0].text',
    );
    assert.equal(
      pipeFresh.count, 0,
      `step 4 (describe_tool): metadata tool must be quota-exempt; observed counter=${pipeFresh.count}`,
    );

    // Steps 5-8 switch to a SECOND deps bundle pre-seeded at LIMIT-1 so a
    // single happy tools/call ramps the counter to the cap and the next
    // call must trip the daily-cap rejection. Same Pro user, same handler;
    // ONLY the in-memory pipeline counter changes. Carrying the same
    // `depsCapped` through steps 5 → 8 is what proves re-init does NOT
    // reset the counter (sabotage 3).
    const { deps: depsCapped, pipe: pipeCapped } = makeProDeps({
      pipelineOpts: { initialCount: PRESEED_BELOW_CAP },
    });

    // Step 5 — at counter=LIMIT-1, the next INCR lands at the cap and the
    // reservation succeeds. Counter sits AT the cap after this call.
    const step5Res = await mcpHandler(
      proReq('POST', callBody('get_market_data', {}, 5)),
      depsCapped,
    );
    assert.equal(step5Res.status, 200, 'step 5 (tools/call at cap-1): expected HTTP 200');
    const step5Body = await step5Res.json();
    assert.ok(
      step5Body.result?.content?.[0]?.text,
      `step 5 (tools/call at cap-1): response missing content[0].text (error=${JSON.stringify(step5Body.error)})`,
    );
    assert.equal(
      pipeCapped.count, QUOTA_LIMIT,
      `step 5: counter must land at exactly ${QUOTA_LIMIT} after one successful reservation; observed ${pipeCapped.count}`,
    );

    // Step 6 — at counter=LIMIT, the next INCR overshoots → reservation
    // rejects with -32029 → DECR rollback → counter snaps back to LIMIT.
    // Asserts HTTP 429, the JSON-RPC error code, the Retry-After header
    // (per the cap-exceeded branch in dispatchToolsCall), AND the
    // counter-unchanged invariant.
    const step6Res = await mcpHandler(
      proReq('POST', callBody('get_market_data', {}, 6)),
      depsCapped,
    );
    assert.equal(step6Res.status, 429, `step 6 (tools/call at cap): expected HTTP 429, got ${step6Res.status}`);
    assert.ok(
      step6Res.headers.get('retry-after'),
      'step 6 (tools/call at cap): Retry-After header must be present on cap-exceeded',
    );
    const step6Body = await step6Res.json();
    assert.equal(
      step6Body.error?.code, -32029,
      `step 6 (tools/call at cap): expected JSON-RPC -32029, got ${step6Body.error?.code}`,
    );
    assert.equal(
      pipeCapped.count, QUOTA_LIMIT,
      `step 6: counter must remain at ${QUOTA_LIMIT} after rollback; observed ${pipeCapped.count}`,
    );

    // Step 7 — re-initialize. A fresh initialize on the SAME Pro user must
    // succeed (the lifecycle method is stateless w.r.t. quota) AND must
    // return a NEW session ID. The session-ID inequality is the wire-level
    // signal that the server actually issued a fresh session, not that it
    // silently coalesced into the existing one. Counter must still hold at
    // the cap — re-initialize is NOT a quota-reset mechanism.
    const step7Res = await mcpHandler(
      proReq('POST', {
        jsonrpc: '2.0', id: 7, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '1.0' } },
      }),
      depsCapped,
    );
    assert.equal(step7Res.status, 200, 'step 7 (re-initialize): expected HTTP 200');
    const sessionId2 = step7Res.headers.get('mcp-session-id');
    assert.ok(sessionId2, 'step 7 (re-initialize): Mcp-Session-Id header missing on re-init');
    assert.notEqual(
      sessionId2, sessionId1,
      'step 7 (re-initialize): expected a NEW Mcp-Session-Id distinct from the original session',
    );
    assert.equal(
      pipeCapped.count, QUOTA_LIMIT,
      `step 7: re-initialize must NOT mutate the daily counter; expected ${QUOTA_LIMIT}, observed ${pipeCapped.count}`,
    );

    // Step 8 — post re-init, the Pro user is STILL locked out of
    // tools/call until UTC midnight. This is the discriminating signal for
    // sabotage 3 (a regression that DECRs the counter on initialize would
    // free one slot, flipping this 429 into a 200).
    const step8Res = await mcpHandler(
      proReq('POST', callBody('get_market_data', {}, 8)),
      depsCapped,
    );
    assert.equal(
      step8Res.status, 429,
      `step 8 (tools/call after re-init): re-init must NOT reset quota; expected HTTP 429, got ${step8Res.status}`,
    );
    const step8Body = await step8Res.json();
    assert.equal(
      step8Body.error?.code, -32029,
      `step 8 (tools/call after re-init): expected JSON-RPC -32029, got ${step8Body.error?.code}`,
    );
    assert.equal(
      pipeCapped.count, QUOTA_LIMIT,
      `step 8: counter must still be ${QUOTA_LIMIT} after re-init + rejected call; observed ${pipeCapped.count}`,
    );
  });
});
