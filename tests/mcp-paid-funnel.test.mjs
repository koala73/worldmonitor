/**
 * #6716 — MCP paid-funnel: structured denials, free-account allowance, and the
 * checkProMcpAccess landmine (other four callers must still refuse free).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkProMcpAccess } from '../server/_shared/pro-mcp-gate.ts';
import {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
} from '../api/mcp/upgrade-constants.ts';
import {
  reserveFreeAccountAllowance,
  freeAccountCallsKey,
  freeAccountRequestsKey,
  freeAccountLastActivityKey,
} from '../api/mcp/free-account-allowance.ts';
import {
  buildMcpStructuredDenial,
  MCP_UPGRADE_URL,
  MCP_ATTRIBUTION_SOURCE,
  normalizeCheckoutAttributionSource,
} from '../api/mcp/upgrade.ts';
import { HMAC_SECRET, PRO_USER_ID, PRO_TOKEN_ID, makeProDeps } from './helpers/mcp-pro-deps.mjs';

const RESOURCE_META_URL = 'https://worldmonitor.app/.well-known/oauth-protected-resource';
const CORS = { 'Access-Control-Allow-Origin': '*' };
const FREE_ENT = {
  planKey: 'free',
  features: { tier: 0, mcpAccess: false, planLimits: { mcpCallsPerDay: 5 } },
  validUntil: Date.now() + 86_400_000,
};
const LAPSED_ENT = {
  planKey: 'pro',
  features: { tier: 0, mcpAccess: false },
  validUntil: 0,
  billingStatus: 'subscription_lapsed',
};

const originalEnv = { ...process.env };
let authMod;
let bust = 0;

async function loadAuth() {
  bust += 1;
  return import(`../api/mcp/auth.ts?paid=${bust}-${Date.now()}`);
}

beforeEach(async () => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  authMod = await loadAuth();
});

afterEach(() => {
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

describe('MCP upgrade attribution constants', () => {
  it('upgrade URL carries the paid-funnel UTM campaign', () => {
    assert.match(MCP_UPGRADE_URL, /utm_source=mcp/);
    assert.match(MCP_UPGRADE_URL, /utm_campaign=mcp-paid-funnel/);
  });

  it('normalizeCheckoutAttributionSource allowlists only the MCP marker', () => {
    assert.equal(normalizeCheckoutAttributionSource(MCP_ATTRIBUTION_SOURCE), MCP_ATTRIBUTION_SOURCE);
    assert.equal(normalizeCheckoutAttributionSource('welcome-hero'), undefined);
    assert.equal(normalizeCheckoutAttributionSource('seo-country'), undefined);
  });

  it('structured denials expose reason + nextStep + upgradeUrl', () => {
    for (const reason of ['no-account', 'allowance-exhausted', 'lapsed-subscription']) {
      const { message, data } = buildMcpStructuredDenial(reason);
      assert.ok(message.length > 0);
      assert.equal(data.reason, reason);
      assert.ok(data.nextStep.length > 0);
      assert.equal(data.upgradeUrl, MCP_UPGRADE_URL);
    }
  });
});

describe('checkProMcpAccess landmine — other surfaces still refuse free', () => {
  it('free entitlement is insufficient_tier (not null)', () => {
    const gate = checkProMcpAccess(FREE_ENT, Date.now());
    assert.deepEqual(gate, { kind: 'insufficient_tier' });
  });

  it('lapsed billing status is billing_verification, not free allowance', () => {
    const gate = checkProMcpAccess(LAPSED_ENT, Date.now());
    assert.equal(gate?.kind, 'billing_verification');
    assert.equal(gate?.denial?.code, 'subscription_lapsed');
  });
});

describe('MCP call-site free-account reinterpretation', () => {
  it('pro context with free entitlement is admitted with freeAccountAllowance', async () => {
    const { deps } = makeProDeps({
      getEntitlements: async () => FREE_ENT,
      validateProMcpToken: async () => ({ ok: 'valid', userId: PRO_USER_ID }),
    });
    const result = await authMod.runProPreChecks(
      { kind: 'pro', userId: PRO_USER_ID, mcpTokenId: PRO_TOKEN_ID },
      deps,
      RESOURCE_META_URL,
      CORS,
    );
    assert.equal(result.ok, true);
    assert.equal(result.freeAccountAllowance, true);
    assert.equal(result.mcpDailyLimit, FREE_ACCOUNT_CALLS_PER_DAY);
  });

  it('lapsed entitlement returns structured lapsed-subscription denial', async () => {
    const { deps } = makeProDeps({
      getEntitlements: async () => LAPSED_ENT,
      validateProMcpToken: async () => ({ ok: 'valid', userId: PRO_USER_ID }),
    });
    const result = await authMod.runProPreChecks(
      { kind: 'pro', userId: PRO_USER_ID, mcpTokenId: PRO_TOKEN_ID },
      deps,
      RESOURCE_META_URL,
      CORS,
    );
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 403);
    const body = await result.response.json();
    assert.equal(body.error?.code, -32002);
    assert.equal(body.error?.data?.code, 'subscription_lapsed');
    assert.equal(body.error?.data?.reason, 'lapsed-subscription');
    assert.equal(body.error?.data?.upgradeUrl, MCP_UPGRADE_URL);
  });
});

