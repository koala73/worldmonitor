// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const record = {
  subscriberId: 'wh_test', ownerTag: createHash('sha256').update('tenant-a').digest('hex'),
  callbackUrl: 'https://example.com/hook', chokepointIds: ['suez'], alertThreshold: 50,
  createdAt: '2026-09-11T00:00:00Z', active: true, secret: 'synthetic-secret',
};
const getCachedJson = vi.fn(async () => record as typeof record | null);
vi.mock('../_shared/redis', async (importOriginal) => ({
  ...await importOriginal<typeof import('../_shared/redis')>(),
  getCachedJson: () => getCachedJson(),
}));
import handler from '../../api/v2/shipping/webhooks/[subscriberId]';

beforeEach(() => {
  vi.stubEnv('WORLDMONITOR_VALID_KEYS', 'tenant-a,tenant-b');
  getCachedJson.mockReset().mockResolvedValue(record);
});
afterEach(() => vi.unstubAllEnvs());

for (const scenario of [
  { name: 'owner success', method: 'GET', key: 'tenant-a', id: 'wh_test', status: 200 },
  { name: 'foreign owner', method: 'GET', key: 'tenant-b', id: 'wh_test', status: 403 },
  { name: 'missing credential', method: 'GET', key: '', id: 'wh_test', status: 401 },
  { name: 'invalid credential', method: 'GET', key: 'invalid', id: 'wh_test', status: 401 },
  { name: 'invalid subscriber ID', method: 'GET', key: 'tenant-a', id: 'invalid', status: 404 },
  { name: 'missing record', method: 'GET', key: 'tenant-a', id: 'wh_missing', status: 404 },
  { name: 'storage read failure', method: 'GET', key: 'tenant-a', id: 'wh_unavailable', status: 404 },
  { name: 'unsupported method', method: 'POST', key: '', id: 'wh_test', status: 405 },
  { name: 'preflight', method: 'OPTIONS', key: '', id: 'wh_test', status: 204 },
]) {
  test(`status response cannot be cached: ${scenario.name}`, async () => {
    if (scenario.id === 'wh_missing') getCachedJson.mockResolvedValue(null);
    if (scenario.id === 'wh_unavailable') getCachedJson.mockRejectedValue(new Error('synthetic storage outage'));
    const response = await handler(new Request(`https://www.worldmonitor.app/api/v2/shipping/webhooks/${scenario.id}`, {
      method: scenario.method,
      headers: { Origin: 'https://www.worldmonitor.app', ...(scenario.key ? { 'X-Api-Key': scenario.key } : {}) },
    }));
    expect(response.status).toBe(scenario.status);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.worldmonitor.app');
    if (response.status === 200) {
      const body = await response.json();
      expect(body).toMatchObject({ subscriberId: record.subscriberId, callbackUrl: record.callbackUrl });
      expect(body).not.toHaveProperty('secret');
      expect(body).not.toHaveProperty('ownerTag');
    }
  });
}
