// report_issue (#8721): the MCP door to the agent feedback write path.
//
// What these tests pin, from docs/architecture/agent-feedback-threat-model.md:
//   - caller identity comes from the request and the auth context, never from
//     the arguments (Entry paths);
//   - keyed means a Pro or `wm_` principal that passes the entitlement
//     pre-check; everyone else, including a failing or unavailable pre-check,
//     reports anonymously (Decision 2);
//   - each refusal maps to a fixed JSON-RPC error and HTTP status, and a
//     refused security report keeps the advisory URL (Decision 13);
//   - the 24 KB body cap REST enforces while reading holds here before any
//     Redis or Convex work (Decision 4);
//   - report text never reaches a log line.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ratelimit } from '@upstash/ratelimit';

import { HMAC_SECRET, PRO_USER_ID, makeProDeps } from './helpers/mcp-pro-deps.mjs';

const CONVEX = 'https://synthetic.convex.site';
const ADVISORY = 'https://github.com/koala73/worldmonitor/security/advisories/new';
const ENV_KEYS = [
  'USAGE_UA_PEPPER', 'CONVEX_SITE_URL', 'CONVEX_SERVER_SHARED_SECRET',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'MCP_INTERNAL_HMAC_SECRET',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalSlidingWindow = Ratelimit.slidingWindow;

// Mutable limiter behaviour, read by the stub on every call. The scoped
// limiter is cached per scope for the life of the process, so the stub must
// stay installed and consult this state instead of being swapped per test.
let limiter = { mode: 'allow' };
let limiterCalls = [];
let convexCalls = [];
let convexSubmit = () => Response.json({ reportId: 'rep_1', status: 'received' });

let dispatchToolsCall;
let FEEDBACK_MAX_BODY_BYTES;

before(async () => {
  Object.assign(process.env, {
    USAGE_UA_PEPPER: 'synthetic-pepper',
    CONVEX_SITE_URL: CONVEX,
    CONVEX_SERVER_SHARED_SECRET: 'synthetic-secret',
    UPSTASH_REDIS_REST_URL: 'https://stub.upstash.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'stub-token',
    MCP_INTERNAL_HMAC_SECRET: HMAC_SECRET,
  });
  Ratelimit.slidingWindow = (tokens, window) => () => ({
    async limit(_ctx, prefixedKey) {
      // Ratelimit hands the limiter `<prefix>:<identifier>`; the scoped
      // limiter's prefix is `rl:scope`. Only the feedback buckets are under
      // test; any other limiter allows.
      const key = String(prefixedKey).replace(/^rl:scope:/, '');
      if (!key.startsWith('agent-feedback:')) {
        return { success: true, limit: tokens, remaining: tokens, reset: Date.now() + 60_000, pending: Promise.resolve() };
      }
      limiterCalls.push({ key, tokens, window });
      if (limiter.mode === 'throw') throw new Error('upstash unreachable');
      const success = limiter.mode !== 'deny';
      return { success, limit: tokens, remaining: success ? tokens - 1 : 0, reset: Date.now() + 60_000, pending: Promise.resolve() };
    },
  });
  ({ dispatchToolsCall } = await import('../api/mcp/dispatch.ts'));
  ({ FEEDBACK_MAX_BODY_BYTES } = await import('../server/_shared/agent-feedback.ts'));
});

after(() => {
  Ratelimit.slidingWindow = originalSlidingWindow;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  limiter = { mode: 'allow' };
  limiterCalls = [];
  convexCalls = [];
  convexSubmit = () => Response.json({ reportId: 'rep_1', status: 'received' });
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, CONVEX, `report_issue must not fetch ${parsed.origin}`);
    const body = JSON.parse(init.body);
    convexCalls.push({ path: parsed.pathname, body, headers: init.headers });
    if (parsed.pathname === '/api/internal-find-feedback-retry') return Response.json({ found: null });
    if (parsed.pathname === '/api/internal-submit-feedback') return convexSubmit(body);
    throw new Error(`unexpected Convex path ${parsed.pathname}`);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PRO_CONTEXT = { kind: 'pro', userId: PRO_USER_ID, mcpTokenId: 'k57mcptokenid' };

function reportRequest(headers = {}) {
  return new Request('https://worldmonitor.app/mcp', {
    method: 'POST',
    headers: { 'x-real-ip': '203.0.113.7', 'user-agent': 'synthetic-agent/1.0', ...headers },
  });
}

async function report(args, { context = { kind: 'free' }, deps = makeProDeps().deps, headers } = {}) {
  const res = await dispatchToolsCall(
    reportRequest(headers),
    context,
    deps,
    { id: 7, params: { name: 'report_issue', arguments: args } },
    {},
  );
  return { res, body: await res.json() };
}

const submitted = () => convexCalls.find((call) => call.path === '/api/internal-submit-feedback')?.body;

describe('report_issue — stores a report', () => {
  it('returns the stored reportId and status to an anonymous caller', async () => {
    const { res, body } = await report({ kind: 'bug', summary: 'get_market_data returned an empty list.' });
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.deepEqual(body.result.structuredContent, { reportId: 'rep_1', status: 'received' });
    assert.equal(submitted().kind, 'bug');
    assert.equal(submitted().principalId, undefined, 'an anonymous report stores no principal');
    assert.deepEqual(limiterCalls.map((call) => call.key.split(':').slice(0, 2).join(':')), [
      'agent-feedback:anon-ip',
      'agent-feedback:global-anon',
    ]);
  });

  it('adds the advisory URL to a security report', async () => {
    convexSubmit = () => Response.json({ reportId: 'rep_s', status: 'private' });
    const { body } = await report({ kind: 'security', summary: 'Possible auth bypass.' });
    assert.equal(body.result.structuredContent.status, 'private');
    assert.equal(body.result.structuredContent.advisoryUrl, ADVISORY);
    assert.equal(typeof body.result.structuredContent.notice, 'string');
  });
});

describe('report_issue — identity comes from the request, never the arguments', () => {
  it('ignores or rejects identity smuggled through arguments', async () => {
    const { body } = await report({
      kind: 'bug',
      summary: 'Identity test.',
      principalId: 'user_attacker',
      clientIp: '198.51.100.1',
      authKind: 'keyed',
    });
    if (body.error) {
      assert.equal(body.error.code, -32602, 'unknown identity arguments may only be rejected as invalid params');
      assert.equal(convexCalls.length, 0);
      return;
    }
    assert.equal(submitted().principalId, undefined, 'a principalId argument must never become the stored principal');
    const ipBucket = limiterCalls.find((call) => call.key.startsWith('agent-feedback:anon-ip:'));
    assert.ok(ipBucket, 'the caller is charged to the anonymous bucket');
    assert.ok(!ipBucket.key.includes('198.51.100.1'), 'the per-IP bucket must come from the request, not the arguments');
    assert.ok(ipBucket.key.includes('203.0.113.7'));
  });

  it('keys a Pro caller whose entitlement pre-check passes', async () => {
    const { body } = await report({ kind: 'bug', summary: 'Keyed report.' }, { context: PRO_CONTEXT });
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.equal(submitted().principalId, PRO_USER_ID);
    assert.deepEqual(limiterCalls.map((call) => call.key), [
      `agent-feedback:keyed:${PRO_USER_ID}`,
      'agent-feedback:global-keyed:all',
    ]);
  });

  it('reports anonymously when the pre-check refuses the principal', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => null });
    const { body } = await report({ kind: 'bug', summary: 'Lapsed key report.' }, { context: PRO_CONTEXT, deps });
    assert.equal(body.error, undefined, 'a lapsed principal keeps the ability to report');
    assert.equal(submitted().principalId, undefined);
    assert.ok(limiterCalls[0].key.startsWith('agent-feedback:anon-ip:'));
  });

  it('reports anonymously when the pre-check throws', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => { throw new Error('convex unreachable'); } });
    const { body } = await report({ kind: 'bug', summary: 'Entitlement outage report.' }, { context: PRO_CONTEXT, deps });
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.equal(submitted().principalId, undefined);
  });
});

describe('report_issue — refusals', () => {
  it('maps a spent limit to -32029 at HTTP 429 with Retry-After', async () => {
    limiter = { mode: 'deny' };
    const { res, body } = await report({ kind: 'bug', summary: 'Over the limit.' });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '3600');
    assert.equal(body.error.code, -32029);
    assert.equal(submitted(), undefined, 'a refused report is not stored');
  });

  it('maps a degraded limiter to -32603 at HTTP 503 and keeps the advisory on a security report', async () => {
    limiter = { mode: 'throw' };
    const { res, body } = await report({ kind: 'security', summary: 'Limiter down.' });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Retry-After'), '60');
    assert.equal(body.error.code, -32603);
    assert.equal(body.error.data.advisoryUrl, ADVISORY);
    assert.equal(submitted(), undefined);
  });

  it('maps an account being deleted to -32002 at HTTP 403', async () => {
    convexSubmit = () => Response.json({ error: 'ACCOUNT_DELETION_IN_PROGRESS' }, { status: 403 });
    const { res, body } = await report({ kind: 'bug', summary: 'Deleted account.' }, { context: PRO_CONTEXT });
    assert.equal(res.status, 403);
    assert.equal(body.error.code, -32002);
  });

  it('names the invalid field on a validation failure', async () => {
    const { body } = await report({ kind: 'not-a-kind', summary: 'Bad kind.' });
    assert.equal(body.error.code, -32602);
    assert.equal(convexCalls.length, 0);
  });

  // The handler's own free-tier and burst limiters run before dispatch, so
  // the guarantee is narrower than "no Redis": no feedback bucket and no
  // Convex call for an oversized report.
  it('rejects arguments over the 24 KB cap before any feedback bucket or Convex call', async () => {
    // Every declared field is capped well under 24 KB, so the oversized body
    // rides in the universal jmespath argument, which has no schema cap here.
    const { body } = await report({ kind: 'bug', summary: 'Too big.', jmespath: `a${'b'.repeat(FEEDBACK_MAX_BODY_BYTES)}` });
    assert.equal(body.error.code, -32602);
    assert.equal(convexCalls.length, 0, 'no Convex call');
    assert.equal(limiterCalls.length, 0, 'no limiter call');
  });

  it('holds the cap on the real anonymous path through mcpHandler', async () => {
    const { mcpHandler } = await import('../api/mcp/handler.ts');
    const res = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'x-real-ip': '203.0.113.7',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'report_issue', arguments: { kind: 'bug', summary: 'Too big.', jmespath: `a${'b'.repeat(FEEDBACK_MAX_BODY_BYTES)}` } },
      }),
    }), makeProDeps().deps);
    const body = await res.json();
    assert.equal(body.error?.code, -32602, JSON.stringify(body).slice(0, 300));
    assert.equal(convexCalls.length, 0, 'no Convex call');
    assert.equal(limiterCalls.length, 0, 'no feedback bucket call');
  });
});

describe('report_issue — report text never reaches a log line', () => {
  it('logs no part of the summary, expected or actual text on success or refusal', async () => {
    const canary = 'CANARY-7f3a91';
    const lines = [];
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(args.map(String).join(' '));
    try {
      await report({ kind: 'bug', summary: `${canary} summary`, expected: `${canary} expected`, actual: `${canary} actual` });
      limiter = { mode: 'throw' };
      await report({ kind: 'bug', summary: `${canary} again`, actual: `${canary} actual` });
    } finally {
      Object.assign(console, saved);
    }
    assert.ok(lines.length > 0, 'the calls must have logged something for this check to mean anything');
    assert.deepEqual(lines.filter((line) => line.includes(canary)), []);
  });
});

// Phase 7: an error that suggests a bug or a missing capability tells the agent
// where to report it. Known states (refusals, validation, outages) do not.
describe('error guidance', () => {
  const call = async (name, args = {}) => {
    const res = await dispatchToolsCall(reportRequest(), { kind: 'free' }, makeProDeps().deps, { id: 9, params: { name, arguments: args } }, {});
    return res.json();
  };

  it('points an unknown tool call at report_issue', async () => {
    const body = await call('get_weather_forecast');
    assert.equal(body.error.code, -32602);
    assert.equal(body.error.data?.reportWith, 'report_issue');
  });

  it('points an unexpected tool failure at report_issue', async () => {
    const { TOOL_REGISTRY } = await import('../api/mcp/registry/index.ts');
    const tool = TOOL_REGISTRY.find((t) => t.name === 'get_sources');
    const original = tool._execute;
    tool._execute = async () => { throw new Error('synthetic failure'); };
    try {
      const body = await call('get_sources');
      assert.equal(body.error.code, -32603);
      assert.equal(body.error.data?.reportWith, 'report_issue');
    } finally {
      tool._execute = original;
    }
  });

  it('does not point an upstream rate limit or outage at report_issue', async () => {
    // Expected states: a report would spend the caller's allowance on noise.
    const { TOOL_REGISTRY } = await import('../api/mcp/registry/index.ts');
    const { ToolFetchError, BothSourcesFailedError } = await import('../api/mcp/downstream.ts');
    const tool = TOOL_REGISTRY.find((t) => t.name === 'get_sources');
    const original = tool._execute;
    const failures = [
      new ToolFetchError('search-intel-history', 429, 'rate_limited', 'json_error'),
      new ToolFetchError('search-intel-history', 503, 'unavailable', 'json_error'),
      new ToolFetchError('search-intel-history', 502, 'bad_gateway', 'html_error'),
      new BothSourcesFailedError(new Error('timeout'), new Error('timeout')),
    ];
    // Tools such as get_country_coverage fail through assertToolFetchOk, so
    // capture the error it really throws for each outage status.
    const { assertToolFetchOk } = await import('../api/mcp/billing-denial.ts');
    for (const status of [429, 502, 503, 504]) {
      const err = await assertToolFetchOk({ ok: false, status, headers: new Headers() }, 'get-country-coverage').catch((e) => e);
      assert.equal(err.message, `get-country-coverage HTTP ${status}`, 'the message contract is unchanged');
      failures.push(err);
    }
    try {
      for (const failure of failures) {
        tool._execute = async () => { throw failure; };
        const body = await call('get_sources');
        assert.equal(body.error.code, -32603, failure.message);
        assert.equal(body.error.data?.reportWith, undefined, failure.message);
      }
      // A downstream bug (500) still points at report_issue.
      tool._execute = async () => { throw new ToolFetchError('search-intel-history', 500, 'internal', 'json_error'); };
      assert.equal((await call('get_sources')).error.data?.reportWith, 'report_issue');
      const err500 = await assertToolFetchOk({ ok: false, status: 500, headers: new Headers() }, 'get-country-coverage').catch((e) => e);
      tool._execute = async () => { throw err500; };
      assert.equal((await call('get_sources')).error.data?.reportWith, 'report_issue');
    } finally {
      tool._execute = original;
    }
  });

  it('does not point a refused or invalid report back at report_issue', async () => {
    limiter = { mode: 'throw' };
    const refused = (await report({ kind: 'bug', summary: 'Limiter down.' })).body;
    assert.equal(refused.error.code, -32603);
    assert.equal(refused.error.data?.reportWith, undefined);
    const invalid = (await report({ kind: 'nope', summary: 'x' })).body;
    assert.equal(invalid.error.data?.reportWith, undefined);
  });
});
