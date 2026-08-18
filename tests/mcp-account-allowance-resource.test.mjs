import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { mcpHandler } from '../api/mcp/handler.ts';
import {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
  freeAccountCallsKey,
  freeAccountLastActivityKey,
  freeAccountRequestsKey,
} from '../api/mcp/free-account-allowance.ts';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';
import {
  BASE_URL,
  HMAC_SECRET,
  PRO_USER_ID,
  makeProDeps,
  proReq,
} from './helpers/mcp-pro-deps.mjs';

const URI = 'worldmonitor://account/mcp-allowance';
const originalEnv = { ...process.env };

function readBody(id = 301) {
  return { jsonrpc: '2.0', id, method: 'resources/read', params: { uri: URI } };
}

function pipelineFrom(values, observed) {
  return async (commands) => {
    observed.push(...commands);
    return commands.map(([op, key]) => {
      if (op === 'GET') return { result: values[key] ?? null };
      if (op === 'PTTL') return { result: values[`${key}:pttl`] ?? -2 };
      if (op === 'EVAL') {
        const command = commands.find((candidate) => candidate[0] === 'EVAL');
        const callsKey = command?.[3];
        const requestsKey = command?.[4];
        const activityKey = command?.[5];
        return {
          result: [
            values[callsKey] ?? null,
            values[requestsKey] ?? null,
            values[`${activityKey}:pttl`] ?? -2,
          ],
        };
      }
      return { result: null };
    });
  };
}

beforeEach(() => {
  process.env.MCP_TELEMETRY = 'false';
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.CONVEX_SITE_URL = 'https://stub.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'stub-secret';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

describe('authenticated MCP allowance resource', () => {
  it('is discovered only by a user-bound authenticated client', async () => {
    const { deps } = makeProDeps();
    const authenticated = await mcpHandler(proReq('POST', {
      jsonrpc: '2.0', id: 1, method: 'resources/list', params: {},
    }), deps);
    const authenticatedBody = await authenticated.json();
    const resource = authenticatedBody.result.resources.find((entry) => entry.uri === URI);
    assert.ok(resource, 'authenticated resources/list must expose the allowance status URI');
    assert.equal(resource._meta?.['worldmonitor/access'], 'free-account');

    const anonymous = await mcpHandler(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} }),
    }), deps);
    const anonymousBody = await anonymous.json();
    assert.equal(
      anonymousBody.result.resources.some((entry) => entry.uri === URI),
      false,
      'anonymous clients must not be invited to read an account-specific resource',
    );
  });

  it('reports Pro allowance without reserving or dispatching a tool call', async () => {
    const observed = [];
    const startedAt = Date.now();
    const now = new Date(startedAt);
    const key = dailyCounterKey(PRO_USER_ID, now);
    const { deps } = makeProDeps({
      getEntitlements: async () => ({
        planKey: 'pro',
        features: { tier: 1, mcpAccess: true, planLimits: { mcpCallsPerDay: 50 } },
        validUntil: startedAt + 86_400_000,
      }),
    });
    deps.redisPipeline = pipelineFrom({ [key]: '7' }, observed);

    const res = await mcpHandler(proReq('POST', readBody()), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    const status = JSON.parse(body.result.contents[0].text);
    assert.equal(status.access, 'subscription');
    assert.equal(status.used, 7);
    assert.equal(status.limit, 50);
    assert.equal(status.remaining, 43);
    assert.equal(status.requestWindows, null);
    const expectedReset = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
    )).toISOString();
    assert.equal(status.resetsAt, expectedReset);
    assert.ok(observed.some(([op, observedKey]) => op === 'GET' && observedKey === key));
    assert.equal(observed.some(([op]) => op === 'INCR'), false, 'status reads must be quota-exempt');
  });

  it('reports the free-account call and request-window counters without consuming either', async () => {
    const observed = [];
    const startedAt = Date.now();
    const callsKey = freeAccountCallsKey(PRO_USER_ID, startedAt);
    const requestsKey = freeAccountRequestsKey(PRO_USER_ID, startedAt);
    const activityKey = freeAccountLastActivityKey(PRO_USER_ID, startedAt);
    const { deps } = makeProDeps({
      getEntitlements: async () => ({
        planKey: 'free',
        features: { tier: 0, mcpAccess: false, planLimits: { mcpCallsPerDay: 0 } },
        validUntil: startedAt + 86_400_000,
      }),
    });
    deps.redisPipeline = pipelineFrom({
      [callsKey]: '3',
      [requestsKey]: '2',
      [`${activityKey}:pttl`]: 600_000,
    }, observed);

    const res = await mcpHandler(proReq('POST', readBody(302)), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    const status = JSON.parse(body.result.contents[0].text);
    assert.equal(status.access, 'free-account');
    assert.equal(status.used, 3);
    assert.equal(status.limit, FREE_ACCOUNT_CALLS_PER_DAY);
    assert.equal(status.remaining, 2);
    assert.deepEqual(
      { ...status.requestWindows, expiresAt: undefined },
      {
        used: 2,
        limit: FREE_ACCOUNT_REQUESTS_PER_DAY,
        remaining: 1,
        idleGapMs: FREE_ACCOUNT_IDLE_GAP_MS,
        active: true,
        expiresAt: undefined,
      },
    );
    const expiresAt = Date.parse(status.requestWindows.expiresAt);
    assert.ok(expiresAt >= startedAt + 599_000 && expiresAt <= Date.now() + 600_100);
    assert.equal(observed.length, 1, 'free-account status must use one coherent Redis read');
    assert.equal(observed[0][0], 'EVAL');
    assert.equal(observed.some(([op]) => op === 'INCR' || op === 'DECR' || op === 'SET'), false);
  });

  it('reports a first-use free account with full allowance and no active request window', async () => {
    const observed = [];
    const startedAt = Date.now();
    const { deps } = makeProDeps({
      getEntitlements: async () => ({
        planKey: 'free',
        features: { tier: 0, mcpAccess: false, planLimits: { mcpCallsPerDay: 0 } },
        validUntil: startedAt + 86_400_000,
      }),
    });
    deps.redisPipeline = pipelineFrom({}, observed);

    const res = await mcpHandler(proReq('POST', readBody(303)), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    const status = JSON.parse(body.result.contents[0].text);
    assert.equal(status.used, 0);
    assert.equal(status.remaining, FREE_ACCOUNT_CALLS_PER_DAY);
    assert.deepEqual(status.requestWindows, {
      used: 0,
      limit: FREE_ACCOUNT_REQUESTS_PER_DAY,
      remaining: FREE_ACCOUNT_REQUESTS_PER_DAY,
      idleGapMs: FREE_ACCOUNT_IDLE_GAP_MS,
      active: false,
      expiresAt: null,
    });
    assert.deepEqual(observed.map(([op]) => op), ['EVAL']);
  });

  it('rejects an anonymous account-status read', async () => {
    const { deps } = makeProDeps();
    const req = new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readBody(304)),
    });
    const res = await mcpHandler(req, deps);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error?.code, -32001);
  });

  it('fails closed when an enforcement counter contains malformed state', async () => {
    const observed = [];
    const startedAt = Date.now();
    const key = dailyCounterKey(PRO_USER_ID, new Date(startedAt));
    const { deps } = makeProDeps({
      getEntitlements: async () => ({
        planKey: 'pro',
        features: { tier: 1, mcpAccess: true, planLimits: { mcpCallsPerDay: 50 } },
        validUntil: startedAt + 86_400_000,
      }),
    });
    deps.redisPipeline = pipelineFrom({ [key]: 'not-a-counter' }, observed);

    const res = await mcpHandler(proReq('POST', readBody(305)), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32603);
    assert.match(body.error?.message ?? '', /temporarily unavailable/i);
  });

  it('fails closed on a missing Redis result or an impossible free-account tuple', async () => {
    const startedAt = Date.now();
    const entitlement = async () => ({
      planKey: 'free',
      features: { tier: 0, mcpAccess: false, planLimits: { mcpCallsPerDay: 0 } },
      validUntil: startedAt + 86_400_000,
    });

    for (const [label, redisPipeline] of [
      ['missing result', async () => [{}]],
      ['partial tuple', async () => [{ result: ['1', null, -2] }]],
      ['request count above call count', async () => [{ result: ['0', '1', 60_000] }]],
      ['active window without any call', async () => [{ result: [null, null, 60_000] }]],
    ]) {
      const { deps } = makeProDeps({ getEntitlements: entitlement });
      deps.redisPipeline = redisPipeline;
      const res = await mcpHandler(proReq('POST', readBody(306)), deps);
      assert.equal(res.status, 200, label);
      const body = await res.json();
      assert.equal(body.error?.code, -32603, label);
    }
  });
});
