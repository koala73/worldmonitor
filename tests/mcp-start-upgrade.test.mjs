/**
 * #9144 — `start_upgrade` and the denial hints that point at it.
 *
 * An agent that hits a free-allowance or quota denial must be able to hand the
 * user a personal checkout link without spending the allowance it just ran
 * out of, and the denial must say which plan to ask for. The checkout itself
 * is the same Convex relay /api/create-checkout uses, so the refusals that
 * matter here are the relay's: already subscribed, payment pending, rate
 * limited.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mcpHandler } from '../api/mcp/handler.ts';
import {
  MCP_CHECKOUT_PLANS,
  checkoutProductIdForPlan,
  recommendedPlanFor,
  relayMcpCheckout,
} from '../api/mcp/checkout.ts';
import { buildMcpStructuredDenial } from '../api/mcp/upgrade.ts';
import { MCP_ATTRIBUTION_SOURCE, MCP_UPGRADE_URL } from '../shared/mcp-attribution.ts';
import { TOOL_REGISTRY, isQuotaExemptMetadataTool, toolAccess } from '../api/mcp/registry/index.ts';
import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { BASE_URL, HMAC_SECRET, PRO_USER_ID, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

const entitlement = (planKey, extra = {}) => ({
  planKey,
  features: {
    tier: planKey === 'free' ? 0 : 1,
    mcpAccess: planKey !== 'free',
    planLimits: { mcpCallsPerDay: planKey === 'free' ? 0 : 50 },
  },
  validUntil: Date.now() + 86_400_000,
  ...extra,
});

function fixture({ planKey = 'pro_monthly', outcome = { kind: 'created', checkoutUrl: 'https://checkout.dodopayments.com/session/cks_test' }, kind = 'pro', pipelineOpts } = {}) {
  const checkouts = [];
  const { deps, pipe } = makeProDeps({
    ...(kind === 'user_key' ? { resolveBearerToContext: async () => ({ kind, userId: PRO_USER_ID }) } : {}),
    ...(kind === 'env_key' ? { resolveBearerToContext: async () => ({ kind, apiKey: 'operator-key' }) } : {}),
    getEntitlements: async () => entitlement(planKey),
    pipelineOpts,
  });
  deps.createCheckout = async (input) => {
    checkouts.push(input);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { deps, pipe, checkouts };
}

async function invoke(deps, body) {
  const response = await mcpHandler(proReq('POST', body), deps);
  return { response, body: await response.json() };
}

const upgrade = (args) => callBody('start_upgrade', args);
const SELF_SERVE = Object.values(PRODUCT_CATALOG)
  .filter((entry) => entry.selfServe && entry.currentForCheckout)
  .map((entry) => entry.planKey);
const FREE_ACCOUNT_CACHE_TOOL = TOOL_REGISTRY.find((tool) => tool._execute === undefined && toolAccess(tool) === 'free-account' && tool.inputSchema.required.length === 0);
const SUBSCRIPTION_TOOL = TOOL_REGISTRY.find((tool) => toolAccess(tool) === 'subscription' && tool.inputSchema.required.length === 0);

describe('plan mapping', () => {
  it('accepts exactly the self-serve plans sold today, each bound to its catalog product', () => {
    assert.deepEqual([...MCP_CHECKOUT_PLANS].sort(), [...SELF_SERVE].sort());
    for (const plan of SELF_SERVE) assert.equal(checkoutProductIdForPlan(plan), PRODUCT_CATALOG[plan].dodoProductId);
    for (const plan of ['free', 'enterprise', 'pro', '', 'PRO_MONTHLY']) assert.equal(checkoutProductIdForPlan(plan), undefined, plan);
  });

  it('recommends one step up the same product line, and nothing above the top', () => {
    const expected = {
      free: 'pro_monthly',
      pro_monthly: 'pro_business_monthly',
      pro_annual: 'pro_business_monthly',
      api_starter: 'api_business',
      api_starter_annual: 'api_business',
      pro_business_monthly: undefined,
      pro_business_annual: undefined,
      api_business: undefined,
      api_business_annual: undefined,
      enterprise: undefined,
    };
    for (const [planKey, next] of Object.entries(expected)) assert.equal(recommendedPlanFor(planKey), next, planKey);
    // A row without a recognised plan key is not assumed to be free: offering
    // Pro to an unidentified paid caller would be a downgrade.
    for (const planKey of [undefined, 'pro', 'legacy_plan']) assert.equal(recommendedPlanFor(planKey), undefined, String(planKey));
    for (const next of Object.values(expected)) if (next) assert.ok(MCP_CHECKOUT_PLANS.includes(next));
  });
});

describe('denial checkout hints', () => {
  it('names the plan and tool on the three upgradeable denials for a free account', () => {
    for (const reason of ['allowance-exhausted', 'upgrade-required', 'quota-exceeded']) {
      const { data } = buildMcpStructuredDenial({ reason, limit: 5, sharedWithRestApi: false, upgradeFrom: 'free' });
      assert.equal(data.recommendedPlan, 'pro_monthly', reason);
      assert.equal(data.checkoutTool, 'start_upgrade', reason);
      assert.equal(data.upgradeUrl, MCP_UPGRADE_URL, 'the static link stays for clients that cannot call tools');
    }
  });

  it('names the plan but not the tool for a paid caller, whose step up the checkout guard refuses', () => {
    // Pro -> Pro Business and API Starter -> API Business are the same billing
    // family: a new checkout is refused while the current plan is active.
    for (const [upgradeFrom, plan] of [['pro_monthly', 'pro_business_monthly'], ['pro_annual', 'pro_business_monthly'], ['api_starter', 'api_business']]) {
      const { data } = buildMcpStructuredDenial({ reason: 'quota-exceeded', limit: 50, sharedWithRestApi: false, upgradeFrom });
      assert.equal(data.recommendedPlan, plan, upgradeFrom);
      assert.equal('checkoutTool' in data, false, upgradeFrom);
    }
  });

  it('omits the hint for a top plan, an unknown caller and the non-upgradeable reasons', () => {
    for (const denial of [
      { reason: 'quota-exceeded', limit: 250, sharedWithRestApi: false, upgradeFrom: 'pro_business_monthly' },
      { reason: 'quota-exceeded', limit: 10_000, sharedWithRestApi: false, upgradeFrom: 'api_business' },
      { reason: 'quota-exceeded', limit: 10_000, sharedWithRestApi: false },
      { reason: 'allowance-exhausted' },
      { reason: 'no-account', upgradeFrom: 'free' },
      { reason: 'lapsed-subscription', upgradeFrom: 'free' },
    ]) {
      const { data } = buildMcpStructuredDenial(denial);
      assert.equal('recommendedPlan' in data, false, JSON.stringify(denial));
      assert.equal('checkoutTool' in data, false, JSON.stringify(denial));
    }
  });

  it('keeps every published message byte-identical to the error catalog', () => {
    const catalog = readFileSync(new URL('../docs/mcp-error-catalog.mdx', import.meta.url), 'utf8');
    for (const denial of [
      { reason: 'allowance-exhausted', upgradeFrom: 'free' },
      { reason: 'upgrade-required', upgradeFrom: 'free' },
      { reason: 'quota-exceeded', limit: 50, sharedWithRestApi: false, upgradeFrom: 'pro_monthly' },
    ]) {
      const { message } = buildMcpStructuredDenial(denial);
      assert.ok(catalog.includes(`"message": "${message}"`), message);
      assert.equal(message, buildMcpStructuredDenial({ ...denial, upgradeFrom: undefined }).message);
    }
  });
});

describe('start_upgrade tool', () => {
  it('is listed, user-bound, quota-exempt and not read-only', async () => {
    const tool = TOOL_REGISTRY.find((entry) => entry.name === 'start_upgrade');
    assert.ok(tool);
    assert.equal(isQuotaExemptMetadataTool(tool), true);
    assert.equal(toolAccess(tool), 'free-account');
    assert.deepEqual(tool.inputSchema.required, ['plan']);
    assert.deepEqual(tool.inputSchema.properties.plan.enum, [...MCP_CHECKOUT_PLANS]);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.idempotentHint, false);
    const { deps } = fixture({ planKey: 'free' });
    const listed = await invoke(deps, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
    const advertised = listed.body.result.tools.find((entry) => entry.name === 'start_upgrade');
    assert.equal(advertised._meta['worldmonitor/access'], 'free-account');
  });

  for (const kind of ['pro', 'user_key']) {
    for (const planKey of ['free', 'pro_monthly']) {
      it(`returns a personal checkout link for a ${planKey} ${kind} caller without touching any meter`, async () => {
        const { deps, pipe, checkouts } = fixture({ planKey, kind });
        const called = await invoke(deps, upgrade({ plan: 'pro_business_monthly' }));
        assert.equal(called.body.error, undefined, JSON.stringify(called.body.error));
        assert.deepEqual(called.body.result.structuredContent, {
          checkoutUrl: 'https://checkout.dodopayments.com/session/cks_test',
          plan: 'pro_business_monthly',
          nextStep: called.body.result.structuredContent.nextStep,
        });
        assert.match(called.body.result.structuredContent.nextStep, /get_mcp_allowance/);
        assert.deepEqual(checkouts, [{ userId: PRO_USER_ID, productId: PRODUCT_CATALOG.pro_business_monthly.dodoProductId }]);
        assert.deepEqual(pipe.ops, [], 'neither the free allowance nor the daily quota is read or charged');
        assert.match(called.response.headers.get('Cache-Control'), /no-store/);
      });
    }
  }

  it('still works once the free allowance is spent', async () => {
    const { deps, pipe, checkouts } = fixture({ planKey: 'free', pipelineOpts: { initialCount: 5 } });
    const denied = await invoke(deps, callBody(FREE_ACCOUNT_CACHE_TOOL.name, {}));
    assert.equal(denied.body.error?.code, -32029);
    assert.equal(denied.body.error.data.recommendedPlan, 'pro_monthly');
    const opsBefore = pipe.ops.length;
    const called = await invoke(deps, upgrade({ plan: denied.body.error.data.recommendedPlan }));
    assert.equal(called.body.error, undefined);
    assert.equal(checkouts.length, 1);
    assert.equal(pipe.ops.length, opsBefore);
    assert.equal(pipe.count, 5);
  });

  it('refuses anonymous callers with the existing no-account denial', async () => {
    const { deps, checkouts } = fixture();
    const response = await mcpHandler(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upgrade({ plan: 'pro_monthly' })),
    }), deps);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, -32001);
    assert.equal(body.error.data.reason, 'no-account');
    assert.equal(checkouts.length, 0);
  });

  it('refuses an operator key, which has no account to bill', async () => {
    const { deps, checkouts } = fixture({ kind: 'env_key' });
    process.env.WORLDMONITOR_VALID_KEYS = 'operator-key';
    const called = await invoke(deps, upgrade({ plan: 'pro_monthly' }));
    assert.equal(called.body.error?.code, -32002);
    assert.equal(checkouts.length, 0);
  });

  it('rejects an unknown plan or extra argument before any checkout', async () => {
    for (const args of [{}, { plan: 'enterprise' }, { plan: 'free' }, { plan: 7 }, { plan: 'pro_monthly', userId: 'someone-else' }, { plan: 'pro_monthly', panel_request: {} }]) {
      const { deps, checkouts } = fixture();
      const called = await invoke(deps, upgrade(args));
      assert.equal(called.body.error?.code, -32602, JSON.stringify(args));
      assert.equal(checkouts.length, 0);
    }
    const { deps } = fixture();
    const unknown = await invoke(deps, upgrade({ plan: 'platinum' }));
    assert.deepEqual(unknown.body.error.data.plans, [...MCP_CHECKOUT_PLANS]);
  });

  it('refuses a jmespath projection before creating a session', async () => {
    // The session and a checkout admission are spent before a projection would
    // run, so a narrowing or broken expression would lose the only checkoutUrl.
    for (const jmespath of ['plan', 'not a [valid', 3]) {
      const { deps, checkouts } = fixture();
      const called = await invoke(deps, upgrade({ plan: 'pro_monthly', jmespath }));
      assert.equal(called.body.error?.code, -32602, String(jmespath));
      assert.equal(checkouts.length, 0);
    }
  });

  it('turns an existing subscription into a structured refusal with the right next step', async () => {
    const subscription = { planKey: 'pro_monthly', displayName: 'Pro Monthly', status: 'active', currentPeriodEnd: 1_800_000_000_000 };
    const { deps } = fixture({ outcome: { kind: 'already-subscribed', message: 'A Pro Monthly subscription already exists for this account.', subscription } });
    const called = await invoke(deps, upgrade({ plan: 'pro_business_monthly' }));
    assert.equal(called.response.status, 200);
    assert.equal(called.body.error.code, -32002);
    assert.equal(called.body.error.data.reason, 'already-subscribed');
    assert.deepEqual(called.body.error.data.subscription, subscription);
    assert.match(called.body.error.data.nextStep, /cancel Pro/);

    const starter = fixture({ outcome: { kind: 'already-subscribed', message: 'exists', subscription: { ...subscription, planKey: 'api_starter' } } });
    const api = await invoke(starter.deps, upgrade({ plan: 'api_business' }));
    assert.match(api.body.error.data.nextStep, /prorated plan change/);

    const same = fixture({ outcome: { kind: 'already-subscribed', message: 'exists', subscription: null } });
    const plain = await invoke(same.deps, upgrade({ plan: 'pro_monthly' }));
    assert.equal(plain.body.error.data.subscription, null);
    assert.match(plain.body.error.data.nextStep, /already has this subscription/);
  });

  it('answers a product the relay no longer sells with the accepted plan list', async () => {
    const { deps } = fixture({ outcome: { kind: 'invalid-product' } });
    const called = await invoke(deps, upgrade({ plan: 'pro_monthly' }));
    assert.equal(called.body.error.code, -32602);
    assert.deepEqual(called.body.error.data.plans, [...MCP_CHECKOUT_PLANS]);
  });

  it('reports a pending payment without creating another session', async () => {
    const { deps } = fixture({ outcome: { kind: 'payment-in-progress', message: 'A Pro Monthly payment is already in progress for this account.' } });
    const called = await invoke(deps, upgrade({ plan: 'pro_monthly' }));
    assert.equal(called.body.error.code, -32002);
    assert.equal(called.body.error.data.reason, 'payment-in-progress');
  });

  it('maps the checkout rate limit to 429 / -32029 with Retry-After', async () => {
    const { deps } = fixture({ outcome: { kind: 'rate-limited', retryAfterSeconds: 420 } });
    const called = await invoke(deps, upgrade({ plan: 'pro_monthly' }));
    assert.equal(called.response.status, 429);
    assert.equal(called.response.headers.get('Retry-After'), '420');
    assert.equal(called.body.error.code, -32029);
    assert.equal(called.body.error.data.reason, 'checkout-rate-limited');
  });

  it('answers relay failure with a retryable 503, never a link', async () => {
    for (const outcome of [{ kind: 'unavailable', cause: 'relay-500' }, new Error('boom')]) {
      const { deps } = fixture({ outcome });
      const called = await invoke(deps, upgrade({ plan: 'pro_monthly' }));
      assert.equal(called.response.status, 503);
      assert.equal(called.response.headers.get('Retry-After'), '5');
      assert.equal(called.body.error.code, -32603);
      assert.equal(called.body.result, undefined);
    }
  });
});

describe('denials raised by dispatch carry the hint', () => {
  it('allowance-exhausted and upgrade-required for a free account', async () => {
    for (const kind of ['pro', 'user_key']) {
      const { deps } = fixture({ planKey: 'free', kind, pipelineOpts: { initialCount: 5 } });
      const exhausted = await invoke(deps, callBody(FREE_ACCOUNT_CACHE_TOOL.name, {}));
      assert.equal(exhausted.body.error.data.reason, 'allowance-exhausted');
      assert.equal(exhausted.body.error.message, 'Free-account MCP allowance exhausted for today.');
      assert.equal(exhausted.body.error.data.recommendedPlan, 'pro_monthly');
      assert.equal(exhausted.body.error.data.checkoutTool, 'start_upgrade');

      const gated = await invoke(fixture({ planKey: 'free', kind }).deps, callBody(SUBSCRIPTION_TOOL.name, {}));
      assert.equal(gated.body.error.data.reason, 'upgrade-required');
      assert.equal(gated.body.error.data.recommendedPlan, 'pro_monthly');
    }
  });

  it('a lapsed paid row on the free allowance is still upgraded as free', async () => {
    const { deps, pipe } = makeProDeps({
      getEntitlements: async () => ({ planKey: 'pro_monthly', features: { tier: 0, mcpAccess: false }, validUntil: 0, billingStatus: 'subscription_lapsed' }),
      pipelineOpts: { initialCount: 5 },
    });
    const exhausted = await invoke(deps, callBody(FREE_ACCOUNT_CACHE_TOOL.name, {}));
    assert.equal(exhausted.body.error.data.reason, 'allowance-exhausted', JSON.stringify(exhausted.body.error));
    assert.equal(exhausted.body.error.data.recommendedPlan, 'pro_monthly');
    assert.ok(pipe.ops.length > 0);
  });

  it('quota-exceeded names the next plan for a capped paid caller and nothing for the top plan', async () => {
    const capped = fixture({ planKey: 'pro_monthly', pipelineOpts: { initialCount: 50 } });
    const denied = await invoke(capped.deps, callBody(FREE_ACCOUNT_CACHE_TOOL.name, {}));
    assert.equal(denied.body.error.data.reason, 'quota-exceeded');
    assert.equal(denied.body.error.message, 'Daily MCP quota exceeded (50/day). Resets at next UTC midnight.');
    assert.equal(denied.body.error.data.recommendedPlan, 'pro_business_monthly');
    assert.equal('checkoutTool' in denied.body.error.data, false);

    const top = fixture({ planKey: 'pro_business_monthly', pipelineOpts: { initialCount: 50 } });
    const topDenied = await invoke(top.deps, callBody(FREE_ACCOUNT_CACHE_TOOL.name, {}));
    assert.equal(topDenied.body.error.data.reason, 'quota-exceeded');
    assert.equal('recommendedPlan' in topDenied.body.error.data, false);
  });

  it('resources/read of a data template carries the same hint as the tool call', async () => {
    // The country-risk template reads a subscription tool, so a free account
    // meets upgrade-required here; a capped Pro caller meets quota-exceeded.
    const { deps } = fixture({ planKey: 'free' });
    const read = await invoke(deps, { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'worldmonitor://countries/us/risk' } });
    assert.equal(read.body.error?.data?.reason, 'upgrade-required', JSON.stringify(read.body.error));
    assert.equal(read.body.error.data.recommendedPlan, 'pro_monthly');
    assert.equal(read.body.error.data.checkoutTool, 'start_upgrade');

    const capped = fixture({ planKey: 'pro_monthly', pipelineOpts: { initialCount: 50 } });
    const quota = await invoke(capped.deps, { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'worldmonitor://countries/us/risk' } });
    assert.equal(quota.body.error?.data?.reason, 'quota-exceeded', JSON.stringify(quota.body.error));
    assert.equal(quota.body.error.data.recommendedPlan, 'pro_business_monthly');
  });
});

describe('allowance after payment', () => {
  it('reports the paid budget on the next call with the same credential', async () => {
    // The entitlement webhook rewrites the cached row; nothing on the MCP side
    // may hold the free verdict past that.
    let paid = false;
    const { deps } = makeProDeps({ getEntitlements: async () => entitlement(paid ? 'pro_monthly' : 'free') });
    const before = await invoke(deps, callBody('get_mcp_allowance', {}));
    assert.equal(before.body.result.structuredContent.access, 'free-account');
    assert.equal(before.body.result.structuredContent.limit, 5);
    paid = true;
    const after = await invoke(deps, callBody('get_mcp_allowance', {}));
    assert.equal(after.body.result.structuredContent.access, 'subscription');
    assert.equal(after.body.result.structuredContent.limit, 50);
  });
});

describe('production checkout relay', () => {
  function relayFixture(response) {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), init });
      if (response instanceof Error) throw response;
      return response;
    };
    return { requests, fetchImpl };
  }

  beforeEach(() => {
    process.env.CONVEX_SITE_URL = 'https://convex.example.site';
    process.env.CONVEX_TENANT_RELAY_SECRET = 'relay-secret';
  });

  it('sends the verified user, the product and the MCP campaign marker to the shared relay', async () => {
    const { requests, fetchImpl } = relayFixture(Response.json({ checkout_url: 'https://checkout.dodopayments.com/s/1' }));
    const outcome = await relayMcpCheckout({ userId: 'user_1', productId: 'pdt_x' }, fetchImpl);
    assert.deepEqual(outcome, { kind: 'created', checkoutUrl: 'https://checkout.dodopayments.com/s/1' });
    assert.equal(requests[0].url, 'https://convex.example.site/relay/create-checkout');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer relay-secret');
    assert.ok(requests[0].init.headers['User-Agent']);
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      userId: 'user_1',
      productId: 'pdt_x',
      attributionSource: MCP_ATTRIBUTION_SOURCE,
    });
  });

  it('classifies every relay answer', async () => {
    const cases = [
      [Response.json({ error: 'ACTIVE_SUBSCRIPTION_EXISTS', message: 'exists', subscription: { planKey: 'pro_monthly', displayName: 'Pro Monthly', status: 'active', currentPeriodEnd: 1 } }, { status: 409 }), 'already-subscribed'],
      [Response.json({ error: 'PAYMENT_IN_PROGRESS', message: 'pending' }, { status: 409 }), 'payment-in-progress'],
      [Response.json({ error: 'CHECKOUT_RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '42' } }), 'rate-limited'],
      [Response.json({ error: 'INVALID_CHECKOUT_PRODUCT' }, { status: 400 }), 'invalid-product'],
      [Response.json({ error: 'Operation failed' }, { status: 500 }), 'unavailable'],
      [Response.json({ error: 'OTHER' }, { status: 409 }), 'unavailable'],
      [Response.json({}), 'unavailable'],
      [Response.json({ checkout_url: 'http://insecure.example/s' }), 'unavailable'],
      [new Response('not json', { status: 200 }), 'unavailable'],
      [new Error('network down'), 'unavailable'],
    ];
    for (const [response, kind] of cases) {
      const { fetchImpl } = relayFixture(response);
      const outcome = await relayMcpCheckout({ userId: 'u', productId: 'p' }, fetchImpl);
      assert.equal(outcome.kind, kind, JSON.stringify(outcome));
      if (kind === 'rate-limited') assert.equal(outcome.retryAfterSeconds, 42);
      if (kind === 'already-subscribed') assert.equal(outcome.subscription.planKey, 'pro_monthly');
    }
  });

  it('does not call out when the relay is unconfigured', async () => {
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_URL;
    const { requests, fetchImpl } = relayFixture(Response.json({}));
    assert.deepEqual(await relayMcpCheckout({ userId: 'u', productId: 'p' }, fetchImpl), { kind: 'unavailable', cause: 'relay-unconfigured' });
    assert.equal(requests.length, 0);
  });
});
