// prepare_travel_risk_assessment is sold on Pro Business, API Business and
// Enterprise only (#10451). The gate is the `travelRiskAssessment` plan flag,
// read server-side in the entitlement pre-check and enforced in dispatch, so
// every door that can reach the tool is tested here rather than any UI.
//
// Entitlement fixtures are built from the real catalog, so a plan that gains
// or loses the flag in convex/config/productCatalog.ts changes these verdicts.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  BASE_URL,
  HMAC_SECRET,
  makeProDeps,
  proReq,
  callBody,
} from './helpers/mcp-pro-deps.mjs';
import { getEntitlementFeatures, PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { buildMcpStructuredDenial, informOnlyNextStep } from '../api/mcp/upgrade.ts';
import { recommendedPlanForFeature } from '../api/mcp/checkout.ts';
import { toolWeight, TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const TOOL = 'prepare_travel_risk_assessment';
const TRIP = { countries: [{ country_code: 'TH', cities: ['Bangkok'], arrive: '2026-12-01', depart: '2026-12-05' }] };
const ENV_KEY = 'wm_env_operator_key_travel_risk';
const USER_KEY = `wm_${'cd34'.repeat(10)}`;
const USER_KEY_USER_ID = 'user_travel_risk_key_owner';
const PLAN_FEATURE_MESSAGE = /included in the Pro Business, API Business and Enterprise plans/;
const travelTool = TOOL_REGISTRY.find((tool) => tool.name === TOOL);

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function catalogEntitlement(planKey, extra = {}) {
  return {
    planKey,
    features: { ...getEntitlementFeatures(planKey) },
    validUntil: Date.now() + 86_400_000,
    ...extra,
  };
}

/**
 * Upstash stand-in for the tool's source reads: every key holds a small JSON
 * object, so an admitted call runs to a 200 instead of a source-unavailable
 * error that would blur "admitted" with "failed".
 */
function stubSourceReads() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
  globalThis.fetch = async (url, init) => {
    const value = JSON.stringify({ ok: 1 });
    if (String(url).endsWith('/pipeline')) {
      const commands = JSON.parse(String(init?.body ?? '[]'));
      return Response.json(commands.map(() => ({ result: value })));
    }
    return Response.json({ result: value });
  };
}

function userKeyReq(body, headers = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': USER_KEY, ...headers },
    body: JSON.stringify(body),
  });
}

async function call(handler, req, deps) {
  const response = await handler(req, deps);
  return { response, body: await response.json() };
}

function assertPlanFeatureRefusal(response, body, label) {
  assert.equal(response.status, 403, label);
  assert.equal(body.error?.code, -32002, label);
  assert.equal(body.error.data?.reason, 'upgrade-required', label);
  assert.equal(body.error.data?.planFeature, 'travelRiskAssessment', label);
  assert.match(body.error.message, PLAN_FEATURE_MESSAGE, label);
}

describe('prepare_travel_risk_assessment plan gate through mcpHandler', () => {
  let mcpHandler;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.API_RATE_LIMIT_ENFORCE;
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    ({ mcpHandler } = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  for (const planKey of ['pro_monthly', 'pro_annual', 'api_starter', 'api_starter_annual']) {
    it(`${planKey} is refused with the plan-feature upgrade and is not metered`, async () => {
      const { deps, pipe } = makeProDeps({ getEntitlements: async () => catalogEntitlement(planKey) });
      const { response, body } = await call(mcpHandler, proReq('POST', callBody(TOOL, TRIP)), deps);
      assertPlanFeatureRefusal(response, body, planKey);
      assert.equal(pipe.count, 0, `${planKey}: a refused call charges nothing`);
      const expected = planKey.startsWith('api_') ? 'api_business' : 'pro_business_monthly';
      assert.equal(body.error.data.recommendedPlan, expected, planKey);
      assert.equal(body.error.data.checkoutTool, undefined, 'only a free account is pointed at start_upgrade');
    });
  }

  it('a free account is refused with the plan-feature copy, not the generic Pro copy', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => catalogEntitlement('free') });
    const { response, body } = await call(mcpHandler, proReq('POST', callBody(TOOL, TRIP)), deps);
    assertPlanFeatureRefusal(response, body, 'free');
    assert.equal(pipe.count, 0, 'the free allowance is not spent on a refused call');
    assert.equal(body.error.data.recommendedPlan, 'pro_business_monthly', 'Pro lacks the feature, so Pro is not offered');
    assert.equal(body.error.data.checkoutTool, 'start_upgrade');
  });

  it('streams a legacy SSE draft live without keeping a replayable copy of the trip', async () => {
    stubSourceReads();
    const store = (await import('../api/mcp/handler.ts')).__sseReplayStoreForTest;
    const sse = { Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'sess-travel-risk' };
    const entitled = () => makeProDeps({ getEntitlements: async () => catalogEntitlement('pro_business_monthly') }).deps;
    const { mcpHandler: handler } = await import('../api/mcp/handler.ts');
    store.reset();
    const control = await handler(proReq('POST', { jsonrpc: '2.0', id: 1, method: 'prompts/list' }, sse), entitled());
    await control.text();
    assert.ok(store.totalBytes() > 0, 'control: an ordinary SSE answer is buffered for replay');
    store.reset();
    const response = await handler(proReq('POST', callBody(TOOL, TRIP), sse), entitled());
    const text = await response.text();
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(text, /Travel risk assessment draft/, 'the live stream still carries the draft');
    assert.equal(store.totalBytes(), 0, 'no replay copy of the itinerary is kept');
  });

  for (const planKey of ['pro_business_monthly', 'pro_business_annual', 'api_business', 'api_business_annual', 'enterprise']) {
    it(`${planKey} runs the tool and is metered like the other multi-source tools`, async () => {
      stubSourceReads();
      const { deps, pipe } = makeProDeps({ getEntitlements: async () => catalogEntitlement(planKey) });
      const { response, body } = await call(mcpHandler, proReq('POST', callBody(TOOL, TRIP)), deps);
      assert.equal(response.status, 200, `${planKey}: ${JSON.stringify(body.error ?? null)}`);
      assert.equal(body.error, undefined, planKey);
      assert.equal(body.result?.isError, undefined, planKey);
      assert.match(body.result.structuredContent.markdown, /^# Travel risk assessment draft/m, planKey);
      // A dedicated MCP allowance counts calls; a budget shared with REST
      // charges the tool weight (api/mcp/quota.ts).
      const shared = getEntitlementFeatures(planKey).planLimits.mcpCallsPerDay === 'shared-api-budget';
      assert.equal(pipe.count, shared ? toolWeight(travelTool) : 1, planKey);
    });
  }

  it('an enterprise contract member runs the tool', async () => {
    stubSourceReads();
    const account = { id: 'acct_travel', identity: 'acct:acct_travel', dailyAllowance: 50_000, perMinuteBurst: 300, breakerMultiple: 3 };
    const { deps } = makeProDeps({ getEntitlements: async () => catalogEntitlement('enterprise', { account }) });
    const { response, body } = await call(mcpHandler, proReq('POST', callBody(TOOL, TRIP)), deps);
    assert.equal(response.status, 200, JSON.stringify(body.error ?? null));
    assert.equal(body.result?.isError, undefined);
  });

  it('an entitlement row without the flag is refused, so a stale shape fails closed', async () => {
    const legacy = catalogEntitlement('pro_business_monthly');
    delete legacy.features.travelRiskAssessment;
    const { deps } = makeProDeps({ getEntitlements: async () => legacy });
    const { response, body } = await call(mcpHandler, proReq('POST', callBody(TOOL, TRIP)), deps);
    assertPlanFeatureRefusal(response, body, 'legacy row');
  });

  it('asks the entitlement read for the current shape only on a travel risk call', async () => {
    stubSourceReads();
    const seen = [];
    const { deps } = makeProDeps({
      getEntitlements: async (userId, options) => {
        seen.push(options);
        return catalogEntitlement('pro_business_monthly');
      },
    });
    await call(mcpHandler, proReq('POST', callBody(TOOL, TRIP)), deps);
    await call(mcpHandler, proReq('POST', callBody('get_market_data')), deps);
    assert.deepEqual(seen, [{ requireTravelRiskShape: true }, undefined]);
  });

  it('the plan refusal comes before argument validation, so a refused caller learns nothing about the schema', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => catalogEntitlement('pro_monthly') });
    const { response, body } = await call(mcpHandler, proReq('POST', callBody(TOOL, { countries: [], traveller_name: 'x' })), deps);
    assertPlanFeatureRefusal(response, body, 'invalid args');
  });

  it('user key door: api_business runs the tool and api_starter is refused', async () => {
    stubSourceReads();
    const validateUserApiKey = async (key) => (key === USER_KEY ? { userId: USER_KEY_USER_ID } : null);
    const allowed = makeProDeps({ validateUserApiKey, getEntitlements: async () => catalogEntitlement('api_business') });
    const ok = await call(mcpHandler, userKeyReq(callBody(TOOL, TRIP)), allowed.deps);
    assert.equal(ok.response.status, 200, JSON.stringify(ok.body.error ?? null));
    assert.equal(ok.body.result?.isError, undefined);

    const refused = makeProDeps({ validateUserApiKey, getEntitlements: async () => catalogEntitlement('api_starter') });
    const denied = await call(mcpHandler, userKeyReq(callBody(TOOL, TRIP)), refused.deps);
    assertPlanFeatureRefusal(denied.response, denied.body, 'api_starter user key');
    assert.equal(refused.pipe.count, 0);
  });

  it('the operator env key is not plan-gated', async () => {
    stubSourceReads();
    const req = new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': ENV_KEY },
      body: JSON.stringify(callBody(TOOL, TRIP)),
    });
    const { response, body } = await call(mcpHandler, req, makeProDeps().deps);
    assert.equal(response.status, 200, JSON.stringify(body.error ?? null));
    assert.equal(body.result?.isError, undefined);
  });

  it('an anonymous caller is refused before the tool runs', async () => {
    const req = new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callBody(TOOL, TRIP)),
    });
    const { response } = await call(mcpHandler, req, makeProDeps().deps);
    assert.equal(response.status, 401);
  });

  /** Runs `fn` with every console method captured, so a test can prove nothing it typed was logged. */
  async function captureConsole(fn) {
    const lines = [];
    const saved = {};
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      saved[method] = console[method];
      console[method] = (...args) => { lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };
    }
    try {
      return { result: await fn(), logged: lines.join('\n') };
    } finally {
      Object.assign(console, saved);
    }
  }

  const PRIVATE_TRIP = {
    countries: [{ country_code: 'TH', cities: ['Chiang Mai'], arrive: '2026-12-03', depart: '2026-12-04' }],
    date_from: '2026-12-02',
    date_to: '2026-12-06',
    task_label: 'Project Larkspur',
  };
  const PRIVATE_VALUES = ['Chiang Mai', '2026-12-03', '2026-12-04', '2026-12-02', '2026-12-06', 'Larkspur'];

  it('sends no part of the trip to logs, tool-call telemetry or usage events', async () => {
    stubSourceReads();
    // Every telemetry sink on: the structured tool-call log and the Axiom usage events.
    process.env.MCP_TELEMETRY = 'true';
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'stub-token';
    const readSources = globalThis.fetch;
    const outbound = [];
    globalThis.fetch = async (url, init) => {
      outbound.push(`${String(url)} ${String(init?.body ?? '')}`);
      return String(url).includes('axiom.co') ? new Response('{}', { status: 200 }) : readSources(url, init);
    };
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    const { deps } = makeProDeps({ getEntitlements: async () => catalogEntitlement('pro_business_monthly') });
    const { result, logged } = await captureConsole(async () => {
      const response = await mcpHandler(proReq('POST', callBody(TOOL, PRIVATE_TRIP)), deps, ctx);
      const body = await response.json();
      await Promise.allSettled(pending);
      return { response, body };
    });
    assert.equal(result.response.status, 200);
    assert.match(result.body.result.structuredContent.markdown, /Chiang Mai/, 'the trip is in the draft returned to the caller');
    assert.match(logged, /mcp\.toolcall|prepare_travel_risk_assessment/, 'the tool-call log line was emitted');
    assert.ok(outbound.some((line) => line.includes('axiom.co')), 'a usage event was sent');
    const sent = outbound.join('\n');
    for (const value of PRIVATE_VALUES) {
      assert.ok(!logged.includes(value), `${value} must not be logged`);
      assert.ok(!sent.includes(value), `${value} must not leave in an outbound request`);
    }
  });

  it('refuses invalid arguments without echoing or logging them, and does not meter the call', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => catalogEntitlement('pro_business_monthly') });
    const attempts = [
      { ...PRIVATE_TRIP, traveller_name: 'Jane Doe', countries: [{ ...PRIVATE_TRIP.countries[0], address: '12 Sukhumvit Soi 4' }] },
      { ...PRIVATE_TRIP, date_to: '2026-12-01' },
    ];
    for (const args of attempts) {
      const { result, logged } = await captureConsole(() => call(mcpHandler, proReq('POST', callBody(TOOL, args)), deps));
      assert.equal(result.body.error?.code, -32602, JSON.stringify(result.body));
      const echoed = JSON.stringify(result.body);
      for (const value of [...PRIVATE_VALUES, 'Jane Doe', 'Sukhumvit', '2026-12-01']) {
        assert.ok(!echoed.includes(value), `${value} must not be echoed`);
        assert.ok(!logged.includes(value), `${value} must not be logged`);
      }
    }
    assert.equal(pipe.count, 0);
  });

  it('on ChatGPT the refusal keeps the factual message and drops the upgrade offer', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => catalogEntitlement('pro_monthly') });
    const { response, body } = await call(mcpHandler, proReq('POST', callBody(TOOL, TRIP), { 'User-Agent': 'openai-mcp/1.0.0' }), deps);
    assertPlanFeatureRefusal(response, body, 'chatgpt');
    assert.equal(body.error.data.nextStep, informOnlyNextStep({ reason: 'upgrade-required', planFeature: 'travelRiskAssessment' }));
    assert.doesNotMatch(body.error.data.nextStep, /\bUpgrade to\b/);
    assert.equal(body.error.data.recommendedPlan, undefined);
    assert.equal(body.error.data.checkoutTool, undefined);
  });
});

describe('prepare_travel_risk_assessment registration', () => {
  it('is subscription-only, carries the plan feature and is priced like the analysis tools', () => {
    assert.ok(travelTool, 'registered');
    assert.equal(travelTool._subscriptionOnly, true);
    assert.equal(travelTool._planFeature, 'travelRiskAssessment');
    const hotspots = TOOL_REGISTRY.find((tool) => tool.name === 'get_hotspot_escalation');
    assert.equal(toolWeight(travelTool), toolWeight(hotspots));
    assert.equal(toolWeight(travelTool), 2);
  });

  it('is the only tool behind the travel risk flag', () => {
    assert.deepEqual(TOOL_REGISTRY.filter((tool) => tool._planFeature !== undefined).map((tool) => tool.name), [TOOL]);
  });
});

describe('plan-feature denial copy', () => {
  it('recommends only plans whose catalog entry carries the flag', () => {
    const planKeys = [...new Set(Object.values(PRODUCT_CATALOG).map((product) => product.planKey).filter(Boolean))];
    const recommended = new Set();
    for (const planKey of [...planKeys, 'free']) {
      const plan = recommendedPlanForFeature(planKey, 'travelRiskAssessment');
      if (getEntitlementFeatures(planKey).travelRiskAssessment === true) {
        assert.equal(plan, undefined, `${planKey} already has the feature`);
        continue;
      }
      assert.ok(plan, `${planKey} lacks the feature and must be offered a plan that has it`);
      recommended.add(plan);
    }
    for (const plan of recommended) {
      assert.equal(getEntitlementFeatures(plan).travelRiskAssessment, true, `${plan} must include the feature it is offered for`);
    }
  });

  it('the structured denial names the feature and keeps the upgrade-required reason', () => {
    const { message, data } = buildMcpStructuredDenial({ reason: 'upgrade-required', planFeature: 'travelRiskAssessment', upgradeFrom: 'pro_monthly' });
    assert.match(message, PLAN_FEATURE_MESSAGE);
    assert.equal(data.reason, 'upgrade-required');
    assert.equal(data.planFeature, 'travelRiskAssessment');
    assert.equal(data.recommendedPlan, 'pro_business_monthly');
    assert.match(data.upgradeUrl, /^https:\/\//);
  });

  it('an unknown planFeature value falls back to the generic inform-only step', () => {
    assert.equal(
      informOnlyNextStep({ reason: 'upgrade-required', planFeature: 'somethingElse' }),
      informOnlyNextStep({ reason: 'upgrade-required' }),
    );
  });
});
