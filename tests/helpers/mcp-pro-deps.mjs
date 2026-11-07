import { PANEL_REQUEST_READ_SCRIPT, PANEL_REQUEST_RESERVE_SCRIPT } from '../../shared/panel-request-scripts.mjs';

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
// The transport at BASE_URL challenges an unauthenticated `initialize`. A full
// anonymous handshake is served on the machine-discovery alias (same handler).
export const ANON_DISCOVERY_URL = 'https://worldmonitor.app/.well-known/mcp';

/**
 * In-memory pipeline stub over Pro INCR / DECR / EXPIRE, the Pro daily
 * quota's atomic two-key EVAL, and the free-account allowance's atomic
 * three-key EVAL. The counter is the unit-under-test for reservation
 * semantics — read it after dispatch to assert the stored floor.
 *
 * Options:
 *   initialCount      pre-seed the counter (simulates prior calls today)
 *   initialLimitFloor max successful limit already charged today, or -1
 *                     after an unlimited reserve; omit for none
 *   throwOnIncr       make every pipeline containing an INCR, or the 2-key
 *                     reserveQuota EVAL, reject (Redis-unavailable path)
 *   throwOnEval       make every pipeline containing an EVAL reject (atomic free
 *                     allowance path)
 *   decrFails         make every pipeline containing a DECR reject (rollback
 *                     failure path — overshoots the floor, never undershoots)
 */
export function makePipelineMock({
  initialCount = 0,
  initialLimitFloor = null,
  throwOnIncr = false,
  throwOnEval = false,
  decrFails = false,
} = {}) {
  const store = new Map();
  let counter = initialCount;
  let limitFloor = initialLimitFloor;
  let freeRequestCount = 0;
  let freeLastActivity = null;
  let freeLastActivityExpiresAt = null;
  const ops = [];
  const pipeline = async (commands) => {
    ops.push(commands);
    if (throwOnIncr && commands.some((c) => (
      c[0] === 'INCR' || (c[0] === 'EVAL' && Number(c[2]) === 2)
    ))) {
      throw new Error('redis pipeline failed');
    }
    if (throwOnEval && commands.some((c) => c[0] === 'EVAL')) {
      throw new Error('redis eval failed');
    }
    if (decrFails && commands.some((c) => c[0] === 'DECR')) {
      throw new Error('redis decr failed');
    }
    const out = [];
    for (const cmd of commands) {
      if (cmd[0] === 'EVAL' && cmd[1] === PANEL_REQUEST_RESERVE_SCRIPT) {
        const marker = cmd[5];
        if (store.has(marker)) { out.push({ result: [2, counter, Number(store.get(marker))] }); continue; }
        if (store.has(cmd[6])) { out.push({ result: [3, counter, Number(store.get(cmd[6]))] }); continue; }
        const limit = cmd[7] === '' ? null : Number(cmd[7]);
        if (limit !== null && counter + 1 > limit) { out.push({ result: [0, counter] }); continue; }
        counter++;
        if (limit === null) limitFloor = -1;
        else if (limitFloor !== -1) limitFloor = Math.max(limitFloor ?? 0, limit);
        store.set(marker, String(cmd[12]));
        out.push({ result: [1, counter, Number(cmd[12])] });
      } else if (cmd[0] === 'EVAL' && cmd[1] === PANEL_REQUEST_READ_SCRIPT) {
        const used = Number(store.get(cmd[4]) ?? 0);
        if (store.get(cmd[3]) !== String(cmd[7])) out.push({ result: [-1, 0] });
        else if (used >= Number(cmd[5])) out.push({ result: [0, used] });
        else { store.set(cmd[4], used + 1); out.push({ result: [1, used + 1] }); }
      } else if (cmd[0] === 'GET') {
        out.push({ result: store.get(cmd[1]) ?? null });
      } else if (cmd[0] === 'SET') {
        store.set(cmd[1], cmd[2]); out.push({ result: 'OK' });
      } else if (cmd[0] === 'EVAL' && Number(cmd[2]) === 3 && cmd.length >= 10) {
        const nowMs = Number(cmd[6]);
        const idleGapMs = Number(cmd[7]);
        const callsLimit = Number(cmd[8]);
        const requestsLimit = Number(cmd[9]);
        const opensWindow = freeLastActivity === null || nowMs - freeLastActivity >= idleGapMs;
        if (counter >= callsLimit || opensWindow && freeRequestCount >= requestsLimit) {
          out.push({ result: [0] });
          continue;
        }
        counter += 1;
        if (opensWindow) freeRequestCount += 1;
        freeLastActivity = freeLastActivity === null ? nowMs : Math.max(nowMs, freeLastActivity);
        freeLastActivityExpiresAt = nowMs + idleGapMs;
        out.push({ result: [1] });
      } else if (cmd[0] === 'EVAL' && Number(cmd[2]) === 3) {
        out.push({
          result: [
            counter === 0 ? null : String(counter),
            freeRequestCount === 0 ? null : String(freeRequestCount),
            freeLastActivityExpiresAt === null
              ? -2
              : Math.max(0, freeLastActivityExpiresAt - Date.now()),
          ],
        });
      } else if (cmd[0] === 'EVAL' && Number(cmd[2]) === 2) {
        // reserveQuota: INCR + owner-only reject/clamp in one turn, matching
        // api/mcp/quota.ts RESERVE_QUOTA_SCRIPT. ARGV[1] empty = unlimited.
        // limitFloor (-1 = unlimited seen) is the clamp floor.
        const limitRaw = cmd[5];
        const unlimited = limitRaw === '' || limitRaw === undefined || limitRaw === null;
        const limit = unlimited ? null : Number(limitRaw);
        // ARGV[3] is the per-tool weight. Mirror the script's INCRBY: charging 1
        // here regardless made a weight-2 call look like it had reserved less
        // than it charged, which reserveQuota reads as a Redis fault (503).
        const weightRaw = Number(cmd[7]);
        const weight = Number.isFinite(weightRaw) && weightRaw >= 1 ? weightRaw : 1;
        counter += weight;
        const reserved = counter;
        if (unlimited) {
          limitFloor = -1;
          out.push({ result: [1, reserved] });
        } else if (!Number.isFinite(limit) || limit < 0) {
          counter = Math.max(0, counter - weight);
          out.push({ result: [-1, 0] });
        } else if (reserved <= limit) {
          if (limitFloor !== -1 && (limitFloor === null || limit > limitFloor)) {
            limitFloor = limit;
          }
          out.push({ result: [1, reserved] });
        } else {
          counter = Math.max(0, counter - weight);
          if (limitFloor !== -1) {
            const clampTo = limitFloor !== null && limitFloor > limit ? limitFloor : limit;
            if (counter > clampTo) counter = clampTo;
          }
          out.push({ result: [0, counter] });
        }
      } else if (cmd[0] === 'INCR') {
        counter += 1;
        out.push({ result: counter });
      } else if (cmd[0] === 'DECR') {
        counter = Math.max(0, counter - 1);
        out.push({ result: counter });
      } else if (cmd[0] === 'DECRBY') {
        counter = Math.max(0, counter - Number(cmd[2] ?? 1));
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
    store,
    get count() { return counter; },
    get limitFloor() { return limitFloor; },
  };
}

/**
 * Build the McpHandlerDeps bundle for a Pro user. Returns `{deps, pipe}` so
 * callers can inspect `pipe.count` / `pipe.ops` after dispatch.
 *
 * Pass `overrides.pipelineOpts` to shape the counter; pass any dependency
 * function to replace the default happy-path behaviour (e.g. a stub
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
      // #4859 user-key path. Default rejects every key so pre-existing suites
      // keep their exact 401 behaviour; user-key tests override with a
      // fixture-matching resolver.
      validateUserApiKey: overrides.validateUserApiKey ?? (async () => null),
      // Production fails closed through Redis before unattributed user-key
      // validation. Unit tests inject the guard result explicitly so their
      // auth behavior is deterministic and never contacts Redis.
      guardUserApiKeyValidation: overrides.guardUserApiKeyValidation ?? (async () => null),
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
