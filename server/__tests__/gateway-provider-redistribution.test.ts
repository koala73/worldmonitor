// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../_shared/rate-limit', async (original) => ({
  ...await original<typeof import('../_shared/rate-limit')>(),
  checkRateLimit: async () => null,
  checkEndpointRateLimit: async () => null,
  checkFailClosedScopedIpRateLimit: async () => null,
}));
vi.mock('../_shared/api-key-rate-limit', async (original) => ({
  ...await original<typeof import('../_shared/api-key-rate-limit')>(),
  checkBurst: async () => ({ ok: true }),
  reserveDailyMeter: async () => ({ count: 1, overLimit: false, metered: true, retryAfterSec: 60, rollback: async () => {} }),
}));
vi.mock('../_shared/user-api-key', () => ({
  validateUserApiKey: vi.fn(async (key: string) => key === 'wm_valid_user_key'
    ? { userId: 'paid-account', keyId: 'test', name: 'test' } : null),
}));
vi.mock('../_shared/entitlement-check', async (original) => ({
  ...await original<typeof import('../_shared/entitlement-check')>(),
  getEntitlements: async () => ({ planKey: 'api_starter', validUntil: Date.now() + 60000,
    features: { tier: 2, apiAccess: true, mcpAccess: true, apiRateLimit: 60, apiDailyAllowance: 1000 } }),
}));
vi.mock('../_shared/redis', async (original) => ({
  ...await original<typeof import('../_shared/redis')>(),
  getCachedJson: vi.fn(),
  runRedisPipeline: vi.fn(async () => [{ result: 'OK' }]),
}));

import { createDomainGateway } from '../gateway';
import { getCachedJson } from '../_shared/redis';
import { validateUserApiKey } from '../_shared/user-api-key';
import { getTheaterPosture } from '../worldmonitor/military/v1/get-theater-posture';
import { createMilitaryServiceRoutes, type MilitaryServiceHandler } from '../../src/generated/server/worldmonitor/military/v1/service_server';
import { issueSessionToken } from '../../api/_session.js';
import { INTERNAL_MCP_VERIFIED_HEADER, buildInternalMcpHeaders, signInternalMcpRequest } from '../_shared/mcp-internal-hmac';

const path = '/api/military/v1/get-theater-posture';
const url = `https://worldmonitor.app${path}`;
const gateway = createDomainGateway(createMilitaryServiceRoutes({ getTheaterPosture } as MilitaryServiceHandler).filter(r => r.path === path));
const posture = { provider: 'opensky', theaters: [{ theaterId: 'test', theaterName: 'Synthetic posture' }] };
const read = (headers: HeadersInit) => gateway(new Request(url, { headers }), { waitUntil: () => {} });

beforeEach(() => {
  vi.stubEnv('WORLDMONITOR_VALID_KEYS', 'enterprise-test');
  vi.stubEnv('WM_SESSION_SECRET', 'synthetic-provider-session-secret');
  vi.stubEnv('MCP_INTERNAL_HMAC_SECRET', 'synthetic-provider-mcp-secret');
  vi.stubEnv('LOCAL_API_MODE', '');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.invalid');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  vi.mocked(getCachedJson).mockResolvedValue(posture);
  vi.mocked(validateUserApiKey).mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

test.each(['enterprise-test', 'wm_valid_user_key'])('empty primary uses secondary %s through authentication and provider policy', async (key) => {
  const response = await read({ 'X-WorldMonitor-Key': '', 'X-Api-Key': key });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ theaters: [] });
  expect(getCachedJson).toHaveBeenCalled();
  if (key.startsWith('wm_')) expect(validateUserApiKey).toHaveBeenCalledWith(key);
});
test('redistributable data remains available to the secondary enterprise key', async () => {
  vi.mocked(getCachedJson).mockResolvedValue({ ...posture, provider: 'wingbits' });
  const response = await read({ 'X-WorldMonitor-Key': '', 'X-Api-Key': 'enterprise-test' });
  expect(response.status).toBe(200);
  expect((await response.json()).theaters).toHaveLength(1);
});
test.each(['header', 'cookie'])('browser %s session retains display data', async (kind) => {
  const { token } = await issueSessionToken();
  const headers = kind === 'header' ? { 'X-WorldMonitor-Key': '', 'X-Api-Key': token } : { Cookie: `wm-session=${token}` };
  const response = await read(headers);
  expect(response.status).toBe(200);
  expect((await response.json()).theaters).toHaveLength(1);
});
test('nonempty primary retains priority over a secondary enterprise key', async () => {
  const { token } = await issueSessionToken();
  const response = await read({ 'X-WorldMonitor-Key': token, 'X-Api-Key': 'enterprise-test' });
  expect(response.status).toBe(200);
  expect((await response.json()).theaters).toHaveLength(1);
});
test.each(['invalid', 'wm_invalid_key'])('invalid primary %s cannot borrow a valid secondary credential', async (key) => {
  const response = await read({ 'X-WorldMonitor-Key': key, 'X-Api-Key': 'enterprise-test' });
  expect(response.status).toBe(401);
  expect(getCachedJson).not.toHaveBeenCalled();
});
test('signed MCP remains restricted and forged markers cannot grant authority', async () => {
  const signed = await signInternalMcpRequest({ method: 'GET', url, userId: 'paid-account', secret: process.env.MCP_INTERNAL_HMAC_SECRET! });
  const response = await read(buildInternalMcpHeaders(signed));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ theaters: [] });
  expect((await read({ [INTERNAL_MCP_VERIFIED_HEADER]: 'forged' })).status).toBe(401);
});
