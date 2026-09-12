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
const runRedisPipeline = vi.fn(async (commands: string[][]) => {
  if (commands[0][0] === 'SMEMBERS') return [{ result: ['own', 'foreign'] }];
  return [hash(keyA), hash(keyB)].map((ownerTag, i) => ({ result: JSON.stringify({
    subscriberId: i === 0 ? 'own' : 'foreign', ownerTag, secret: 'must-not-leak',
    callbackUrl: 'https://subscriber.example/hook', chokepointIds: ['suez'], alertThreshold: 50,
    createdAt: '2026-09-11T00:00:00Z', active: true,
  }) }));
});
vi.mock('../_shared/redis', async (importOriginal) => ({
  ...await importOriginal<typeof import('../_shared/redis')>(),
  runRedisPipeline: (...args: [string[][]]) => runRedisPipeline(...args),
}));

import { createDomainGateway, serverOptions } from '../gateway';
import { createShippingV2ServiceRoutes, ApiError } from '../../src/generated/server/worldmonitor/shipping/v2/service_server';
import { listWebhooks } from '../worldmonitor/shipping/v2/list-webhooks';
const listHandler = vi.fn(listWebhooks);
const routes = createShippingV2ServiceRoutes({ listWebhooks: listHandler, registerWebhook: vi.fn(), routeIntelligence: vi.fn() }, serverOptions);
const gateway = createDomainGateway(routes);
const path = '/api/v2/shipping/webhooks';
const request = (key?: string, extra: Record<string, string> = {}) => new Request(`https://www.worldmonitor.app${path}`, {
  headers: { ...(key ? { 'X-Api-Key': key } : {}), ...extra },
});
const context = { waitUntil: () => {} };

beforeEach(() => { apiAccess = true; vi.clearAllMocks(); vi.stubEnv('WORLDMONITOR_VALID_KEYS', 'enterprise-test'); });
afterEach(() => vi.unstubAllEnvs());

for (const [key, id] of [[keyA, 'own'], [keyB, 'foreign']]) {
  test(`gateway-validated key lists only its credential-owned records: ${id}`, async () => {
    const response = await gateway(request(key, { 'x-user-id': 'forged-other-owner' }), context);
    expect(listHandler).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.webhooks.map((row: { subscriberId: string }) => row.subscriberId)).toEqual([id]);
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(runRedisPipeline).toHaveBeenNthCalledWith(1, [['SMEMBERS', `webhook:owner:${hash(key)}:v1`]]);
    expect(validateUserApiKey).toHaveBeenCalledWith(key);
  });
}

test('gateway rejects revoked keys before owner storage', async () => {
  const response = await gateway(request(invalidKey, { 'x-user-id': 'owner-a' }), context);
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('requires gateway validation');
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('gateway rejects a valid key without API access before owner storage', async () => {
  apiAccess = false;
  expect((await gateway(request(keyA), context)).status).toBe(403);
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('direct handler rejects a forged identity with an invalid user key and sanitizes the sentinel', async () => {
  const req = request(invalidKey, { 'x-user-id': 'owner-a' });
  await expect(listWebhooks({ request: req, pathParams: {}, headers: {} }, {})).rejects.toMatchObject({ statusCode: 401, message: 'Invalid API key' });
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('direct handler keeps no-key callers out of the anonymous bucket', async () => {
  await expect(listWebhooks({ request: request(undefined, { 'x-user-id': 'owner-a' }), pathParams: {}, headers: {} }, {})).rejects.toBeInstanceOf(ApiError);
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('handler-side validation outage fails closed without reading ownership', async () => {
  validateUserApiKey.mockResolvedValueOnce({ userId: 'owner-a' }).mockRejectedValueOnce(new Error('synthetic backend outage'));
  const response = await gateway(request(keyA), context);
  expect(listHandler).toHaveBeenCalledOnce();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('synthetic backend outage');
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('invalid explicit user key cannot borrow an enterprise cookie', async () => {
  const response = await gateway(request(invalidKey, { Cookie: 'wm-pro-key=enterprise-test' }), context);
  expect(response.status).toBe(401);
  expect(runRedisPipeline).not.toHaveBeenCalled();
});

test('enterprise cookie retains its credential owner when an anonymous header is present', async () => {
  const response = await gateway(request('wms_anonymous', { Cookie: 'wm-pro-key=enterprise-test' }), context);
  expect(response.status).toBe(200);
  expect(runRedisPipeline).toHaveBeenNthCalledWith(1, [['SMEMBERS', `webhook:owner:${hash('enterprise-test')}:v1`]]);
  expect(await response.json()).toEqual({ webhooks: [] });
});
