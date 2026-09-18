// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../_shared/rate-limit', async (original) => ({
  ...await original<typeof import('../_shared/rate-limit')>(),
  checkRateLimit: async () => null,
  checkEndpointRateLimit: async () => null,
}));
vi.mock('../_shared/redis', async (original) => ({
  ...await original<typeof import('../_shared/redis')>(),
  cachedFetchJsonWithMeta: vi.fn(),
}));
vi.mock('../worldmonitor/news/v1/_lastgood-store', async (original) => ({
  ...await original<typeof import('../worldmonitor/news/v1/_lastgood-store')>(),
  readRevokedUrlSet: vi.fn(async () => ({ readable: true, urls: new Set<string>() })),
}));

import { createDomainGateway } from '../gateway';
import { cachedFetchJsonWithMeta } from '../_shared/redis';
import { readRevokedUrlSet } from '../worldmonitor/news/v1/_lastgood-store';
import { listFeedDigest } from '../worldmonitor/news/v1/list-feed-digest';
import { createNewsServiceRoutes, type NewsServiceHandler } from '../../src/generated/server/worldmonitor/news/v1/service_server';
import { isPublicSharedRpcRequest } from '../../src/shared/public-rpc-cache';
import { issueSessionToken } from '../../api/_session.js';

const path = '/api/news/v1/list-feed-digest';
const gateway = createDomainGateway(createNewsServiceRoutes({ listFeedDigest } as NewsServiceHandler).filter(r => r.path === path));
const digest = { categories: {}, feedStatuses: {}, generatedAt: '2026-09-18T00:00:00.000Z' };
let token: string;
const read = (query: string, session = true) => gateway(new Request(`https://worldmonitor.app${path}?${query}`, {
  headers: session ? { 'X-WorldMonitor-Key': token } : {},
}), { waitUntil: () => {} });

beforeEach(async () => {
  vi.stubEnv('WM_SESSION_SECRET', 'synthetic-digest-session-secret-2026');
  vi.stubEnv('LOCAL_API_MODE', '');
  vi.mocked(cachedFetchJsonWithMeta).mockResolvedValue({ data: digest, source: 'cache', leader: false });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external work'));
  token = (await issueSessionToken()).token;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

function expectNoDigestWork() {
  expect(readRevokedUrlSet).not.toHaveBeenCalled();
  expect(cachedFetchJsonWithMeta).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}

test.each(['zz', 'aa', 'EN', 'en-US', 'e', 'english'])('session lang=%s rejects before cache or provider work', async (lang) => {
  const response = await read(`variant=full&lang=${lang}`);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ violations: [{ field: 'lang' }] });
  expectNoDigestWork();
});
test('unsupported public language still requires authentication', async () => {
  const response = await read('variant=full&lang=zz&public=1', false);
  expect(response.status).toBe(401);
  expectNoDigestWork();
});
test.each(['', 'lang=', 'lang=en'])('default language keeps the en work bucket (%s)', async (query) => {
  const response = await read(`variant=full&${query}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject(digest);
  expect(vi.mocked(cachedFetchJsonWithMeta).mock.calls[0]?.[0]).toBe('news:digest:v1:full:en');
});
test('every public-supported two-letter locale retains the same session bucket and public response', async () => {
  let supported = 0;
  for (let a = 97; a <= 122; a++) for (let b = 97; b <= 122; b++) {
    const lang = String.fromCharCode(a, b);
    const query = `variant=full&lang=${lang}&public=1`;
    if (!isPublicSharedRpcRequest(`https://worldmonitor.app${path}?${query}`)) continue;
    supported++;
    for (const session of [true, false]) {
      const response = await read(query, session);
      expect(response.status, lang).toBe(200);
      expect(await response.json()).toMatchObject(digest);
      expect(vi.mocked(cachedFetchJsonWithMeta).mock.lastCall?.[0]).toBe(`news:digest:v1:full:${lang}`);
    }
  }
  expect(supported).toBeGreaterThan(20);
});
