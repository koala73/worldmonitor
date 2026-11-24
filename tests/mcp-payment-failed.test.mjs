// #11213: a subscriber whose renewal payment failed past its access grace is
// paused, not churned. Checkout is blocked while Dodo retries the charge, so
// MCP must point them at the billing portal instead of start_upgrade.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpHandler } from '../api/mcp/handler.ts';
import { getMcpBillingVerificationDenial } from '../api/mcp/auth.ts';
import { applyChatGptCommercePolicy } from '../api/mcp/host-policy.ts';
import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';
import { TRAVEL_RISK_TOOL } from '../api/mcp/registry/_travel-risk-document.ts';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const PORTAL_URL = 'https://www.worldmonitor.app/dashboard?billing=portal';
const CHATGPT_UA = 'openai-mcp/1.0.0';

// The body Convex returns for a paused hold (convex/__tests__/internal-entitlements.test.ts).
const FREE_FEATURES = { tier: 0, mcpAccess: false, apiAccess: false, apiRateLimit: 0, maxDashboards: 3, prioritySupport: false, exportFormats: [] };
const PAUSED = { planKey: 'free', features: FREE_FEATURES, validUntil: 0, billingStatus: 'payment_failed' };
const FREE = { planKey: 'free', features: FREE_FEATURES, validUntil: 0 };
const IN_GRACE_PRO = {
  planKey: 'pro_monthly',
  features: { tier: 1, mcpAccess: true, planLimits: { mcpCallsPerDay: 50 } },
  validUntil: Date.now() + 2 * 86_400_000,
};

const SUBSCRIPTION_TOOL = TOOL_REGISTRY.find((tool) => toolAccess(tool) === 'subscription' && tool.inputSchema.required.length === 0);
const FREE_ACCOUNT_CACHE_TOOL = TOOL_REGISTRY.find((tool) => tool._execute === undefined && toolAccess(tool) === 'free-account' && tool.inputSchema.required.length === 0);

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
beforeEach(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function invoke(entitlement, body, { userAgent, pipelineOpts } = {}) {
  const { deps } = makeProDeps({ getEntitlements: async () => entitlement, pipelineOpts });
  const response = await mcpHandler(proReq('POST', body, userAgent ? { 'User-Agent': userAgent } : {}), deps);
  return { response, body: await response.json() };
}

function assertPaymentFailed(error, label) {
  assert.equal(error.code, -32002, label);
  assert.equal(error.data.reason, 'payment-failed', label);
  assert.equal('checkoutTool' in error.data, false, `${label}: no checkout tool`);
  assert.equal('recommendedPlan' in error.data, false, `${label}: no plan pitch`);
  assert.equal(error.data.upgradeUrl, PORTAL_URL, label);
  assert.ok(error.data.nextStep.includes(PORTAL_URL), `${label}: nextStep names the portal`);
  assert.doesNotMatch(error.message, /https?:\/\//, `${label}: the message carries no URL`);
}

describe('a paused subscriber over MCP', () => {
  it('is refused a Pro-only tool with payment-failed, not an upsell', async () => {
    const { response, body } = await invoke(PAUSED, callBody(SUBSCRIPTION_TOOL.name, {}));
    assert.equal(response.status, 403);
    assertPaymentFailed(body.error, 'subscription tool');
  });

  it('is refused a plan-feature tool with payment-failed', async () => {
    const { response, body } = await invoke(PAUSED, callBody(TRAVEL_RISK_TOOL, {}));
    assert.equal(response.status, 403);
    assertPaymentFailed(body.error, 'travel risk tool');
  });

  it('is refused a Pro-only resource template with payment-failed', async () => {
    const { response, body } = await invoke(PAUSED, { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'worldmonitor://countries/us/risk' } });
    assert.equal(response.status, 403);
    assertPaymentFailed(body.error, 'resources/read');
  });

  it('keeps the free allowance, and its exhaustion points at the portal without a checkout hint', async () => {
    const { response, body } = await invoke(PAUSED, callBody(FREE_ACCOUNT_CACHE_TOOL.name, {}), { pipelineOpts: { initialCount: 5 } });
    assert.equal(response.status, 429);
    assert.equal(body.error.code, -32029);
    assert.equal(body.error.data.reason, 'allowance-exhausted');
    assert.equal('checkoutTool' in body.error.data, false);
    assert.equal('recommendedPlan' in body.error.data, false);
    assert.ok(body.error.data.nextStep.includes(PORTAL_URL), body.error.data.nextStep);
  });

  it('gets inform-only copy on ChatGPT', async () => {
    const { body } = await invoke(PAUSED, callBody(SUBSCRIPTION_TOOL.name, {}), { userAgent: CHATGPT_UA });
    assert.equal(body.error.data.reason, 'payment-failed');
    assert.equal('upgradeUrl' in body.error.data, false);
    assert.equal('checkoutTool' in body.error.data, false);
    assert.doesNotMatch(body.error.data.nextStep, /https?:\/\/|subscribe|checkout|\bbuy\b/i);
    assert.doesNotMatch(body.error.message, /https?:\/\/|subscribe|checkout|\bbuy\b/i);
  });
});

describe('the callers around a paused subscriber keep their own answers', () => {
  it('a free account is still offered start_upgrade for a Pro-only tool', async () => {
    const { response, body } = await invoke(FREE, callBody(SUBSCRIPTION_TOOL.name, {}));
    assert.equal(response.status, 403);
    assert.equal(body.error.data.reason, 'upgrade-required');
    assert.equal(body.error.data.checkoutTool, 'start_upgrade');
  });

  it('a hold still inside its access grace reaches Pro-only tools', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { response, body } = await invoke(IN_GRACE_PRO, callBody('get_country_risk', { country: 'FR' }));
    assert.notEqual(response.status, 403);
    assert.equal(body.error?.data?.reason, undefined, JSON.stringify(body.error));
  });
});

describe('a payment failure that lands during a Pro tool call', () => {
  it('rides the terminal billing envelope with payment-failed attribution', async () => {
    const response = getMcpBillingVerificationDenial({ billingStatus: 'payment_failed' }, {}, 7);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('X-Billing-Verification'), 'payment_failed');
    assert.equal(response.headers.get('Retry-After'), null);
    const body = await response.json();
    assert.equal(body.error.data.code, 'payment_failed');
    assertPaymentFailed(body.error, 'in-flight');
    assert.match(body.error.message, /Re-authenticating will not help/);

    const chatgpt = await (await applyChatGptCommercePolicy(getMcpBillingVerificationDenial({ billingStatus: 'payment_failed' }, {}, 7))).json();
    assert.equal('upgradeUrl' in chatgpt.error.data, false);
    assert.doesNotMatch(chatgpt.error.data.nextStep, /https?:\/\//);
  });
});
