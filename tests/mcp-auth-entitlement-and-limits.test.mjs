// #5379 U3 — direct unit coverage for the three untested surfaces in
// `api/mcp/auth.ts`:
//
//   Gap 4  `checkMcpEntitlementGate` — the four rejection predicates
//          (`!ent`, `tier < 1`, `!mcpAccess`, `validUntil < Date.now()`) were
//          only ever exercised by a SINGLE fixture that violated all of them at
//          once, so deleting any one predicate left the suite green. Every case
//          below violates EXACTLY ONE predicate and satisfies the rest, so each
//          predicate is independently observable.
//   Gap 9  `applyPerMinuteLimit` — both branches (env_key vs pro/user_key),
//          their rate-limit KEYS, the -32029 shape, the telemetry emit, and the
//          deliberate fail-OPEN on limiter error.
//   Gap 10 `applyAnonDiscoveryLimit` — the anon per-IP branch, its key, and the
//          trusted-header precedence it inherits from `getClientIp`.
//
// Test seam for the limiters: `getMcpRatelimit` / `getMcpProMinRatelimit` /
// `getMcpAnonRatelimit` are module-private memoized singletons built from env,
// so there is no dependency-injection hook. Two levers make them testable
// without a network:
//   1. A cache-busted dynamic `import()` of auth.ts per test resets the three
//      `let` singletons (same trick tests/mcp.test.mjs uses on api/mcp.ts).
//   2. `Ratelimit.slidingWindow` is a writable STATIC method, and the instance
//      `limit()` delegates straight to `this.limiter().limit(ctx, key, rate)`
//      whose return value passes through `resolveLimitPayload` untouched when
//      `enableProtection` is off. Overriding the static therefore intercepts
//      every limiter call before any Redis I/O — no @upstash/redis client is
//      ever exercised, so none of the ~4.3s-per-call retry storms that have
//      previously slowed MCP suites can occur here.
// The `key` handed to the stub is `${prefix}:${identifier}`, so a single
// recorder proves BOTH which limiter ran (via its prefix) and the key format.
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { Ratelimit } from '@upstash/ratelimit';
import { HMAC_SECRET, PRO_USER_ID, PRO_TOKEN_ID, makeProDeps } from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };
const ORIGINAL_SLIDING_WINDOW = Ratelimit.slidingWindow;

const RESOURCE_META_URL = 'https://worldmonitor.app/.well-known/oauth-protected-resource';
const CORS = { 'Access-Control-Allow-Origin': '*' };

const USER_KEY = `wm_${'ab12'.repeat(10)}`;
const USER_KEY_USER_ID = 'user_apiplan_abc';
const ENV_KEY = 'wm_env_operator_key_999';

const PRO_CONTEXT = { kind: 'pro', userId: PRO_USER_ID, mcpTokenId: PRO_TOKEN_ID };
const USER_KEY_CONTEXT = { kind: 'user_key', apiKey: USER_KEY, userId: USER_KEY_USER_ID };
const ENV_KEY_CONTEXT = { kind: 'env_key', apiKey: ENV_KEY };

let authMod;
let bust = 0;

/** Fresh auth.ts instance — resets the three memoized limiter singletons. */
async function loadAuth() {
  bust += 1;
  return import(`../api/mcp/auth.ts?u3=${bust}-${Date.now()}`);
}

/**
 * Replace the sliding-window limiter factory with an in-memory recorder.
 * Returns the call log; each entry carries the fully-prefixed Redis key, so
 * `rl:mcp:key:<k>` / `rl:mcp:pro-min:pro-user:<id>` / `rl:mcp:anon:ip:<ip>`
 * identify the limiter AND its identifier in one assertion.
 */
function stubLimiter({ success = true, throws = false } = {}) {
  const calls = [];
  Ratelimit.slidingWindow = (tokens, window) => () => ({
    async limit(_ctx, key) {
      calls.push({ key, tokens, window });
      if (throws) throw new Error('upstash unreachable');
      return { success, limit: tokens, remaining: success ? 59 : 0, reset: Date.now() + 60_000, pending: Promise.resolve() };
    },
  });
  return calls;
}

/** Enable the Upstash env pair so the limiter getters actually construct. */
function enableLimiterEnv() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
}

beforeEach(async () => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  // A null entitlement row is `free_account` only when the backend
  // could actually run a lookup (#5619). Unconfigured → billing_verification.
  // Gate cases below need the configured path so free-account admission (#6716)
  // is observable on the null-row fixture.
  process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'test-convex-shared-secret';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.CF_EDGE_PROOF_SECRET;
  authMod = await loadAuth();
});

afterEach(() => {
  Ratelimit.slidingWindow = ORIGINAL_SLIDING_WINDOW;
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

// ---------------------------------------------------------------------------
// Gap 4 — entitlement gate, one violated predicate at a time
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
/** All four predicates satisfied. Each case below mutates exactly one field. */
const entOk = () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: true }, validUntil: Date.now() + DAY });

/**
 * Every fixture violates EXACTLY ONE predicate of
 * `if (!ent || tier < 1 || !mcpAccess || validUntil < Date.now())`.
 * `isolates` names the predicate the case is the sole witness for — i.e. the
 * predicate whose deletion this case (and only this case) turns red.
 */
const ENTITLEMENT_CASES = [
  {
    label: 'ent === null after a configured lookup',
    isolates: 'confirmed no-row free account',
    ent: () => null,
    freeAccount: true,
  },
  {
    label: 'well-formed tier 0 row',
    isolates: 'confirmed tier-0 free account',
    ent: () => ({ planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: 0 }),
    freeAccount: true,
  },
  {
    label: 'contradictory tier 0 row with mcpAccess true',
    isolates: 'malformed free shape',
    ent: () => ({ planKey: 'free', features: { tier: 0, mcpAccess: true }, validUntil: Date.now() + DAY }),
    freeAccount: false,
  },
  {
    label: 'mcpAccess false — tier 1, validUntil future',
    isolates: '!mcpAccess',
    ent: () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: false }, validUntil: Date.now() + DAY }),
    freeAccount: false,
  },
  {
    label: 'validUntil in the past — tier 1, mcpAccess true',
    isolates: 'validUntil < Date.now()',
    ent: () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: true }, validUntil: Date.now() - 1000 }),
    freeAccount: false,
  },
];

/** `mcpAccess === true` is a STRICT identity check — truthy is not enough. */
const TRUTHY_NOT_TRUE = [
  { label: "mcpAccess: 'true' (string)", value: 'true' },
  { label: 'mcpAccess: 1 (number)', value: 1 },
  { label: 'mcpAccess: {} (object)', value: {} },
];

/** Both identity-resolved entry paths funnel into the same shared gate. */
const GATE_ENTRIES = [
  { kind: 'pro', context: PRO_CONTEXT },
  { kind: 'user_key', context: USER_KEY_CONTEXT },
];

/**
 * Run the gate and unwrap to its VERDICT — the rejection Response, or null when
 * the caller passes. U3 wrapped the return in a `{ok}` union so a passing
 * pre-check can also report the plan's MCP daily limit; every case below is
 * about the verdict alone, so the unwrap keeps those assertions unchanged. The
 * limit itself is covered by its own describe block further down.
 *
 * #6716: only a confirmed no-row or well-formed tier-0 row is reinterpreted as
 * a free account. Expired/disabled tiered rows and malformed shapes stay closed.
 */
async function runGate(context, getEntitlements) {
  const { deps } = makeProDeps({ getEntitlements });
  const res = await authMod.runContextPreChecks(context, deps, RESOURCE_META_URL, CORS);
  return res.ok ? null : res.response;
}

async function assertRejected(res, label) {
  assert.ok(res instanceof Response, `${label}: gate must reject with a Response, got ${res}`);
  assert.equal(res.status, 403, `${label}: inactive entitlement is a terminal 403`);
  const body = await res.json();
  assert.equal(body.error?.code, -32002, `${label}: JSON-RPC error code`);
  assert.ok(
    typeof body.error?.message === 'string' && body.error.message.length > 0,
    `${label}: rejection message`,
  );
  assert.equal(body.error?.data?.reason, 'upgrade-required', `${label}: structured denial reason`);
  assert.equal(res.headers.get('WWW-Authenticate'), null, `${label}: terminal denial must not invite OAuth retry`);
  assert.equal(res.headers.get('Cache-Control'), 'no-store', `${label}: auth rejections must never be cached`);
}

describe('api/mcp/auth.ts — checkMcpEntitlementGate predicates (#5379 Gap 4)', () => {
  for (const entry of GATE_ENTRIES) {
    describe(`${entry.kind} context`, () => {
      for (const c of ENTITLEMENT_CASES) {
        it(`${c.freeAccount ? 'admits' : 'rejects'} ${c.label} [isolates \`${c.isolates}\`] (#6716)`, async () => {
          const { deps } = makeProDeps({ getEntitlements: async () => c.ent() });
          const res = await authMod.runContextPreChecks(entry.context, deps, RESOURCE_META_URL, CORS);
          if (c.freeAccount) {
            assert.equal(res.ok, true, `${entry.kind} / ${c.isolates}: MCP call-site must admit free allowance`);
            assert.equal(res.freeAccountAllowance, true, `${entry.kind} / ${c.isolates}: freeAccountAllowance flag`);
          } else {
            await assertRejected(res.ok ? null : res.response, `${entry.kind} / ${c.isolates}`);
          }
        });
      }

      it('control: all four predicates satisfied → gate passes (null, request proceeds)', async () => {
        const res = await runGate(entry.context, async () => entOk());
        assert.equal(res, null, 'a fully entitled owner must not be rejected');
      });

      for (const t of TRUTHY_NOT_TRUE) {
        it(`rejects malformed ${t.label} (#6716)`, async () => {
          const { deps } = makeProDeps({
            getEntitlements: async () => ({
              planKey: 'pro',
              features: { tier: 1, mcpAccess: t.value },
              validUntil: Date.now() + DAY,
            }),
          });
          const res = await authMod.runContextPreChecks(entry.context, deps, RESOURCE_META_URL, CORS);
          await assertRejected(res.ok ? null : res.response, `${entry.kind} / ${t.label}`);
        });
      }

      it('denies with a retryable 503 (fail-closed) when getEntitlements THROWS (#6716)', async () => {
        // Fail-closed is preserved — no admission, no metering. What changed is
        // the CLAIM: a thrown lookup is our backend being unreachable, so it
        // must not be rendered as a verdict about the caller's subscription.
        const res = await runGate(entry.context, async () => { throw new Error('convex down'); });
        assert.ok(res instanceof Response, `${entry.kind}: must reject with a Response`);
        assert.equal(res.status, 503, `${entry.kind}: availability failure is retryable`);
        const body = await res.json();
        assert.equal(body.error?.code, -32603, `${entry.kind}: JSON-RPC error code`);
        assert.equal(res.headers.get('Retry-After'), '5', `${entry.kind}: must say when to retry`);
        assert.equal(
          body.error?.data?.reason,
          undefined,
          `${entry.kind}: must not assert a billing/account reason for an outage`,
        );
        assert.equal(res.headers.get('Cache-Control'), 'no-store', `${entry.kind}: never cached`);
      });

      it('boundary: validUntil future passes; past-by-1ms is rejected (#6716)', async () => {
        const pass = await runGate(entry.context, async () => ({
          planKey: 'pro', features: { tier: 1, mcpAccess: true }, validUntil: Date.now() + 60_000,
        }));
        assert.equal(pass, null, 'validUntil comfortably in the future must pass');

        const { deps } = makeProDeps({
          getEntitlements: async () => ({
            planKey: 'pro', features: { tier: 1, mcpAccess: true }, validUntil: Date.now() - 1,
          }),
        });
        const expired = await authMod.runContextPreChecks(entry.context, deps, RESOURCE_META_URL, CORS);
        await assertRejected(expired.ok ? null : expired.response, `${entry.kind} / expired`);
      });

      it('tier boundary: tier 1/2 pass Pro; tier 0 admits free allowance (#6716)', async () => {
        for (const tier of [1, 2]) {
          const res = await runGate(entry.context, async () => ({
            planKey: 'pro', features: { tier, mcpAccess: true }, validUntil: Date.now() + DAY,
          }));
          assert.equal(res, null, `tier ${tier} must satisfy \`tier >= 1\``);
        }
        const { deps } = makeProDeps({
          getEntitlements: async () => ({
            planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: 0,
          }),
        });
        const res0 = await authMod.runContextPreChecks(entry.context, deps, RESOURCE_META_URL, CORS);
        assert.equal(res0.ok, true);
        assert.equal(res0.freeAccountAllowance, true);
      });

      it('missing features object → fail closed (#6716)', async () => {
        const { deps } = makeProDeps({
          getEntitlements: async () => ({ planKey: 'pro', validUntil: Date.now() + DAY }),
        });
        const res = await authMod.runContextPreChecks(entry.context, deps, RESOURCE_META_URL, CORS);
        await assertRejected(res.ok ? null : res.response, `${entry.kind} / missing features`);
      });

      for (const falsy of [undefined, 0, '', false, NaN]) {
        it(`malformed falsy entitlement \`${String(falsy)}\` → fail closed, never throw (#6716)`, async () => {
          const { deps } = makeProDeps({ getEntitlements: async () => falsy });
          const res = await authMod.runContextPreChecks(entry.context, deps, RESOURCE_META_URL, CORS);
          await assertRejected(res.ok ? null : res.response, `${entry.kind} / ${String(falsy)}`);
        });
      }
    });
  }

  it('env_key needs NO entitlement gate — getEntitlements is never consulted', async () => {
    let calls = 0;
    const { deps } = makeProDeps({ getEntitlements: async () => { calls += 1; return null; } });
    const res = await authMod.runContextPreChecks(ENV_KEY_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true, 'operator env keys are intentionally ungated');
    assert.equal(calls, 0, 'env_key must not reach the entitlement gate at all');
  });

  it('user_key routes through the SAME shared gate as pro (no ungated credential class)', async () => {
    const seen = [];
    const { deps } = makeProDeps({
      getEntitlements: async (userId) => { seen.push(userId); return null; },
    });
    await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    await authMod.runContextPreChecks(USER_KEY_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.deepEqual(seen, [PRO_USER_ID, USER_KEY_USER_ID],
      'both identity-resolved kinds must query entitlements for their OWN userId');
  });

  it('the gate is checked against the OWNER userId, not the caller-supplied key', async () => {
    const { deps } = makeProDeps({
      getEntitlements: async (userId) => (userId === USER_KEY_USER_ID ? entOk() : null),
    });
    const res = await authMod.runContextPreChecks(USER_KEY_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true, 'entitlement lookup must key on the resolved owner');
  });
});

// ---------------------------------------------------------------------------
// Plan-driven MCP daily limit (plan 2026-07-25-001 U3 / KTD6)
// ---------------------------------------------------------------------------
// The pre-check is the ONLY place the entitlement object is already in hand, so
// it is where the daily MCP limit is resolved — dispatch threads the value into
// `reserveQuota` rather than re-fetching. These cases pin the resolution itself;
// tests/mcp-quota-plan-driven.test.mjs pins the enforcement it feeds.

const withLimits = (planKey, mcpCallsPerDay, tier = 1) => ({
  planKey,
  features: {
    tier,
    mcpAccess: true,
    planLimits: {
      apiRequestsPerDay: 0,
      apiBurstRequestsPerMinute: 0,
      mcpCallsPerDay,
      mcpBurstRequestsPerMinute: 60,
    },
  },
  validUntil: Date.now() + DAY,
});

/** An API-tier row: no MCP allowance of its own, charges the REST budget. */
const withSharedLimits = (planKey, apiRequestsPerDay, tier = 2) => ({
  planKey,
  features: {
    tier,
    mcpAccess: true,
    planLimits: {
      apiRequestsPerDay,
      apiBurstRequestsPerMinute: 60,
      mcpCallsPerDay: 'shared-api-budget',
      mcpBurstRequestsPerMinute: 60,
    },
  },
  validUntil: Date.now() + DAY,
});

describe('api/mcp/auth.ts — pre-check resolves the plan MCP daily limit (U3 / KTD6)', () => {
  it('pro context carries the plan limit through to the caller (pro_business → 250)', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => withLimits('pro_business_monthly', 250) });
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true, 'an entitled Pro Business owner passes the gate');
    assert.deepEqual(res.budget, { allowance: 'mcp', limit: 250 }, 'the resolved budget rides on the pass result');
  });

  it('pro context with the Pro plan resolves 50 (the plan value, which happens to equal the default)', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => withLimits('pro_monthly', 50) });
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true);
    assert.deepEqual(res.budget, { allowance: 'mcp', limit: 50 });
  });

  it('pro context with an unlimited plan resolves null (distinct from "missing")', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => withLimits('enterprise', null, 3) });
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true);
    assert.deepEqual(res.budget, { allowance: 'mcp', limit: null }, 'null is the unlimited sentinel, not an absent value');
  });

  it('pro context on a legacy row without planLimits falls back to the dedicated 50 default', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => entOk() });
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true);
    assert.deepEqual(res.budget, { allowance: 'mcp', limit: 50 }, 'an unreadable limit never buys a wider cap');
  });

  it('user_key carries the SAME budget as the OAuth door for the same subscriber', async () => {
    // The shared budget is only a cap once REST enforcement is on; in shadow
    // the plan stays on its dedicated counter (mcp-shared-budget-enforcement).
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    const ent = async () => withSharedLimits('api_business', 10_000, 2);
    const viaUserKey = await authMod.runContextPreChecks(
      USER_KEY_CONTEXT, makeProDeps({ getEntitlements: ent }).deps, RESOURCE_META_URL, CORS,
    );
    const viaOauth = await authMod.runContextPreChecks(
      PRO_CONTEXT, makeProDeps({ getEntitlements: ent }).deps, RESOURCE_META_URL, CORS,
    );
    assert.equal(viaUserKey.ok, true);
    assert.deepEqual(
      viaUserKey.budget, viaOauth.budget,
      'the two credential doors must not disagree about the cap — the property KTD6 pinned to 50',
    );
    assert.deepEqual(viaUserKey.budget, { allowance: 'api', counter: 'api', limit: 10_000 });
  });

  it('env_key passes with no limit at all (never metered by the daily counter)', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => withLimits('api_business', 10_000, 2) });
    const res = await authMod.runContextPreChecks(ENV_KEY_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true);
    assert.equal(res.budget, undefined);
  });

  it('a rejected gate carries the Response and no limit (fail-closed shape is unambiguous)', async () => {
    // Throws remain hard rejects; null rows now admit free-account allowance (#6716).
    const { deps } = makeProDeps({ getEntitlements: async () => { throw new Error('convex down'); } });
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, false);
    assert.ok(res.response instanceof Response);
    assert.equal(res.budget, undefined);
  });

  it('user_key fails closed before dispatch when MCP_INTERNAL_HMAC_SECRET is missing', async () => {
    delete process.env.MCP_INTERNAL_HMAC_SECRET;
    let entitlementCalls = 0;
    const { deps } = makeProDeps({
      getEntitlements: async () => {
        entitlementCalls += 1;
        return withLimits('api_business', 10_000, 2);
      },
    });
    const res = await authMod.runContextPreChecks(USER_KEY_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, false);
    assert.equal(res.response.status, 503);
    assert.equal(res.response.headers.get('Retry-After'), '5');
    assert.equal(entitlementCalls, 0, 'must not reach entitlement or quota once the signing secret is gone');
  });

  it('env_key still skips the HMAC-secret preflight (legacy operator path)', async () => {
    delete process.env.MCP_INTERNAL_HMAC_SECRET;
    const { deps } = makeProDeps();
    const res = await authMod.runContextPreChecks(ENV_KEY_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true);
  });
});

describe('api/mcp/auth.ts — buildAuthHeaders credential class', () => {
  it('user_key signs the internal HMAC and never forwards the dashboard key', async () => {
    const { verifyInternalMcpRequest } = await import('../server/_shared/mcp-internal-hmac.ts');
    const url = 'https://example.test/api/intelligence/v1/get-country-risk?countryCode=US';
    const headers = await authMod.buildAuthHeaders(USER_KEY_CONTEXT, 'GET', url, null);
    assert.equal(headers['X-WorldMonitor-Key'], undefined);
    assert.ok(headers['X-WM-MCP-Internal']);
    assert.equal(headers['X-WM-MCP-User-Id'], USER_KEY_USER_ID);
    const signed = new Request(url, { method: 'GET', headers });
    assert.ok(await verifyInternalMcpRequest(signed, HMAC_SECRET));
  });

  it('env_key stays on the raw-key path', async () => {
    const headers = await authMod.buildAuthHeaders(ENV_KEY_CONTEXT, 'GET', 'https://example.test/api/x', null);
    assert.equal(headers['X-WorldMonitor-Key'], ENV_KEY);
    assert.equal(headers['X-WM-MCP-Internal'], undefined);
  });
});

// ---------------------------------------------------------------------------
// Gap 9 — applyPerMinuteLimit
// ---------------------------------------------------------------------------

/** Capture the structured telemetry lines emitted during `fn`. */
async function withTelemetry(fn) {
  process.env.MCP_TELEMETRY = 'true';
  const captured = [];
  const origLog = console.log;
  console.log = (line) => captured.push(line);
  try {
    await fn();
  } finally {
    console.log = origLog;
    process.env.MCP_TELEMETRY = 'false';
  }
  return captured.filter((l) => l && typeof l === 'object' && l.tag === 'mcp.rate_limit_hit');
}

describe('api/mcp/auth.ts — applyPerMinuteLimit (#5379 Gap 9)', () => {
  const PER_MINUTE_CONTEXTS = [
    { kind: 'env_key', context: ENV_KEY_CONTEXT, key: `rl:mcp:key:${ENV_KEY}`, message: 'Rate limit exceeded. Max 60 requests per minute per API key.' },
    { kind: 'pro', context: PRO_CONTEXT, key: `rl:mcp:pro-min:pro-user:${PRO_USER_ID}`, message: 'Rate limit exceeded. Max 60 requests per minute per user.' },
    { kind: 'user_key', context: USER_KEY_CONTEXT, key: `rl:mcp:pro-min:pro-user:${USER_KEY_USER_ID}`, message: 'Rate limit exceeded. Max 60 requests per minute per user.' },
  ];

  for (const c of PER_MINUTE_CONTEXTS) {
    describe(`${c.kind} branch`, () => {
      it('no Upstash env → limiter absent → null (pass-through, never blocks)', async () => {
        const calls = stubLimiter({ success: false });
        const res = await authMod.applyPerMinuteLimit(c.context, CORS);
        assert.equal(res, null, 'an unconfigured limiter must not block traffic');
        assert.deepEqual(calls, [], 'no limiter should have been constructed at all');
      });

      it(`under limit → null, and keys the window on \`${c.key}\``, async () => {
        enableLimiterEnv();
        const calls = stubLimiter({ success: true });
        const res = await authMod.applyPerMinuteLimit(c.context, CORS);
        assert.equal(res, null);
        assert.equal(calls.length, 1, 'exactly one limiter call per request');
        assert.equal(calls[0].key, c.key, 'rate-limit bucket identity');
        assert.equal(calls[0].tokens, 60, '60 requests…');
        assert.equal(calls[0].window, '60 s', '…per 60 second sliding window');
      });

      it('over limit → -32029 rpcError with the branch-specific message', async () => {
        enableLimiterEnv();
        const calls = stubLimiter({ success: false });
        const res = await authMod.applyPerMinuteLimit(c.context, CORS);
        assert.ok(res instanceof Response, 'a real limit hit must return a Response');
        assert.equal(calls[0].key, c.key);
        const body = await res.json();
        assert.equal(body.jsonrpc, '2.0');
        assert.equal(body.id, null);
        assert.equal(body.error?.code, -32029);
        assert.equal(body.error?.message, c.message);
        assert.equal(res.headers.get('Cache-Control'), 'no-store');
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', 'CORS headers must survive the rejection');
      });

      it('over limit → emits mcp.rate_limit_hit telemetry with the burst dimension', async () => {
        enableLimiterEnv();
        stubLimiter({ success: false });
        const hits = await withTelemetry(() => authMod.applyPerMinuteLimit(c.context, CORS));
        assert.equal(hits.length, 1, 'exactly one rate-limit telemetry line');
        assert.equal(hits[0].dimension, 'mcp_minute_burst');
        assert.equal(hits[0].limit, 60);
        assert.equal(hits[0].window_seconds, 60);
        assert.equal(hits[0].auth_kind, c.kind, 'telemetry must attribute the credential class');
      });

      it('limiter THROWS → null (deliberate fail-OPEN; the daily quota is the hard cap)', async () => {
        enableLimiterEnv();
        const calls = stubLimiter({ throws: true });
        const res = await authMod.applyPerMinuteLimit(c.context, CORS);
        assert.equal(res, null, 'an Upstash outage must degrade gracefully, not 500');
        assert.equal(calls.length, 1, 'the throw must come from the limiter, not a skipped call');
      });

      it('under-limit success emits NO rate-limit telemetry', async () => {
        enableLimiterEnv();
        stubLimiter({ success: true });
        const hits = await withTelemetry(() => authMod.applyPerMinuteLimit(c.context, CORS));
        assert.deepEqual(hits, [], 'telemetry fires only on an actual limit hit');
      });
    });
  }

  it('pro and user_key SHARE one per-user budget (same limiter, same bucket)', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    const sameOwnerUserKey = { kind: 'user_key', apiKey: USER_KEY, userId: PRO_USER_ID };
    await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS);
    await authMod.applyPerMinuteLimit(sameOwnerUserKey, CORS);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].key, calls[1].key,
      'one user with an OAuth connection AND a dashboard key gets ONE combined 60/min budget, not two stackable ones');
    assert.equal(calls[0].key, `rl:mcp:pro-min:pro-user:${PRO_USER_ID}`);
  });

  it('env_key and pro use SEPARATE limiter prefixes (no cross-class bucket sharing)', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyPerMinuteLimit(ENV_KEY_CONTEXT, CORS);
    await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS);
    assert.ok(calls[0].key.startsWith('rl:mcp:key:'), 'env_key keeps the legacy per-key prefix');
    assert.ok(calls[1].key.startsWith('rl:mcp:pro-min:'), 'pro uses the dedicated per-user prefix');
  });

  it('distinct principals get distinct buckets (no accidental global bucket)', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyPerMinuteLimit({ kind: 'pro', userId: 'user_a', mcpTokenId: 't' }, CORS);
    await authMod.applyPerMinuteLimit({ kind: 'pro', userId: 'user_b', mcpTokenId: 't' }, CORS);
    assert.notEqual(calls[0].key, calls[1].key);
  });

  it('only UPSTASH url set (token missing) → limiter absent → null', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
    const calls = stubLimiter({ success: false });
    assert.equal(await authMod.applyPerMinuteLimit(ENV_KEY_CONTEXT, CORS), null);
    assert.equal(await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS), null);
    assert.deepEqual(calls, [], 'a half-configured limiter must not construct');
  });

  it('defaults to no extra headers when the caller omits them', async () => {
    enableLimiterEnv();
    stubLimiter({ success: false });
    const res = await authMod.applyPerMinuteLimit(ENV_KEY_CONTEXT);
    assert.equal(res.status, 200, 'JSON-RPC errors ride on HTTP 200');
    assert.equal((await res.json()).error?.code, -32029);
  });
});

// ---------------------------------------------------------------------------
// Per-plan minute burst
// ---------------------------------------------------------------------------
// The catalog sells API Business 300/min and everyone else 60. A single
// hardcoded slidingWindow(60) throttled that plan to a fifth of its number and
// then reported 60 as the observed ceiling in telemetry.

/** An entitlement row with an explicit MCP burst, everything else catalog-shaped. */
const withBurst = (planKey, mcpBurstRequestsPerMinute, tier = 2) => ({
  planKey,
  features: {
    tier,
    mcpAccess: true,
    planLimits: {
      apiRequestsPerDay: 10_000,
      apiBurstRequestsPerMinute: 300,
      mcpCallsPerDay: 'shared-api-budget',
      mcpBurstRequestsPerMinute,
    },
  },
  validUntil: Date.now() + DAY,
});

describe('api/mcp/auth.ts — the minute burst is the plan\'s, not a constant', () => {
  it('the pre-check resolves the plan burst for both credential doors', async () => {
    for (const context of [PRO_CONTEXT, USER_KEY_CONTEXT]) {
      const { deps } = makeProDeps({ getEntitlements: async () => withBurst('api_business', 300) });
      const res = await authMod.runContextPreChecks(context, deps, RESOURCE_META_URL, CORS);
      assert.equal(res.ok, true);
      assert.equal(res.burstPerMinute, 300, 'API Business sells 300/min through either door');
    }
  });

  it('a 60/min plan resolves 60', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => withLimits('pro_monthly', 50) });
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.burstPerMinute, 60);
  });

  it('an unreadable burst resolves to 60 — the lower of the two ceilings sold', async () => {
    for (const bad of [undefined, null, Number.NaN, -30, '300', 0.5]) {
      const { deps } = makeProDeps({ getEntitlements: async () => withBurst('api_business', bad) });
      const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
      assert.equal(res.burstPerMinute, 60, `burst ${String(bad)} must not widen the window`);
    }
  });

  it('a catalog 0 resolves to 60 rather than a slidingWindow(0) that rejects everything', async () => {
    // The free plan publishes `mcpBurstRequestsPerMinute: 0`. Honouring it here
    // would 429 the #6716 free-account funnel on its first call; that funnel's
    // ceiling is its daily allowance. `server/gateway.ts` guards `perMinute > 0`
    // before checkBurst for the same reason.
    const { deps } = makeProDeps({
      getEntitlements: async () => ({
        planKey: 'free',
        features: {
          tier: 0,
          mcpAccess: false,
          planLimits: { mcpCallsPerDay: 0, mcpBurstRequestsPerMinute: 0 },
        },
        validUntil: Date.now() + DAY,
      }),
    });
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true, 'a free row is admitted to the metered allowance (#6716)');
    assert.equal(res.freeAccountAllowance, true);
    assert.equal(res.burstPerMinute, 60);
  });

  it('a legacy row with no planLimits still resolves 60', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => entOk() });
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.burstPerMinute, 60);
  });

  it('the resolved burst becomes the sliding-window threshold, same bucket key', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS, 300);
    assert.equal(calls[0].tokens, 300, 'the window must admit what the plan sold');
    assert.equal(calls[0].window, '60 s');
    assert.equal(
      calls[0].key,
      `rl:mcp:pro-min:pro-user:${PRO_USER_ID}`,
      'Upstash applies the threshold at read time, so the key family must not move',
    );
  });

  it('two plans on one deployment get their own limiters and keep their own buckets', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS, 60);
    await authMod.applyPerMinuteLimit({ kind: 'pro', userId: 'user_business', mcpTokenId: 't' }, CORS, 300);
    await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS, 60);
    assert.deepEqual(calls.map((c) => c.tokens), [60, 300, 60], 'the memo must be keyed by limit, not shared');
    assert.equal(calls[0].key, calls[2].key);
    assert.notEqual(calls[0].key, calls[1].key);
  });

  it('a 300/min hit reports 300 — the scanner reads observed_limit from this line', async () => {
    enableLimiterEnv();
    stubLimiter({ success: false });
    const hits = await withTelemetry(() => authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS, 300));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].limit, 300, 'a hardcoded 60 records the wrong ceiling for every API Business account');
    assert.equal(hits[0].window_seconds, 60);
  });

  it('the -32029 copy quotes the limit that actually rejected', async () => {
    enableLimiterEnv();
    stubLimiter({ success: false });
    const res = await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS, 300);
    assert.equal(
      (await res.json()).error?.message,
      'Rate limit exceeded. Max 300 requests per minute per user.',
    );
  });

  it('env_key keeps the fixed legacy threshold, whatever the caller passes', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: false });
    const res = await authMod.applyPerMinuteLimit(ENV_KEY_CONTEXT, CORS, 300);
    assert.equal(calls[0].tokens, 60, 'operator keys carry no entitlement row to read a plan from');
    assert.equal(
      (await res.json()).error?.message,
      'Rate limit exceeded. Max 60 requests per minute per API key.',
    );
  });

  it('an omitted burst falls back to 60, so an unresolved pre-check cannot widen it', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS);
    await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS, undefined);
    assert.deepEqual(calls.map((c) => c.tokens), [60, 60]);
  });
});

// ---------------------------------------------------------------------------
// Gap 10 — applyAnonDiscoveryLimit
// ---------------------------------------------------------------------------

const EDGE_PROOF = 'edge-proof-secret-value';

function anonReq(headers = {}) {
  return new Request('https://worldmonitor.app/mcp', { method: 'POST', headers });
}

describe('api/mcp/auth.ts — applyAnonDiscoveryLimit (#5379 Gap 10)', () => {
  it('no Upstash env → limiter absent → null (discovery stays open)', async () => {
    const calls = stubLimiter({ success: false });
    const res = await authMod.applyAnonDiscoveryLimit(anonReq({ 'x-real-ip': '9.9.9.9' }), CORS);
    assert.equal(res, null);
    assert.deepEqual(calls, []);
  });

  it('under limit → null, keyed `ip:<trusted client ip>`', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    const res = await authMod.applyAnonDiscoveryLimit(anonReq({ 'x-real-ip': '9.9.9.9' }), CORS);
    assert.equal(res, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, 'rl:mcp:anon:ip:9.9.9.9');
    assert.equal(calls[0].tokens, 60);
    assert.equal(calls[0].window, '60 s');
  });

  it('over limit → -32029 with the anon-specific message', async () => {
    enableLimiterEnv();
    stubLimiter({ success: false });
    const res = await authMod.applyAnonDiscoveryLimit(anonReq({ 'x-real-ip': '9.9.9.9' }), CORS);
    assert.ok(res instanceof Response);
    const body = await res.json();
    assert.equal(body.error?.code, -32029);
    assert.equal(body.error?.message, 'Rate limit exceeded. Max 60 unauthenticated discovery requests per minute per IP.');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  });

  it('limiter THROWS → null (fail-OPEN: discovery is a cheap in-memory payload)', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ throws: true });
    const res = await authMod.applyAnonDiscoveryLimit(anonReq({ 'x-real-ip': '9.9.9.9' }), CORS);
    assert.equal(res, null);
    assert.equal(calls.length, 1);
  });

  it('uses the anon prefix — never shares a bucket with an authed principal', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyAnonDiscoveryLimit(anonReq({ 'x-real-ip': '9.9.9.9' }), CORS);
    await authMod.applyPerMinuteLimit(PRO_CONTEXT, CORS);
    assert.ok(calls[0].key.startsWith('rl:mcp:anon:'));
    assert.ok(calls[1].key.startsWith('rl:mcp:pro-min:'));
  });

  // ── trusted-header precedence (GHSA-c267): the anon limiter is the one
  //    surface where a spoofable IP header would let a caller rotate buckets
  //    at will and neutralise the limit entirely. ──

  it('IGNORES x-forwarded-for — a spoofed XFF cannot rotate the bucket', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyAnonDiscoveryLimit(anonReq({ 'x-forwarded-for': '1.2.3.4' }), CORS);
    await authMod.applyAnonDiscoveryLimit(anonReq({ 'x-forwarded-for': '5.6.7.8' }), CORS);
    assert.equal(calls[0].key, 'rl:mcp:anon:ip:unknown');
    assert.equal(calls[1].key, calls[0].key,
      'rotating x-forwarded-for must NOT produce a fresh sliding-window bucket');
  });

  it('IGNORES cf-connecting-ip without CF transit proof (falls back to x-real-ip)', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyAnonDiscoveryLimit(
      anonReq({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '6.6.6.6' }),
      CORS,
    );
    assert.equal(calls[0].key, 'rl:mcp:anon:ip:9.9.9.9',
      'cf-connecting-ip is client-controlled on a direct-to-origin hit; only x-real-ip is the real peer');
  });

  it('TRUSTS cf-connecting-ip when the edge-proof header matches CF_EDGE_PROOF_SECRET', async () => {
    enableLimiterEnv();
    process.env.CF_EDGE_PROOF_SECRET = EDGE_PROOF;
    const calls = stubLimiter({ success: true });
    await authMod.applyAnonDiscoveryLimit(
      anonReq({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '9.9.9.9', 'x-wm-edge-proof': EDGE_PROOF }),
      CORS,
    );
    assert.equal(calls[0].key, 'rl:mcp:anon:ip:1.1.1.1', 'proven CF transit makes cf-connecting-ip authoritative');
  });

  it('a WRONG edge-proof value does not unlock cf-connecting-ip', async () => {
    enableLimiterEnv();
    process.env.CF_EDGE_PROOF_SECRET = EDGE_PROOF;
    const calls = stubLimiter({ success: true });
    await authMod.applyAnonDiscoveryLimit(
      anonReq({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '9.9.9.9', 'x-wm-edge-proof': 'not-the-secret' }),
      CORS,
    );
    assert.equal(calls[0].key, 'rl:mcp:anon:ip:9.9.9.9');
  });

  it('no IP headers at all → shared `ip:unknown` bucket (never an empty key)', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyAnonDiscoveryLimit(anonReq(), CORS);
    assert.equal(calls[0].key, 'rl:mcp:anon:ip:unknown');
  });

  it('distinct trusted IPs get distinct buckets', async () => {
    enableLimiterEnv();
    const calls = stubLimiter({ success: true });
    await authMod.applyAnonDiscoveryLimit(anonReq({ 'x-real-ip': '9.9.9.9' }), CORS);
    await authMod.applyAnonDiscoveryLimit(anonReq({ 'x-real-ip': '8.8.8.8' }), CORS);
    assert.equal(calls[0].key, 'rl:mcp:anon:ip:9.9.9.9');
    assert.equal(calls[1].key, 'rl:mcp:anon:ip:8.8.8.8');
  });
});

// ---------------------------------------------------------------------------
// WORLDMONITOR-ZR — a `transient` verdict is a fail-soft degrade, not a defect.
// `validateProMcpToken` returns it for a Convex 5xx, network error, timeout, or
// malformed body, and the caller is handed a retryable 503 + `Retry-After`.
// Reporting that at Sentry's default `error` level paged on-call for routine
// upstream blips (6 events across 5 releases in 17 days, every one isolated) —
// the exact condition api/user-prefs.ts and api/_rate-limit.js already
// downgrade. The asymmetry with the sibling `catch` is load-bearing, so it is
// pinned here too: a THROWN validator is an unexpected defect and must keep
// paging.
//
// `captureSilentError` self-disables without a DSN (`_envelopeUrl` / `_key` are
// unset under test), so the level is not observable at runtime here. Pin it
// from source text — the same lever tests/rate-limit.test.mts uses on the
// rate-limit capture, for exactly this reason.
// ---------------------------------------------------------------------------
describe('api/mcp/auth.ts — a transient Convex verdict degrades, it does not page (WORLDMONITOR-ZR)', () => {
  it('a transient validate verdict still fails closed on a retryable 503', async () => {
    const { deps } = makeProDeps({ validateProMcpToken: async () => ({ ok: 'transient' }) });
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, false, 'a transient verdict never grants the call');
    assert.equal(res.response.status, 503);
    assert.equal(res.response.headers.get('Retry-After'), '5', 'the client is told to back off');
  });

  it('the happy path is untouched by the downgrade', async () => {
    const { deps } = makeProDeps();
    const res = await authMod.runContextPreChecks(PRO_CONTEXT, deps, RESOURCE_META_URL, CORS);
    assert.equal(res.ok, true, 'a valid grant still passes the gate');
  });

  it('the transient capture carries level: warning, and the thrown-validator catch does NOT', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../api/mcp/auth.ts', import.meta.url), 'utf8');

    const transientAt = src.indexOf("validation.ok === 'transient'");
    assert.ok(transientAt > 0, 'the transient branch still exists');

    const branch = src.slice(transientAt);
    const transientCapture = branch.slice(
      branch.indexOf('captureSilentError'),
      branch.indexOf('return {'),
    );
    assert.match(
      transientCapture,
      /level:\s*'warning'/,
      'the fail-soft transient verdict must not page on-call at error level',
    );

    // Preservation: the sibling `catch` reports an UNEXPECTED rejection of the
    // validator. If a future widening drags it to `warning` too, a genuine
    // defect on the gated Pro path goes quiet.
    const validateAt = src.indexOf('deps.validateProMcpToken(context.mcpTokenId)');
    const catchAt = src.indexOf('} catch (err) {', validateAt);
    assert.ok(
      validateAt > 0 && catchAt > validateAt && catchAt < transientAt,
      'the guarded await and its catch still bracket the transient branch — if this '
        + 'fails the slice below is meaningless, not merely failing',
    );
    const thrownCapture = src.slice(catchAt, transientAt);
    assert.match(thrownCapture, /captureSilentError\(err,/, 'the catch still reports');
    assert.doesNotMatch(
      thrownCapture,
      /level:\s*'warning'/,
      'a THROWN validator is a defect, not the fail-soft path — it must keep paging',
    );
  });
});
