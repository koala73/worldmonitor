// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';

const keyA = `wm_${'a'.repeat(40)}`;
const keyB = `wm_${'b'.repeat(40)}`;
const invalidKey = `wm_${'c'.repeat(40)}`;
const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const validateUserApiKey = vi.fn(async (key: string) => key === keyA ? { userId: 'owner-a' } : key === keyB ? { userId: 'owner-b' } : null);
vi.mock('../_shared/user-api-key', async (importOriginal) => ({
  ...await importOriginal<typeof import('../_shared/user-api-key')>(),
  validateUserApiKey: (...args: [string]) => validateUserApiKey(...args),
}));
const active = { planKey: 'api_starter', features: { tier: 2, apiAccess: true, apiRateLimit: 60, apiDailyAllowance: 1000 }, validUntil: Date.now() + 86400000 };
let apiAccess = true;
vi.mock('../_shared/entitlement-check', async (importOriginal) => ({
  ...await importOriginal<typeof import('../_shared/entitlement-check')>(),
  getEntitlements: vi.fn(async () => ({ ...active, features: { ...active.features, apiAccess } })),
  isEntitlementBackendConfigured: () => true,
}));
vi.mock('../_shared/rate-limit', async (importOriginal) => ({
  ...await importOriginal<typeof import('../_shared/rate-limit')>(),
  checkRateLimit: vi.fn().mockResolvedValue(null),
  checkFailClosedScopedIpRateLimit: vi.fn().mockResolvedValue(null),
  checkEndpointRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock('../_shared/api-key-rate-limit', () => ({
  checkBurst: vi.fn().mockResolvedValue({ ok: true }),
  reserveDailyMeter: vi.fn().mockResolvedValue({ count: 1, overLimit: false, metered: true, retryAfterSec: 100, rollback: async () => {} }),
  rateLimitHeaders: () => ({}), ENTERPRISE_API_RATE_LIMIT: 1000,
}));
const records = new Map<string, Record<string, unknown>>();
const getCachedJson = vi.fn(async (key: string) => records.get(key) ?? null);
const setCachedJson = vi.fn(async (key: string, value: Record<string, unknown>, _ttl: number) => { records.set(key, value); });
const runRedisPipeline = vi.fn(async (commands: string[][]) => commands.map(command => {
  if (command[0] === 'SET') records.set(command[1], JSON.parse(command[2]));
  return { result: command[0] === 'SET' ? 'OK' : 1 };
}));
vi.mock('../_shared/redis', async (importOriginal) => ({
  ...await importOriginal<typeof import('../_shared/redis')>(),
  runRedisPipeline: (...args: [string[][]]) => runRedisPipeline(...args),
  getCachedJson: (key: string) => getCachedJson(key),
  setCachedJson: (key: string, value: Record<string, unknown>, ttl: number) => setCachedJson(key, value, ttl),
}));

import { createDomainGateway, serverOptions } from '../gateway';
import { createShippingV2ServiceRoutes } from '../../src/generated/server/worldmonitor/shipping/v2/service_server';
import statusHandler from '../../api/v2/shipping/webhooks/[subscriberId]';
import actionHandler from '../../api/v2/shipping/webhooks/[subscriberId]/[action]';
import { registerWebhook } from '../worldmonitor/shipping/v2/register-webhook';
import { checkFailClosedScopedIpRateLimit } from '../_shared/rate-limit';
const registerHandler = vi.fn(registerWebhook);
const routes = createShippingV2ServiceRoutes({ listWebhooks: vi.fn(), registerWebhook: registerHandler, routeIntelligence: vi.fn() }, serverOptions);
const gateway = createDomainGateway(routes);
const payload = { callbackUrl: 'https://93.184.216.34/hook', chokepointIds: ['suez'], alertThreshold: 50 };
const request = (key?: string, extra: Record<string, string> = {}, body = payload) => new Request('https://www.worldmonitor.app/api/v2/shipping/webhooks', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Api-Key': key } : {}), ...extra }, body: JSON.stringify(body),
});
const context = { waitUntil: () => {} };
beforeEach(() => {
  apiAccess = true; records.clear(); vi.clearAllMocks();
  vi.mocked(checkFailClosedScopedIpRateLimit).mockResolvedValue(null);
  validateUserApiKey.mockReset().mockImplementation(async (key: string) => key === keyA ? { userId: 'owner-a' } : key === keyB ? { userId: 'owner-b' } : null);
  vi.stubEnv('WORLDMONITOR_VALID_KEYS', 'enterprise-test');
});
afterEach(() => vi.unstubAllEnvs());

for (const key of [keyA, keyB]) {
  test(`gateway registration stores the verified credential owner: ${key.slice(-1)}`, async () => {
    const response = await gateway(request(key, { 'x-user-id': 'forged-other-owner' }), context);
    expect(registerHandler).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.subscriberId).toMatch(/^wh_[a-f0-9]{24}$/);
    expect(body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(runRedisPipeline).toHaveBeenCalledOnce();
    const commands = runRedisPipeline.mock.calls[0][0];
    const record = JSON.parse(commands[0][2]);
    expect(record).toMatchObject({ ...payload, ownerTag: hash(key), subscriberId: body.subscriberId, secret: body.secret, active: true });
    expect(commands[1]).toEqual(['SADD', `webhook:owner:${hash(key)}:v1`, body.subscriberId]);
    expect(commands[2]).toEqual(['EXPIRE', `webhook:owner:${hash(key)}:v1`, String(86400 * 30)]);
    expect(commands[0].slice(3)).toEqual(['EX', String(86400 * 30)]);
  });
}

test('revoked key cannot register using a forged identity or enterprise cookie', async () => {
  const response = await gateway(request(invalidKey, { 'x-user-id': 'owner-a', Cookie: 'wm-pro-key=enterprise-test' }), context);
  expect(response.status).toBe(401);
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('key without API access cannot write registrations', async () => {
  apiAccess = false;
  expect((await gateway(request(keyA), context)).status).toBe(403);
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('direct invalid-key registration rejects and sanitizes the internal sentinel', async () => {
  await expect(registerWebhook({ request: request(invalidKey, { 'x-user-id': 'owner-a' }), pathParams: {}, headers: {} }, payload)).rejects.toMatchObject({ statusCode: 401, message: 'Invalid API key' });
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('direct no-key registration cannot create an anonymous owner', async () => {
  await expect(registerWebhook({ request: request(undefined, { 'x-user-id': 'owner-a' }), pathParams: {}, headers: {} }, payload)).rejects.toMatchObject({ statusCode: 401 });
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('handler validation outage after gateway acceptance fails closed', async () => {
  validateUserApiKey.mockResolvedValueOnce({ userId: 'owner-a' }).mockRejectedValueOnce(new Error('synthetic outage'));
  const response = await gateway(request(keyA), context);
  expect(registerHandler).toHaveBeenCalledOnce();
  expect(response.status).toBe(503);
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('validated user key still cannot register a private callback', async () => {
  expect((await gateway(request(keyA, {}, { ...payload, callbackUrl: 'https://127.0.0.1/hook' }), context)).status).toBe(400);
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('enterprise cookie keeps its owner with an anonymous header', async () => {
  expect((await gateway(request('wms_anonymous', { Cookie: 'wm-pro-key=enterprise-test' }), context)).status).toBe(200);
  const commands = runRedisPipeline.mock.calls[0][0];
  expect(JSON.parse(commands[0][2]).ownerTag).toBe(hash('enterprise-test'));
  expect(commands[1][1]).toBe(`webhook:owner:${hash('enterprise-test')}:v1`);
});

const manage = (subscriberId: string, action: string, key?: string, extra: Record<string, string> = {}) => {
  const req = new Request(`https://www.worldmonitor.app/api/v2/shipping/webhooks/${subscriberId}${action ? `/${action}` : ''}`, {
    method: action ? 'POST' : 'GET', headers: { ...(key ? { 'X-Api-Key': key } : {}), ...extra },
  });
  return action ? actionHandler(req) : statusHandler(req);
};

test('gateway registrations support owner-only status, rotation and reactivation', async () => {
  const a = await (await gateway(request(keyA), context)).json();
  const b = await (await gateway(request(keyB), context)).json();
  for (const [owner, own, foreign] of [[keyA, a, b], [keyB, b, a]] as const) {
    const status = await manage(own.subscriberId, '', owner);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ subscriberId: own.subscriberId, active: true });
    const before = structuredClone(records);
    for (const action of ['', 'rotate-secret', 'reactivate']) {
      const denied = await manage(foreign.subscriberId, action, owner, { 'x-user-id': 'owner-b' });
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain(foreign.secret);
    }
    expect(records).toEqual(before);
    const rotated = await manage(own.subscriberId, 'rotate-secret', owner);
    expect(rotated.status).toBe(200);
    const body = await rotated.json();
    expect(body.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(body.secret).not.toBe(own.secret);
    const storageKey = `webhook:sub:${own.subscriberId}:v1`;
    expect(records.get(storageKey)?.secret).toBe(body.secret);
    records.set(storageKey, { ...records.get(storageKey), active: false });
    expect((await manage(own.subscriberId, 'reactivate', owner)).status).toBe(200);
    expect(records.get(storageKey)).toMatchObject({ active: true, secret: body.secret, ownerTag: hash(owner) });
    expect(await (await manage(own.subscriberId, '', owner)).json()).not.toHaveProperty('secret');
    expect(setCachedJson.mock.calls.at(-1)?.[2]).toBe(86400 * 30);
  }
});

for (const action of ['', 'rotate-secret', 'reactivate']) {
  test.each([429, 503])(`management ${action || 'status'} stops before key lookup when pre-auth limiter returns %s`, async (status) => {
    vi.mocked(checkFailClosedScopedIpRateLimit).mockResolvedValue(new Response('limited', { status }));
    expect((await manage('wh_test', action, invalidKey)).status).toBe(status);
    expect(checkFailClosedScopedIpRateLimit).toHaveBeenCalledWith(
      expect.any(Request), 'user-api-key:pre-auth-validation', 600, '60 s', expect.any(Object),
    );
    expect(validateUserApiKey).not.toHaveBeenCalled();
    expect(getCachedJson).not.toHaveBeenCalled();
    expect(setCachedJson).not.toHaveBeenCalled();
  });
  test(`management ${action || 'status'} rejects invalid, missing and unentitled keys before storage`, async () => {
    for (const key of [invalidKey, undefined]) {
      const denied = await manage('wh_test', action, key, { 'x-user-id': 'owner-a' });
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain('gateway validation');
    }
    expect((await manage('wh_test', action, invalidKey, { Cookie: 'wm-pro-key=enterprise-test' })).status).toBe(401);
    apiAccess = false;
    expect((await manage('wh_test', action, keyA)).status).toBe(403);
    expect(getCachedJson).not.toHaveBeenCalled();
    expect(setCachedJson).not.toHaveBeenCalled();
  });
  test(`management ${action || 'status'} returns 503 on key lookup outage before storage`, async () => {
    validateUserApiKey.mockRejectedValue(new Error('synthetic outage'));
    const response = await manage('wh_test', action, keyA);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('synthetic outage');
    expect(getCachedJson).not.toHaveBeenCalled();
    expect(setCachedJson).not.toHaveBeenCalled();
  });
  test(`management ${action || 'status'} preserves a premium recheck outage as 503`, async () => {
    validateUserApiKey.mockResolvedValueOnce({ userId: 'owner-a' }).mockRejectedValueOnce(new Error('synthetic outage'));
    expect((await manage('wh_test', action, keyA)).status).toBe(503);
    expect(getCachedJson).not.toHaveBeenCalled();
    expect(setCachedJson).not.toHaveBeenCalled();
  });
  test(`management ${action || 'status'} keeps enterprise cookie credential ownership`, async () => {
    const extra = { Cookie: 'wm-pro-key=enterprise-test' };
    const own = await (await gateway(request('wms_anonymous', extra), context)).json();
    expect((await manage(own.subscriberId, action, 'wms_anonymous', extra)).status).toBe(200);
    expect(records.get(`webhook:sub:${own.subscriberId}:v1`)?.ownerTag).toBe(hash('enterprise-test'));
  });
}
