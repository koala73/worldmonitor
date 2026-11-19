// Enterprise contract accounts (plan U4) — pooled MCP budget and shared burst.
//
// A member of a live contract carries an `account` block in their entitlement.
// Their MCP calls then charge the ACCOUNT's day key — the same
// `rl:apikey:day:acct:<id>:…` key the gateway charges for every member's REST
// requests — at the tool's weight, and spend the account's per-minute burst
// bucket, which REST shares. Readers show the contract allowance as `limit`
// and the pooled count as `used`. None of this depends on
// API_RATE_LIMIT_ENFORCE, which keeps governing self-serve plans.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Ratelimit } from '@upstash/ratelimit';

import {
  budgetCounterKey,
  memberCounterKey,
  readDailyAllowance,
  reserveQuota,
  resolveAccountMcpBudget,
} from '../api/mcp/quota.ts';
import { quotaHandler } from '../api/user/mcp-quota.ts';
import { apiKeyDailyKey, apiKeyMemberDailyKey, checkBurst } from '../server/_shared/api-key-rate-limit.ts';
import {
  __resetHighUsageAlarmForTests,
  __setHighUsageReporterForTests,
} from '../server/_shared/high-usage-alarm.ts';
import { MCP_QUOTA_RESERVE_SCRIPT } from '../shared/mcp-quota-reserve-script.mjs';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';
import { HMAC_SECRET, PRO_USER_ID, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalWindow = Ratelimit.slidingWindow;

const ACCOUNT = {
  id: 'acct_hexion',
  dailyAllowance: 10_000,
  perMinuteBurst: 300,
  breakerMultiple: 5,
  monthlyInputTokens: 50_000_000,
  monthlyOutputTokens: 5_000_000,
};
const POOL = apiKeyDailyKey('acct:acct_hexion');
const MEMBER = apiKeyMemberDailyKey('acct:acct_hexion', PRO_USER_ID);
const BURST_BUCKET = 'rl:apikey:min:acct:acct_hexion';

function enterpriseEntitlement(account) {
  return {
    planKey: 'enterprise',
    features: {
      tier: 3,
      mcpAccess: true,
      apiAccess: true,
      desktopKeyAccess: false,
      planLimits: {
        apiRequestsPerDay: 10_000,
        apiBurstRequestsPerMinute: 300,
        mcpCallsPerDay: 'shared-api-budget',
        mcpBurstRequestsPerMinute: 300,
      },
    },
    validUntil: Date.now() + 86_400_000,
    ...(account ? { account } : {}),
  };
}

// Key-aware Redis over the reservation EVAL, INCRBY/DECRBY, GET and EXPIRE:
// every counter is asserted by its real key, not a single shared number.
function keyedPipeline(seed = {}) {
  const store = new Map(Object.entries(seed));
  const ops = [];
  const pipeline = async (commands) => {
    ops.push(commands);
    return commands.map((cmd) => {
      const [verb, ...args] = cmd;
      if (verb === 'EVAL' && args[0] === MCP_QUOTA_RESERVE_SCRIPT) {
        const key = args[2];
        const limitRaw = args[4];
        const weight = Number(args[6]) >= 1 ? Number(args[6]) : 1;
        const next = (store.get(key) ?? 0) + weight;
        if (limitRaw !== '' && next > Number(limitRaw)) return { result: [0, store.get(key) ?? 0] };
        store.set(key, next);
        return { result: [1, next] };
      }
      if (verb === 'INCRBY') { store.set(args[0], (store.get(args[0]) ?? 0) + Number(args[1])); return { result: store.get(args[0]) }; }
      if (verb === 'DECRBY') { store.set(args[0], (store.get(args[0]) ?? 0) - Number(args[1])); return { result: store.get(args[0]) }; }
      if (verb === 'GET') return { result: store.has(args[0]) ? String(store.get(args[0])) : null };
      if (verb === 'EXPIRE') return { result: 1 };
      return { result: null };
    });
  };
  return { pipeline, store, ops };
}

function memberDeps(seed, account = ACCOUNT) {
  const { deps } = makeProDeps({ getEntitlements: async () => enterpriseEntitlement(account) });
  const redis = keyedPipeline(seed);
  deps.redisPipeline = redis.pipeline;
  return { deps, redis };
}

// One sliding-window stand-in for every Upstash limiter in the process: the
// MCP per-user limiter and the REST/account `checkBurst` limiter both build
// their Ratelimit through it, so one count map is the one Redis both share.
let windowCounts;
let windowCalls;
let mcpHandler;

before(async () => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  process.env.VERCEL_ENV = 'production';
  Ratelimit.slidingWindow = (tokens, window) => () => ({
    async limit(_ctx, key) {
      const count = (windowCounts.get(key) ?? 0) + 1;
      windowCounts.set(key, count);
      windowCalls.push({ key, tokens, window });
      return { success: count <= tokens, limit: tokens, remaining: Math.max(0, tokens - count), reset: Date.now() + 60_000, pending: Promise.resolve() };
    },
  });
  globalThis.fetch = async () => Response.json({ result: JSON.stringify({ ok: 1 }) });
  mcpHandler = (await import('../api/mcp.ts')).mcpHandler;
});

beforeEach(() => {
  windowCounts = new Map();
  windowCalls = [];
  delete process.env.API_RATE_LIMIT_ENFORCE;
  __resetHighUsageAlarmForTests();
});

afterEach(() => {
  __setHighUsageReporterForTests(null);
});

after(() => {
  Ratelimit.slidingWindow = originalWindow;
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function call(deps, name, args = {}) {
  const response = await mcpHandler(proReq('POST', callBody(name, args)), deps);
  return { response, body: await response.json() };
}

describe('account budget resolution', () => {
  it('pools on acct:<id> at the safety limit, displays the allowance, in either flag state', () => {
    for (const flag of [undefined, 'true', 'false']) {
      if (flag === undefined) delete process.env.API_RATE_LIMIT_ENFORCE;
      else process.env.API_RATE_LIMIT_ENFORCE = flag;
      assert.deepEqual(resolveAccountMcpBudget(ACCOUNT), {
        allowance: 'api',
        counter: 'api',
        limit: 50_000,
        displayAllowance: 10_000,
        account: { id: 'acct_hexion', identity: 'acct:acct_hexion', perMinuteBurst: 300 },
      });
    }
  });

  it('a malformed account block buys nothing', () => {
    for (const bad of [null, undefined, {}, { ...ACCOUNT, id: '' }, { ...ACCOUNT, dailyAllowance: 0 },
      { ...ACCOUNT, perMinuteBurst: 1.5 }, { ...ACCOUNT, breakerMultiple: '5' }]) {
      assert.equal(resolveAccountMcpBudget(bad), null);
    }
  });

  it('the pooled counter is the REST day key, the member key sits beside it', () => {
    const budget = resolveAccountMcpBudget(ACCOUNT);
    const date = new Date(Date.UTC(2026, 10, 6));
    assert.equal(budgetCounterKey(budget, 'user_a', date), 'rl:apikey:day:acct:acct_hexion:2026-11-06');
    assert.equal(memberCounterKey(budget, 'user_a', date), 'rl:apikey:day:acct:acct_hexion:member:user_a:2026-11-06');
    assert.equal(memberCounterKey({ allowance: 'api', counter: 'api', limit: 1000 }, 'user_a', date), '');
  });
});

describe('reserveQuota on an account pool', () => {
  it('charges the tool weight to the pool and the member key in one round-trip', async () => {
    const redis = keyedPipeline({ [POOL]: 100, [MEMBER]: 40 });
    const res = await reserveQuota(PRO_USER_ID, redis.pipeline, resolveAccountMcpBudget(ACCOUNT), 2);
    assert.equal(res.ok, true);
    assert.equal(res.newCount, 102);
    assert.equal(redis.store.get(POOL), 102);
    assert.equal(redis.store.get(MEMBER), 42);
    assert.equal(redis.ops.length, 1, 'pool and member are charged in the same pipeline');
    await res.rollback();
    assert.equal(redis.store.get(POOL), 100);
    assert.equal(redis.store.get(MEMBER), 40);
  });

  it('a failed pool charge releases a member charge that landed and refuses the call', async () => {
    const ops = [];
    const pipeline = async (cmds) => {
      ops.push(cmds);
      if (ops.length === 1) return [{ error: 'ERR' }, { result: 41 }, { result: 1 }];
      return cmds.map(() => ({ result: 40 }));
    };
    const res = await reserveQuota(PRO_USER_ID, pipeline, resolveAccountMcpBudget(ACCOUNT), 1);
    assert.deepEqual(res, { ok: false, reason: 'redis-unavailable' });
    assert.deepEqual(ops.slice(1), [[['DECRBY', MEMBER, 1]]]);
  });

  it('a failed member charge leaves the member key alone on rollback', async () => {
    const ops = [];
    const pipeline = async (cmds) => {
      ops.push(cmds);
      if (ops.length === 1) return [{ result: [1, 101] }, { error: 'ERR' }, { result: 1 }];
      return cmds.map(() => ({ result: 100 }));
    };
    const res = await reserveQuota(PRO_USER_ID, pipeline, resolveAccountMcpBudget(ACCOUNT), 1);
    assert.equal(res.ok, true);
    await res.rollback();
    assert.deepEqual(ops.slice(1), [[['DECRBY', POOL, 1]]]);
  });

  it('at the safety limit the call is rejected and neither key keeps the charge', async () => {
    const redis = keyedPipeline({ [POOL]: 50_000, [MEMBER]: 9_000 });
    const res = await reserveQuota(PRO_USER_ID, redis.pipeline, resolveAccountMcpBudget(ACCOUNT), 1);
    assert.deepEqual(res, { ok: false, reason: 'cap-exceeded', floor: 50_000 });
    assert.equal(redis.store.get(POOL), 50_000);
    assert.equal(redis.store.get(MEMBER), 9_000);
  });
});

describe('a member through mcpHandler', () => {
  it('a weight-2 live tool adds 2 to the account day key and to the member key', async () => {
    const { deps, redis } = memberDeps({ [POOL]: 10, [MEMBER]: 3 });
    const { body } = await call(deps, 'get_country_risk', { country_code: 'FR' });
    assert.notEqual(body.error?.code, -32029);
    assert.equal(redis.store.get(POOL), 12);
    assert.equal(redis.store.get(MEMBER), 5);
    assert.ok(![...redis.store.keys()].some((key) => key.startsWith('mcp:pro-usage:')), 'no dedicated MCP counter is charged');
  });

  it('charges the pool whatever API_RATE_LIMIT_ENFORCE says', async () => {
    for (const flag of ['true', 'false']) {
      process.env.API_RATE_LIMIT_ENFORCE = flag;
      const { deps, redis } = memberDeps({});
      await call(deps, 'get_market_data');
      assert.equal(redis.store.get(POOL), 1, `flag=${flag}`);
    }
  });

  it('at the safety limit MCP is denied as a budget shared with REST', async () => {
    const { deps, redis } = memberDeps({ [POOL]: 50_000 });
    const { response, body } = await call(deps, 'get_market_data');
    assert.equal(response.status, 429);
    assert.equal(body.error.code, -32029);
    assert.equal(body.error.data.reason, 'quota-exceeded');
    assert.equal(body.error.data.sharedWithRestApi, true);
    assert.equal(body.error.data.limit, 50_000);
    assert.equal(redis.store.get(POOL), 50_000);
  });

  it('the safety-limit denial quotes the contract allowance and offers no upgrade', async () => {
    // Mirrors the REST "Daily safety limit reached" 429: `limit` is the
    // safety limit that tripped, `allowance` the contract allowance, and a
    // contract member has no self-serve plan to buy. A member whose winning
    // plan has a step up (api_starter -> api_business) still gets no hint.
    for (const planKey of ['enterprise', 'api_starter']) {
      const { deps } = makeProDeps({ getEntitlements: async () => ({ ...enterpriseEntitlement(ACCOUNT), planKey }) });
      deps.redisPipeline = keyedPipeline({ [POOL]: 50_000 }).pipeline;
      const { response, body } = await call(deps, 'get_market_data');
      assert.equal(response.status, 429, planKey);
      assert.ok(Number(response.headers.get('Retry-After')) > 0, planKey);
      const { data, message } = body.error;
      assert.equal(data.reason, 'quota-exceeded', planKey);
      assert.equal(data.limit, 50_000, planKey);
      assert.equal(data.allowance, 10_000, planKey);
      assert.equal(data.sharedWithRestApi, true, planKey);
      assert.match(message, /account's daily safety limit was reached/, planKey);
      assert.match(message, /UTC midnight/, planKey);
      assert.doesNotMatch(data.nextStep, /upgrade/i, planKey);
      assert.equal('recommendedPlan' in data, false, planKey);
      assert.equal('checkoutTool' in data, false, planKey);
    }
  });

  it('on ChatGPT the safety-limit denial keeps the account nextStep and allowance', async () => {
    const { deps } = memberDeps({ [POOL]: 50_000 });
    const response = await mcpHandler(proReq('POST', callBody('get_market_data'), { 'User-Agent': 'openai-mcp/1.0.0' }), deps);
    const { data } = (await response.json()).error;
    assert.equal(data.allowance, 10_000);
    assert.equal(data.limit, 50_000);
    assert.match(data.nextStep, /safety limit set by the contract/);
    assert.doesNotMatch(data.nextStep, /upgrade|plans/i);
  });

  it('a non-member at its daily cap keeps the plan denial with its upgrade hint (control)', async () => {
    const { deps } = makeProDeps({
      getEntitlements: async () => ({ ...enterpriseEntitlement(undefined), planKey: 'api_starter' }),
      pipelineOpts: { initialCount: 10_000 },
    });
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    const { body } = await call(deps, 'get_market_data');
    assert.equal(body.error?.data?.reason, 'quota-exceeded');
    assert.equal('allowance' in body.error.data, false);
    assert.equal(body.error.data.recommendedPlan, 'api_business');
    assert.match(body.error.message, /^Daily MCP quota exceeded/);
  });

  it('serves past the contract allowance (overage) up to the safety limit', async () => {
    const { deps, redis } = memberDeps({ [POOL]: 10_000 });
    const { body } = await call(deps, 'get_market_data');
    assert.notEqual(body.error?.code, -32029);
    assert.equal(redis.store.get(POOL), 10_001);
  });

  it('get_mcp_allowance reports the contract allowance and the pooled count', async () => {
    const { deps } = memberDeps({ [POOL]: 4_000, [MEMBER]: 25 });
    const { body } = await call(deps, 'get_mcp_allowance');
    assert.equal(body.error, undefined);
    assert.deepEqual(
      (({ access, used, limit, remaining, sharedWithRestApi }) => ({ access, used, limit, remaining, sharedWithRestApi }))(body.result.structuredContent),
      { access: 'subscription', used: 4_000, limit: 10_000, remaining: 6_000, sharedWithRestApi: true },
    );
  });

  it('in overage the allowance shows the pooled count above the limit and nothing remaining', async () => {
    const redis = keyedPipeline({ [POOL]: 12_345 });
    const allowance = await readDailyAllowance(PRO_USER_ID, redis.pipeline, resolveAccountMcpBudget(ACCOUNT));
    assert.equal(allowance.used, 12_345);
    assert.equal(allowance.limit, 10_000);
    assert.equal(allowance.remaining, 0);
  });

  it('member calls never page the self-serve Enterprise high-usage alarm', async () => {
    const reports = [];
    __setHighUsageReporterForTests((_error, opts) => { reports.push(opts); });
    // 25% of the 50,000 safety limit, then of the 10,000 allowance: neither
    // crossing pages for a contract account. The member's dedicated MCP
    // counter is seeded at the same edge, so charging it as a self-serve
    // Enterprise budget would page too.
    for (const seed of [12_499, 2_499]) {
      const { deps } = memberDeps({ [POOL]: seed, [dailyCounterKey(PRO_USER_ID)]: 2_499 });
      await call(deps, 'get_market_data');
    }
    assert.deepEqual(reports, []);

    // Control: the same plan WITHOUT an account still pages.
    const { deps: soloDeps } = makeProDeps({
      getEntitlements: async () => enterpriseEntitlement(undefined),
      pipelineOpts: { initialCount: 2_499 },
    });
    process.env.API_RATE_LIMIT_ENFORCE = 'true';
    await call(soloDeps, 'get_market_data');
    assert.equal(reports.length, 1);
  });
});

describe('AE3: one per-minute bucket across REST and MCP', () => {
  it('200 REST + 100 MCP calls fill the 300 bucket; the 301st of either kind is rejected', async () => {
    const { deps } = memberDeps({});
    // The REST door: the gateway calls exactly checkBurst(300, 'acct:<id>')
    // for every member key (server/__tests__/gateway-enterprise-account.test.ts).
    for (let i = 0; i < 200; i++) {
      assert.deepEqual(await checkBurst(300, 'acct:acct_hexion'), { ok: true }, `REST ${i + 1}`);
    }
    for (let i = 0; i < 100; i++) {
      const { body } = await call(deps, 'get_market_data');
      assert.notEqual(body.error?.code, -32029, `MCP ${i + 1}`);
    }
    const mcpDenied = await call(deps, 'get_market_data');
    assert.equal(mcpDenied.body.error?.code, -32029);
    assert.match(mcpDenied.body.error.message, /300 requests per minute per account/);
    assert.equal(mcpDenied.response.headers.get('X-RateLimit-Limit'), '300');
    const restDenied = await checkBurst(300, 'acct:acct_hexion');
    assert.equal(restDenied.ok, false);

    const accountCalls = windowCalls.filter((c) => c.key === BURST_BUCKET);
    assert.equal(accountCalls.length, 302, 'every REST and MCP call hit the one account bucket');
    assert.ok(accountCalls.every((c) => c.tokens === 300));
    assert.ok(!windowCalls.some((c) => c.key.startsWith('rl:mcp:pro-min:pro-user:')), 'the per-user MCP bucket is not used');
  });

  it('protocol-only calls keep their own protocol bucket', async () => {
    const { deps } = memberDeps({});
    await call(deps, 'get_mcp_allowance');
    assert.deepEqual(windowCalls.map((c) => c.key), [`rl:mcp:pro-min:pro-protocol:${PRO_USER_ID}`]);
  });

  it('a non-member keeps the per-user MCP bucket', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => enterpriseEntitlement(undefined) });
    await call(deps, 'get_market_data');
    assert.deepEqual(windowCalls.map((c) => c.key), [`rl:mcp:pro-min:pro-user:${PRO_USER_ID}`]);
  });
});

describe('member protocol traffic never spends the account burst', () => {
  const ACCOUNT_KEYS = (calls) => calls.filter((c) => c.key === BURST_BUCKET);
  const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

  it('initialize, tools/list, ping, resources/list and prompts/list stay off acct:<id>', async () => {
    for (const [method, params] of [
      ['initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }],
      ['tools/list', undefined],
      ['ping', undefined],
      ['resources/list', undefined],
      ['prompts/list', undefined],
    ]) {
      windowCalls = [];
      const { deps } = memberDeps({});
      const response = await mcpHandler(proReq('POST', rpc(method, params)), deps);
      assert.ok(response.status < 400, `${method} -> ${response.status}`);
      assert.deepEqual(ACCOUNT_KEYS(windowCalls), [], method);
    }
  });

  it('account status reads, describe_tool and SSE replay GET use the per-user limiter, not acct:<id>', async () => {
    const cases = [
      ['resources/read account status', () => proReq('POST', rpc('resources/read', { uri: 'worldmonitor://account/mcp-allowance' }))],
      ['describe_tool', () => proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' }))],
      ['SSE replay GET', () => proReq('GET', null, { Accept: 'text/event-stream', 'Last-Event-ID': 'stream-x:1', 'Mcp-Session-Id': 'sess-x' })],
    ];
    for (const [label, req] of cases) {
      windowCalls = [];
      const { deps } = memberDeps({});
      await mcpHandler(req(), deps);
      assert.deepEqual(ACCOUNT_KEYS(windowCalls), [], label);
      assert.ok(windowCalls.some((c) => c.key.startsWith('rl:mcp:pro-min:pro-')), `${label} still meets a per-user limiter`);
    }
  });

  it('a data tools/call and a data resources/read do spend acct:<id>', async () => {
    for (const [label, body] of [
      ['tools/call', callBody('get_market_data')],
      ['resources/read data template', rpc('resources/read', { uri: 'worldmonitor://countries/de/risk' })],
    ]) {
      windowCalls = [];
      const { deps } = memberDeps({});
      await mcpHandler(proReq('POST', body), deps);
      assert.equal(ACCOUNT_KEYS(windowCalls).length, 1, label);
      assert.equal(ACCOUNT_KEYS(windowCalls)[0].tokens, 300, label);
    }
  });
});

describe('usage events attribute pooled MCP calls', () => {
  async function usageOf(deps) {
    const events = [];
    const pending = [];
    const stub = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('axiom.co')) {
        for (const ev of JSON.parse(init.body)) events.push(ev);
        return new Response('{}', { status: 200 });
      }
      return stub(url, init);
    };
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'stub-token';
    try {
      const response = await mcpHandler(proReq('POST', callBody('get_market_data')), deps, { waitUntil: (p) => pending.push(p) });
      await Promise.allSettled(pending);
      assert.ok(response.status < 400, `status ${response.status}`);
    } finally {
      globalThis.fetch = stub;
      delete process.env.USAGE_TELEMETRY;
      delete process.env.AXIOM_API_TOKEN;
    }
    const calls = events.filter((ev) => ev.tool_name === 'get_market_data');
    assert.equal(calls.length, 1);
    return [calls[0].account_id, calls[0].overage];
  }

  it('[id,false] at the allowance, [id,true] one past it, [null,null] for a non-member', async () => {
    assert.deepEqual(await usageOf(memberDeps({ [POOL]: 9_999 }).deps), ['acct_hexion', false]);
    assert.deepEqual(await usageOf(memberDeps({ [POOL]: 10_000 }).deps), ['acct_hexion', true]);
    const { deps } = makeProDeps({ getEntitlements: async () => enterpriseEntitlement(undefined) });
    assert.deepEqual(await usageOf(deps), [null, null]);
  });
});

describe('api/user/mcp-quota for a member', () => {
  it('shows the contract allowance and the pooled count, shared with REST', async () => {
    const reads = [];
    const res = await quotaHandler(new Request('https://www.worldmonitor.app/api/user/mcp-quota'), {
      resolveUserId: async () => PRO_USER_ID,
      redisGet: async (key) => { reads.push(key); return '11500'; },
      getEntitlements: async () => enterpriseEntitlement(ACCOUNT),
      now: () => new Date(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(reads, [POOL]);
    assert.equal(body.limit, 10_000);
    assert.equal(body.used, 11_500);
    assert.equal(body.sharedWithRestApi, true);
  });
});
