/**
 * ChatGPT's app guidelines forbid an app from starting a checkout, linking to
 * one, or promoting an upgrade. They allow saying a feature is not on the
 * user's current plan and linking a page that describes the plans
 * (https://developers.openai.com/apps-sdk/app-submission-guidelines).
 *
 * So a request from ChatGPT gets no `start_upgrade` tool, no checkout hint in
 * denials, and denial copy that states the plan fact without telling the
 * agent to subscribe. Every other client, Codex included, keeps the in-flow
 * upgrade from #9144 unchanged.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpHandler } from '../api/mcp/handler.ts';
import { getMcpBillingVerificationDenial, mcpStructuredDenialResponse } from '../api/mcp/auth.ts';
import {
  CHATGPT_MODERN_SERVER_INSTRUCTIONS,
  CHATGPT_SERVER_INSTRUCTIONS,
  MODERN_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS,
} from '../api/mcp/constants.ts';
import { applyChatGptCommercePolicy, isChatGptHost } from '../api/mcp/host-policy.ts';
import { CHATGPT_TOOL_LIST_RESPONSE, TOOL_LIST_RESPONSE, TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';
import { MCP_UPGRADE_URL } from '../shared/mcp-attribution.ts';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const CHATGPT_UA = 'openai-mcp/1.0.0';
// Words that sell rather than inform. `upgradeUrl` is a field name, so the
// check runs on copy, never on keys.
const SELLING = /subscribe|upgrade (?:to|at)|upgrade:|checkout|start_upgrade|recommendedPlan|checkoutTool|purchase|\bbuy\b/i;

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

const entitlement = (planKey) => ({
  planKey,
  features: { tier: planKey === 'free' ? 0 : 1, mcpAccess: planKey !== 'free', planLimits: { mcpCallsPerDay: planKey === 'free' ? 0 : 50 } },
  validUntil: Date.now() + 86_400_000,
});

function fixture({ planKey = 'free', pipelineOpts } = {}) {
  const checkouts = [];
  const { deps } = makeProDeps({ getEntitlements: async () => entitlement(planKey), pipelineOpts });
  deps.createCheckout = async (input) => {
    checkouts.push(input);
    return { kind: 'created', checkoutUrl: 'https://checkout.dodopayments.com/session/cks_test' };
  };
  return { deps, checkouts };
}

async function invoke(deps, body, userAgent) {
  const response = await mcpHandler(proReq('POST', body, userAgent ? { 'User-Agent': userAgent } : {}), deps);
  return { response, body: await response.json() };
}

const FREE_ACCOUNT_CACHE_TOOL = TOOL_REGISTRY.find((tool) => tool._execute === undefined && toolAccess(tool) === 'free-account' && tool.inputSchema.required.length === 0);
const SUBSCRIPTION_TOOL = TOOL_REGISTRY.find((tool) => toolAccess(tool) === 'subscription' && tool.inputSchema.required.length === 0);

function assertInformsOnly(error, label) {
  assert.equal(error.data.upgradeUrl, MCP_UPGRADE_URL, `${label}: the plans page link stays`);
  assert.equal('recommendedPlan' in error.data, false, `${label}: no plan pitch`);
  assert.equal('checkoutTool' in error.data, false, `${label}: no checkout tool`);
  assert.doesNotMatch(error.data.nextStep, SELLING, `${label}: nextStep`);
  assert.doesNotMatch(error.message, SELLING, `${label}: message`);
}

describe('ChatGPT host detection', () => {
  it('matches ChatGPT user agents and leaves Codex and other clients alone', () => {
    const req = (ua) => new Request('https://worldmonitor.app/mcp', { headers: ua === null ? {} : { 'User-Agent': ua } });
    // Seen in wm_api_usage: plain and "(ChatGPT)" from ChatGPT, "(Codex)" from the Codex CLI.
    for (const ua of ['openai-mcp/1.0.0', 'openai-mcp/1.0.0 (ChatGPT)', 'OpenAI-MCP/2.0']) assert.equal(isChatGptHost(req(ua)), true, ua);
    for (const ua of ['openai-mcp/1.0.0 (Codex)', 'Claude-User', 'Cursor/1.0.0', 'python-httpx/0.28.1', 'my-openai-mcp/1.0', '', null]) {
      assert.equal(isChatGptHost(req(ua)), false, String(ua));
    }
  });
});

describe('what ChatGPT is offered', () => {
  it('tools/list leaves out start_upgrade for ChatGPT only', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const names = async (ua) => (await invoke(fixture().deps, list, ua)).body.result.tools.map((tool) => tool.name);
    assert.equal((await names(CHATGPT_UA)).includes('start_upgrade'), false);
    assert.equal((await names('openai-mcp/1.0.0 (Codex)')).includes('start_upgrade'), true);
    assert.equal((await names('Claude-User')).includes('start_upgrade'), true);
    assert.equal((await names(undefined)).includes('start_upgrade'), true);
  });

  it('every other tool is listed to ChatGPT, with no selling copy anywhere in the list', () => {
    assert.deepEqual(
      CHATGPT_TOOL_LIST_RESPONSE.map((tool) => tool.name),
      TOOL_LIST_RESPONSE.map((tool) => tool.name).filter((name) => name !== 'start_upgrade'),
    );
    for (const tool of CHATGPT_TOOL_LIST_RESPONSE) {
      assert.doesNotMatch(JSON.stringify(tool), SELLING, tool.name);
    }
  });

  it('initialize and server/discover instructions drop the checkout flow for ChatGPT', async () => {
    for (const text of [CHATGPT_SERVER_INSTRUCTIONS, CHATGPT_MODERN_SERVER_INSTRUCTIONS]) {
      assert.doesNotMatch(text, SELLING);
      assert.ok(text.includes(MCP_UPGRADE_URL), 'the plans page is still named');
    }
    // Everyone else keeps the documented checkout flow.
    for (const text of [SERVER_INSTRUCTIONS, MODERN_SERVER_INSTRUCTIONS]) assert.match(text, /start_upgrade\(\{plan: recommendedPlan\}\)/);

    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1.0.0' } } };
    assert.equal((await invoke(fixture().deps, init, CHATGPT_UA)).body.result.instructions, CHATGPT_SERVER_INSTRUCTIONS);
    assert.equal((await invoke(fixture().deps, init, 'Claude-User')).body.result.instructions, SERVER_INSTRUCTIONS);
  });

  it('start_upgrade called from ChatGPT is an unknown tool and opens no checkout', async () => {
    const { deps, checkouts } = fixture();
    const called = await invoke(deps, callBody('start_upgrade', { plan: 'pro_monthly' }), CHATGPT_UA);
    assert.equal(called.body.error?.code, -32602);
    assert.match(called.body.error.message, /^Unknown tool: start_upgrade/);
    assert.equal(checkouts.length, 0);

    const other = fixture();
    const allowed = await invoke(other.deps, callBody('start_upgrade', { plan: 'pro_monthly' }), 'Claude-User');
    assert.equal(allowed.body.result?.structuredContent?.plan, 'pro_monthly', JSON.stringify(allowed.body));
    assert.equal(other.checkouts.length, 1);
  });

  it('describe_tool does not reveal start_upgrade to ChatGPT', async () => {
    const described = await invoke(fixture().deps, callBody('describe_tool', { tool_name: 'start_upgrade' }), CHATGPT_UA);
    const result = described.body.result.structuredContent;
    assert.equal(result.error, 'unknown_tool', JSON.stringify(described.body));
    assert.equal(result.available.includes('start_upgrade'), false);
    assert.ok(result.available.includes('describe_tool'));

    const elsewhere = await invoke(fixture().deps, callBody('describe_tool', { tool_name: 'start_upgrade' }), 'Claude-User');
    assert.equal(elsewhere.body.result.structuredContent.name, 'start_upgrade');
  });

  it('describe_tool shows ChatGPT the same schema copy tools/list does', async () => {
    const described = await invoke(fixture().deps, callBody('describe_tool', { tool_name: 'get_market_data' }), CHATGPT_UA);
    const tool = described.body.result.structuredContent;
    assert.equal(tool.name, 'get_market_data', JSON.stringify(described.body).slice(0, 300));
    assert.doesNotMatch(JSON.stringify(tool), SELLING);
    assert.deepEqual(tool.outputSchema, CHATGPT_TOOL_LIST_RESPONSE.find((entry) => entry.name === 'get_market_data').outputSchema);

    const elsewhere = await invoke(fixture().deps, callBody('describe_tool', { tool_name: 'get_market_data' }), 'Claude-User');
    assert.match(JSON.stringify(elsewhere.body.result.structuredContent), /Upgrade at upgradeUrl/);
  });
});

describe('denials sent to ChatGPT inform without selling', () => {
  it('allowance-exhausted and upgrade-required for a free account', async () => {
    const exhausted = await invoke(fixture({ pipelineOpts: { initialCount: 5 } }).deps, callBody(FREE_ACCOUNT_CACHE_TOOL.name, {}), CHATGPT_UA);
    assert.equal(exhausted.body.error.data.reason, 'allowance-exhausted', JSON.stringify(exhausted.body.error));
    assertInformsOnly(exhausted.body.error, 'allowance-exhausted');

    const gated = await invoke(fixture().deps, callBody(SUBSCRIPTION_TOOL.name, {}), CHATGPT_UA);
    assert.equal(gated.body.error.data.reason, 'upgrade-required');
    assertInformsOnly(gated.body.error, 'upgrade-required');
    assert.match(gated.body.error.data.nextStep, /not included in the current plan/);

    // The same request from Claude keeps the #9144 hint.
    const claude = await invoke(fixture().deps, callBody(SUBSCRIPTION_TOOL.name, {}), 'Claude-User');
    assert.equal(claude.body.error.data.checkoutTool, 'start_upgrade');
  });

  it('quota-exceeded keeps its documented message and limit', async () => {
    const denied = await invoke(fixture({ planKey: 'pro_monthly', pipelineOpts: { initialCount: 50 } }).deps, callBody(FREE_ACCOUNT_CACHE_TOOL.name, {}), CHATGPT_UA);
    assert.equal(denied.body.error.data.reason, 'quota-exceeded');
    assert.equal(denied.body.error.message, 'Daily MCP quota exceeded (50/day). Resets at next UTC midnight.');
    assert.equal(denied.body.error.data.limit, 50);
    assertInformsOnly(denied.body.error, 'quota-exceeded');
  });

  it('resources/read of a data template is covered too', async () => {
    const read = await invoke(fixture().deps, { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'worldmonitor://countries/us/risk' } }, CHATGPT_UA);
    assert.equal(read.body.error?.data?.reason, 'upgrade-required', JSON.stringify(read.body.error));
    assertInformsOnly(read.body.error, 'resources/read');
  });

  it('auth-layer denials: no-account, the API-plan gate and a confirmed lapse', async () => {
    const chatgpt = (response) => applyChatGptCommercePolicy(response);
    const noAccount = await (await chatgpt(mcpStructuredDenialResponse('no-account', 'https://worldmonitor.app/.well-known/oauth-protected-resource', {}, 1))).json();
    assertInformsOnly(noAccount.error, 'no-account');

    const apiPlan = await (await chatgpt(mcpStructuredDenialResponse('upgrade-required', 'https://x', {}, 1, {
      code: -32002,
      status: 403,
      message: 'API access subscription required. MCP with an API key needs an active API plan; a desktop key or a Pro-only account cannot use it. Upgrade at https://worldmonitor.app/pricing.',
    }))).json();
    assertInformsOnly(apiPlan.error, 'api-plan gate');
    assert.match(apiPlan.error.message, /needs an active API plan/);

    const lapsed = await (await chatgpt(getMcpBillingVerificationDenial({ billingStatus: 'subscription_lapsed' }, {}, 1))).json();
    assert.equal(lapsed.error.data.reason, 'lapsed-subscription');
    assertInformsOnly(lapsed.error, 'lapsed');
    // The clause that stops an OAuth retry loop survives the rewrite.
    assert.match(lapsed.error.message, /Re-authenticating will not help/);
    assert.match(lapsed.error.data.nextStep, /re-authenticating will not restore access/);
  });

  it('leaves non-denial responses byte-identical', async () => {
    const ok = new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }), { headers: { 'Content-Type': 'application/json' } });
    const out = await applyChatGptCommercePolicy(ok.clone());
    assert.equal(await out.text(), await ok.text());
  });
});
