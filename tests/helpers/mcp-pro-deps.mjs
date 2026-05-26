// Shared dependency-injection fixtures for the Pro-path MCP test surface.
// Consumers: `tests/mcp.test.mjs` (U7 Pro-path), `tests/mcp-quota-concurrent.test.mjs`,
// `tests/mcp-tool-output-contracts.test.mjs`. Single source of truth for the
// bearer/user IDs, the in-memory Redis-pipeline stub, the dep-bundle factory,
// and the bearer-authenticated Request factory so the three suites cannot
// drift on what a Pro-context request looks like.
//
// Why one module: the same three helpers were inlined in mcp.test.mjs and
// would have been re-copied into each new file. Centralising avoids the
// `Keep in sync` comment pattern that the budget-check helper extraction
// already established as risk-prone.
//
// Identifiers are fixed at module scope so tests can pattern-match in dep
// overrides (e.g. a validateProMcpToken stub that returns null for any other
// token ID).
export const PRO_USER_ID = 'user_pro_xyz';
export const PRO_TOKEN_ID = 'k57mcptokenid';
export const PRO_BEARER = 'pro-bearer-uuid';
export const HMAC_SECRET = 'test-secret-mcp-internal-32-bytes-1234';
export const BASE_URL = 'https://worldmonitor.app/mcp';

/**
 * In-memory pipeline stub over INCR / DECR / EXPIRE. The counter is the
 * unit-under-test for daily-quota reservation semantics — read it after a
 * dispatch to assert the post-reservation floor.
 *
 * Options:
 *   initialCount  pre-seed the counter (simulates prior calls today)
 *   throwOnIncr   make every pipeline containing an INCR reject (probe path)
 *   decrFails     make every pipeline containing a DECR reject (rollback
 *                 failure path — overshoots the floor, never undershoots)
 */
export function makePipelineMock({ initialCount = 0, throwOnIncr = false, decrFails = false } = {}) {
  let counter = initialCount;
  const ops = [];
  const pipeline = async (commands) => {
    ops.push(commands);
    if (throwOnIncr && commands.some((c) => c[0] === 'INCR')) {
      throw new Error('redis pipeline failed');
    }
    if (decrFails && commands.some((c) => c[0] === 'DECR')) {
      throw new Error('redis decr failed');
    }
    const out = [];
    for (const cmd of commands) {
      if (cmd[0] === 'INCR') {
        counter += 1;
        out.push({ result: counter });
      } else if (cmd[0] === 'DECR') {
        counter = Math.max(0, counter - 1);
        out.push({ result: counter });
      } else if (cmd[0] === 'EXPIRE') {
        out.push({ result: 1 });
      } else {
        out.push({ result: null });
      }
    }
    return out;
  };
  return {
    pipeline,
    ops,
    get count() { return counter; },
  };
}

/**
 * Build the McpHandlerDeps bundle for a Pro user. Returns `{deps, pipe}` so
 * callers can inspect `pipe.count` / `pipe.ops` after dispatch.
 *
 * Pass `overrides.pipelineOpts` to shape the counter; pass any of the four
 * dep functions to replace the default happy-path behaviour (e.g. a stub
 * that returns null to simulate revocation).
 */
export function makeProDeps(overrides = {}) {
  const pipe = makePipelineMock(overrides.pipelineOpts ?? {});
  return {
    deps: {
      resolveBearerToContext: overrides.resolveBearerToContext ?? (async (token) => {
        if (token === PRO_BEARER) return { kind: 'pro', userId: PRO_USER_ID, mcpTokenId: PRO_TOKEN_ID };
        return null;
      }),
      validateProMcpToken: overrides.validateProMcpToken ?? (async (id) => {
        if (id === PRO_TOKEN_ID) return { userId: PRO_USER_ID };
        return null;
      }),
      getEntitlements: overrides.getEntitlements ?? (async () => ({
        planKey: 'pro',
        features: { tier: 1, mcpAccess: true },
        validUntil: Date.now() + 86_400_000,
      })),
      redisPipeline: pipe.pipeline,
    },
    pipe,
  };
}

/** Bearer-authenticated Request factory for the Pro path. */
export function proReq(method = 'POST', body = null, headers = {}) {
  return new Request(BASE_URL, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PRO_BEARER}`,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Build a tools/call JSON-RPC body. */
export function callBody(toolName, args = {}, id = 100) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args } };
}
