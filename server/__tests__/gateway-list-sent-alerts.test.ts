// @vitest-environment node

/**
 * /api/news/v1/list-sent-alerts is account-private: it returns the alerts the
 * relay delivered to one user. These tests drive the real gateway, the real
 * entitlement gate and the real handler, so they cover the path a handler-only
 * test cannot: where the handler's user id comes from.
 *
 *   - The id is the one the gateway authenticated. A client copy of the
 *     trusted `x-user-id` header is stripped, so user A cannot read user B.
 *   - An anonymous caller, a signed-in free account and an operator key with no
 *     user never reach a read.
 *   - Only a signed-in session is the account. A `wm_` key never selects
 *     whose alerts are read: not next to another user's session (a desktop
 *     holding user A's key while user B is signed in), and not alone (the same
 *     desktop forwards no bearer for a signed-in user who is not Pro).
 *   - The response is `no-store`.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'shared-secret';
});

// Every alert-history key the handler read.
const historyReads: string[] = [];
const readCachedJsonList = vi.fn();
vi.mock('../_shared/redis', async (importActual) => {
  const actual = await importActual<typeof import('../_shared/redis')>();
  return {
    ...actual,
    // Entitlements: always a cache miss, so the gate asks the Convex stub below.
    getCachedJson: vi.fn().mockResolvedValue(null),
    setCachedJson: vi.fn().mockResolvedValue(true),
    // The link block list is empty; other pipeline callers get no answer.
    runRedisPipeline: vi.fn(async (commands: string[][]) => (
      commands[0]?.[0] === 'SMEMBERS' ? [{ result: [] }] : []
    )),
    readCachedJsonList: (...a: unknown[]) => readCachedJsonList(...a),
  };
});

vi.mock('../_shared/rate-limit', async (importActual) => {
  const actual = await importActual<typeof import('../_shared/rate-limit')>();
  return {
    ...actual,
    checkRateLimit: vi.fn().mockResolvedValue(null),
    checkEndpointRateLimit: vi.fn().mockResolvedValue(null),
    checkFailClosedScopedIpRateLimit: vi.fn().mockResolvedValue(null),
  };
});

// A `wm_` key resolves to whichever owner the test names. The key path is
// stubbed to admit that owner in full (validation, entitlement, the desktop
// meter below), so a gateway that consults the key answers 200 with the
// owner's alerts and the tests fail on the leak itself, not on a side effect.
const validateUserApiKeyPrincipal = vi.fn();
vi.mock('../_shared/user-api-key', async (importActual) => ({
  ...(await importActual<typeof import('../_shared/user-api-key')>()),
  validateUserApiKeyPrincipal: (...a: unknown[]) => validateUserApiKeyPrincipal(...a),
}));

// The desktop-key meter counts in Redis; admit every request.
vi.mock('../_shared/desktop-key-meter', async (importActual) => ({
  ...(await importActual<typeof import('../_shared/desktop-key-meter')>()),
  chargeDesktopKeyBudget: vi.fn().mockResolvedValue({
    ok: true, dailyCount: 1, minuteCount: 1, rollback: async () => {}, releaseDaily: async () => {},
  }),
}));

const resolveClerkSession = vi.fn();
vi.mock('../_shared/auth-session', () => ({
  resolveClerkSession: (...a: unknown[]) => resolveClerkSession(...a),
}));

const validateApiKey = vi.fn();
vi.mock('../../api/_api-key.js', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  validateApiKey: (...a: unknown[]) => validateApiKey(...a),
}));

vi.mock('../_shared/usage', async (importActual) => {
  const actual = await importActual<typeof import('../_shared/usage')>();
  return { ...actual, deliverUsageEvents: vi.fn().mockResolvedValue(undefined) };
});

import { ACCOUNT_PRIVATE_RPC_PATHS, createDomainGateway, serverOptions } from '../gateway';
import { __resetEntitlementNegativeCacheForTests, getRequiredTier } from '../_shared/entitlement-check';
import { sentAlertsKey } from '../_shared/sent-alert-history';
import { newsHandler } from '../worldmonitor/news/v1/handler';
import { createNewsServiceRoutes } from '../../src/generated/server/worldmonitor/news/v1/service_server';

const PATH = '/api/news/v1/list-sent-alerts';
const ctx = { waitUntil: () => {} };

// Built exactly as api/news/v1/[rpc].ts builds it.
const gateway = createDomainGateway(createNewsServiceRoutes(newsHandler, serverOptions));

function alertRow(title: string) {
  return { title, source: 'Reuters', link: 'https://www.reuters.com/world/story', sentAt: Date.now() - 60_000 };
}

const lists: Record<string, unknown[]> = {
  [sentAlertsKey('user_a')]: [alertRow('Headline sent to A')],
  [sentAlertsKey('user_b')]: [alertRow('Headline sent to B')],
};

/** Convex entitlement rows by user; an absent user is a free account. */
const PRO_USERS = new Set(['user_a', 'user_b']);
function entitlementRow(userId: string) {
  const pro = PRO_USERS.has(userId);
  return {
    planKey: pro ? 'pro_monthly' : 'free',
    features: {
      tier: pro ? 1 : 0,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards: pro ? 10 : 3,
      prioritySupport: false,
      exportFormats: ['csv'],
      mcpAccess: pro,
      embedAccess: false,
      desktopKeyAccess: pro,
      maxDesktopKeys: pro ? 2 : 0,
      planLimits: { dashboardAiCallsPerDay: pro ? 50 : 0 },
    },
    validUntil: pro ? Date.now() + 86_400_000 : 0,
  };
}

function get(headers: Record<string, string> = {}): Request {
  return new Request(`https://www.worldmonitor.app${PATH}`, {
    headers: { Origin: 'https://www.worldmonitor.app', 'cf-connecting-ip': '203.0.113.7', ...headers },
  });
}

function session(userId: string | null, role: 'free' | 'pro' = 'free') {
  resolveClerkSession.mockResolvedValue(userId ? { userId, orgId: null, role } : null);
}

beforeEach(() => {
  __resetEntitlementNegativeCacheForTests();
  historyReads.length = 0;
  readCachedJsonList.mockReset().mockImplementation(async (key: string) => {
    historyReads.push(key);
    const value = lists[key];
    return value ? { status: 'hit', value } : { status: 'miss' };
  });
  resolveClerkSession.mockReset().mockResolvedValue(null);
  validateUserApiKeyPrincipal.mockReset().mockResolvedValue(null);
  validateApiKey.mockReset().mockResolvedValue({ valid: false, required: true, error: 'API key required' });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'https://convex.test/api/internal-entitlements') {
      const { userId } = JSON.parse(String(init?.body)) as { userId: string };
      return Response.json(entitlementRow(userId));
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  }));
});

describe('gateway: list-sent-alerts is account-private', () => {
  test('a Pro session reads its own alerts', async () => {
    session('user_a');
    const res = await gateway(get({ Authorization: 'Bearer a' }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as { alerts: Array<{ title: string }> };
    expect(body.alerts.map((alert) => alert.title)).toEqual(['Headline sent to A']);
    expect(historyReads).toEqual([sentAlertsKey('user_a')]);
  });

  test('a forged x-user-id header does not change whose alerts are read', async () => {
    session('user_a');
    const res = await gateway(get({ Authorization: 'Bearer a', 'x-user-id': 'user_b' }), ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Headline sent to A');
    expect(text).not.toContain('Headline sent to B');
    expect(historyReads).toEqual([sentAlertsKey('user_a')]);
  });

  test('the response is never cacheable', async () => {
    session('user_a');
    const res = await gateway(get({ Authorization: 'Bearer a' }), ctx);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('CDN-Cache-Control')).toBeNull();
  });

  test('an anonymous caller is refused before any read, forged header or not', async () => {
    const res = await gateway(get({ 'x-user-id': 'user_b' }), ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('Headline sent to');
    expect(historyReads).toEqual([]);
  });

  test('an anonymous browser session token is refused before any read', async () => {
    // A wms_ token is valid for public data but names no user.
    validateApiKey.mockImplementation(async (_req: Request, options?: { forceKey?: boolean }) => (
      options?.forceKey
        ? { valid: false, required: true, error: 'API key required' }
        : { valid: true, required: false, kind: 'session' }
    ));
    const res = await gateway(get({ 'X-WorldMonitor-Key': 'wms_anonymous', 'x-user-id': 'user_b' }), ctx);
    expect(res.status).toBe(401);
    expect(historyReads).toEqual([]);
  });

  test('a signed-in free account is refused before any read', async () => {
    session('user_free');
    const res = await gateway(get({ Authorization: 'Bearer free', 'x-user-id': 'user_b' }), ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('Headline sent to');
    expect(historyReads).toEqual([]);
  });

  test('an operator key with no user is refused by the handler before any read', async () => {
    // An enterprise key passes the gateway tier gate but identifies no account.
    validateApiKey.mockResolvedValue({ valid: true, required: true, kind: 'enterprise', credential: 'operator-key' });
    const res = await gateway(get({ 'X-WorldMonitor-Key': 'operator-key', 'x-user-id': 'user_b' }), ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('Headline sent to');
    expect(historyReads).toEqual([]);
  });
});

describe('gateway: a wm_ key never overrides the signed-in account on list-sent-alerts', () => {
  /** Send `wm_key_of_<owner>` as a desktop key that validates to `owner`. */
  async function keyFor(owner: string): Promise<void> {
    // The real validator, so a `wm_` key takes the path production takes.
    const real = await vi.importActual<{ validateApiKey: (...a: unknown[]) => unknown }>('../../api/_api-key.js');
    validateApiKey.mockImplementation(real.validateApiKey);
    validateUserApiKeyPrincipal.mockResolvedValue({
      userId: owner, keyId: 'k1', keyKind: 'desktop', keyHash: 'h'.repeat(64), activeKeyRank: 0,
    });
  }

  for (const header of ['X-WorldMonitor-Key', 'X-Api-Key']) {
    test(`a key alone (${header}) is refused before any read`, async () => {
      // What a desktop sends for a signed-in user it forwards no bearer for.
      await keyFor('user_a');
      const res = await gateway(get({ [header]: 'wm_key_of_user_a' }), ctx);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain('Headline sent to');
      // The refusal says what to do, not that the key needs more validation.
      expect(text).toContain('Sign in to read account data');
      expect(historyReads).toEqual([]);
    });
  }

  test('a key next to a bearer that names no session is refused before any read', async () => {
    // B's token expired: the session resolves to nobody, and A's key must not fill in.
    await keyFor('user_a');
    session(null);
    const res = await gateway(get({ 'X-WorldMonitor-Key': 'wm_key_of_user_a', Authorization: 'Bearer expired' }), ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('Headline sent to');
    expect(historyReads).toEqual([]);
  });

  for (const header of ['X-WorldMonitor-Key', 'X-Api-Key']) {
    test(`a key for A (${header}) with B signed in returns B's alerts, never A's`, async () => {
      await keyFor('user_a');
      session('user_b');
      const res = await gateway(get({ [header]: 'wm_key_of_user_a', Authorization: 'Bearer b' }), ctx);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Headline sent to B');
      expect(text).not.toContain('Headline sent to A');
      expect(historyReads).toEqual([sentAlertsKey('user_b')]);
    });
  }

  test('a key for Pro user A does not lend Pro to a signed-in free account', async () => {
    await keyFor('user_a');
    session('user_free');
    const res = await gateway(get({ 'X-WorldMonitor-Key': 'wm_key_of_user_a', Authorization: 'Bearer free' }), ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('Headline sent to');
    expect(historyReads).toEqual([]);
  });

  test('the key is never looked up, with or without a session', async () => {
    await keyFor('user_a');
    await gateway(get({ 'X-WorldMonitor-Key': 'wm_key_of_user_a' }), ctx);
    session('user_b');
    await gateway(get({ 'X-WorldMonitor-Key': 'wm_key_of_user_a', Authorization: 'Bearer b' }), ctx);
    expect(validateUserApiKeyPrincipal).not.toHaveBeenCalled();
  });

  test('every account-private path is tier-gated, which is what resolves the session first', () => {
    expect([...ACCOUNT_PRIVATE_RPC_PATHS]).toContain(PATH);
    for (const path of ACCOUNT_PRIVATE_RPC_PATHS) expect(getRequiredTier(path), path).not.toBeNull();
  });

  test('a key and a session for the same account read that account', async () => {
    await keyFor('user_a');
    session('user_a');
    const res = await gateway(get({ 'X-WorldMonitor-Key': 'wm_key_of_user_a', Authorization: 'Bearer a' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Headline sent to A');
    expect(historyReads).toEqual([sentAlertsKey('user_a')]);
  });
});
