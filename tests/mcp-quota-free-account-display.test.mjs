/**
 * #6716 — the Settings quota endpoint must read the meter that actually
 * enforces the caller's limit.
 *
 * `api/mcp/quota.ts` states the invariant this file defends: `resolveDailyLimit`
 * is exported specifically so the settings-UI reader DISPLAYS exactly the limit
 * the reservation ENFORCES, because a second source of that number is drift.
 * The free-account allowance introduced a second METER — `mcp:free-acct:calls:*`
 * rather than `mcp:pro-usage:*` — so the reader has to pick the meter, not just
 * the number. A reader stuck on the Pro key reports a permanent `used: 0`
 * against a real ceiling, which is the same drift wearing a different hat.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { quotaHandler } from '../api/user/mcp-quota.ts';
import { FREE_ACCOUNT_CALLS_PER_DAY, freeAccountCallsKey } from '../api/mcp/free-account-allowance.ts';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';

const USER = 'user_free_display';
const NOW = new Date(Date.UTC(2026, 7, 17, 12, 0, 0));
const originalEnv = { ...process.env };

const FREE_ENT = {
  planKey: 'free',
  features: { tier: 0, mcpAccess: false, planLimits: { mcpCallsPerDay: 0 } },
  validUntil: NOW.getTime() + 86_400_000,
};
const PRO_ENT = {
  planKey: 'pro',
  features: { tier: 1, mcpAccess: true, planLimits: { mcpCallsPerDay: 50 } },
  validUntil: NOW.getTime() + 86_400_000,
};

function makeDeps(ent, store) {
  const reads = [];
  return {
    reads,
    deps: {
      resolveUserId: async () => USER,
      redisGet: async (key) => { reads.push(key); return store[key] ?? null; },
      getEntitlements: async () => ent,
      now: () => NOW,
    },
  };
}

const req = () => new Request('https://api.worldmonitor.app/api/user/mcp-quota', { method: 'GET' });

beforeEach(() => {
  // A configured backend makes `null`/insufficient-tier a real verdict rather
  // than an unverifiable read.
  process.env.CONVEX_SITE_URL = 'https://stub.convex.site';
  process.env.CONVEX_RELAY_SHARED_SECRET = 'stub-secret';
});

afterEach(() => {
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

describe('GET /api/user/mcp-quota — free-account allowance display (#6716)', () => {
  it('reports the free ceiling and reads the FREE counter, not the Pro one', async () => {
    const freeKey = freeAccountCallsKey(USER, NOW.getTime());
    const { deps, reads } = makeDeps(FREE_ENT, { [freeKey]: '3' });
    const res = await quotaHandler(req(), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.limit, FREE_ACCOUNT_CALLS_PER_DAY, 'the ceiling the meter enforces');
    assert.equal(body.used, 3, 'real usage, not a permanent zero');
    assert.ok(reads.includes(freeKey), 'must read the free-account counter');
    assert.ok(
      !reads.includes(dailyCounterKey(USER, NOW)),
      'must NOT read the Pro counter for a free caller',
    );
  });

  it('does not fall back to the catalog value, which is 0 for free', async () => {
    // The catalog deliberately keeps free at 0 — the allowance is not a plan
    // allowance. If the reader resolved the limit from the catalog it would
    // tell a free user they have no MCP access at all while 5 calls work.
    assert.equal(FREE_ENT.features.planLimits.mcpCallsPerDay, 0);
    const { deps } = makeDeps(FREE_ENT, {});
    const body = await (await quotaHandler(req(), deps)).json();
    assert.equal(body.limit, FREE_ACCOUNT_CALLS_PER_DAY);
    assert.notEqual(body.limit, 0);
  });

  it('a Pro caller still reads the Pro counter and the plan limit', async () => {
    // Blast-radius guard: the branch must key on the entitlement verdict, not
    // fire for everyone.
    const proKey = dailyCounterKey(USER, NOW);
    const { deps, reads } = makeDeps(PRO_ENT, { [proKey]: '12' });
    const body = await (await quotaHandler(req(), deps)).json();
    assert.equal(body.limit, 50);
    assert.equal(body.used, 12);
    assert.ok(reads.includes(proKey));
    assert.ok(!reads.includes(freeAccountCallsKey(USER, NOW.getTime())));
  });

  it('clamps a free counter that overshot its ceiling', async () => {
    const freeKey = freeAccountCallsKey(USER, NOW.getTime());
    const { deps } = makeDeps(FREE_ENT, { [freeKey]: '9' });
    const body = await (await quotaHandler(req(), deps)).json();
    assert.equal(body.used, FREE_ACCOUNT_CALLS_PER_DAY, 'never display "9 / 5"');
  });
});
