/**
 * Revoking an API key is a Convex mutation followed by a best-effort gateway
 * cache bust. Once the mutation commits the key is revoked; if the cache bust
 * fails, the 60s cache TTL bounds the staleness. A cache-bust network failure
 * or deadline must therefore not turn a completed revocation into an error the
 * user retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mutationMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => ({ id: 'user_self' }),
  getClerkToken: async () => 'clerk-token',
  getClerkSessionToken: async () => 'clerk-token',
}));

vi.mock('@/services/convex-client', () => ({
  getConvexClient: async () => ({ mutation: (...args: unknown[]) => mutationMock(...args) }),
  getConvexApi: async () => ({ apiKeys: { revokeApiKey: 'apiKeys:revokeApiKey' } }),
  waitForConvexAuthForUser: async () => true,
}));

vi.mock('@/services/account-operation', () => ({
  assertAccountStillCurrent: () => {},
  settleAccountOperation: async (_userId: string, _label: string, run: () => Promise<unknown>) => run(),
}));

const { revokeApiKey } = await import('@/services/api-keys');

beforeEach(() => {
  mutationMock.mockReset().mockResolvedValue({ keyHash: 'hash_abc' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('revokeApiKey cache invalidation', () => {
  it('resolves when the cache bust fails at the network', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeApiKey('key_1')).resolves.toBeUndefined();
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/invalidate-user-api-key-cache', expect.objectContaining({
      body: JSON.stringify({ keyHash: 'hash_abc' }),
    }));
    expect(console.warn).toHaveBeenCalledWith('[api-keys] cache invalidation failed:', 503);
  });

  it('bounds a stalled cache bust with the 15s deadline and still resolves', async () => {
    const deadlines = new Map<number, AbortController>();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      const controller = new AbortController();
      deadlines.set(delay, controller);
      return controller.signal;
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const revoked = revokeApiKey('key_1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    deadlines.get(15_000)?.abort(new DOMException('signal timed out', 'TimeoutError'));

    await expect(revoked).resolves.toBeUndefined();
  });
});
