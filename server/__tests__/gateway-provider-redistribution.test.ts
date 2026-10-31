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
// The gateway resolves wm_ keys through the desktop-aware principal (plan
// 2026-10-25-001 U4); an `api` principal with rank 0 is today's API customer.
vi.mock('../_shared/user-api-key', () => ({
  validateUserApiKeyPrincipal: vi.fn(async (key: string) => key === 'wm_valid_user_key'
    ? { userId: 'paid-account', keyId: 'test', keyKind: 'api', keyHash: 'h'.repeat(64), activeKeyRank: 0 } : null),
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
import { validateUserApiKeyPrincipal as validateUserApiKey } from '../_shared/user-api-key';
import { getTheaterPosture } from '../worldmonitor/military/v1/get-theater-posture';
import { createMilitaryServiceRoutes, type MilitaryServiceHandler } from '../../src/generated/server/worldmonitor/military/v1/service_server';
import { getCountrySignalObservations } from '../worldmonitor/intelligence/v1/get-country-signal-observations';
import { createIntelligenceServiceRoutes, type IntelligenceServiceHandler } from '../../src/generated/server/worldmonitor/intelligence/v1/service_server';
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

const countryPath = '/api/intelligence/v1/get-country-signal-observations';
const countryUrl = `https://worldmonitor.app${countryPath}?country_code=IR&family=COUNTRY_SIGNAL_FAMILY_POSTURE`;
const countryGateway = createDomainGateway(createIntelligenceServiceRoutes({ getCountrySignalObservations } as IntelligenceServiceHandler).filter(route => route.path === countryPath));
const readCountry = (headers: HeadersInit = {}) => countryGateway(new Request(countryUrl, { headers }), { waitUntil: () => {} });

test.each([{}, { 'x-user-id': 'invented', 'x-pro-user': 'true' }, { [INTERNAL_MCP_VERIFIED_HEADER]: 'forged' }])('country projection rejects unverified authority before source IO: %j', async headers => {
  const response = await readCountry(headers);
  expect(response.status).toBe(401);
  expect(getCachedJson).not.toHaveBeenCalled();
});

test.each(['header', 'cookie'])('country projection preserves qualified observations for an ordinary %s session', async kind => {
  vi.mocked(getCachedJson).mockResolvedValue({ provider: 'adsb.lol', theaters: [{ theater: 'iran-theater', postureLevel: 'critical', activeFlights: 10, assessedAt: 1792324800000 }] });
  const { token } = await issueSessionToken();
  const response = await readCountry(kind === 'header' ? { 'X-WorldMonitor-Key': token } : { Cookie: `wm-session=${token}` });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const outcome = JSON.parse((await response.json()).outcomeJson);
  expect(outcome).toMatchObject({ countryCode: 'IR', family: 'posture', state: 'observed' });
  expect(outcome.observations).toMatchObject([{ title: '10 military aircraft in iran-theater', source: 'adsb.lol', severity: 'high' }]);
});

test('signed paid MCP still cannot expose unqualified provider data through the country projection', async () => {
  const signed = await signInternalMcpRequest({ method: 'GET', url: countryUrl, userId: 'paid-account', secret: process.env.MCP_INTERNAL_HMAC_SECRET! });
  const response = await readCountry(buildInternalMcpHeaders(signed));
  expect(response.status).toBe(200);
  expect(JSON.parse((await response.json()).outcomeJson)).toMatchObject({ state: 'locked', observations: [] });
  expect(getCachedJson).toHaveBeenCalled();
});
