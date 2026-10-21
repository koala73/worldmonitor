import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tokenImpl: () => Promise<string | null> = async () => 'clerk-token';

vi.mock('@/services/clerk', () => ({
  getClerkToken: () => tokenImpl(),
}));

import { reserveAccountOffer } from '@/services/passkey-offer-reservation';

beforeEach(() => {
  tokenImpl = async () => 'clerk-token';
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reserveAccountOffer', () => {
  it.each(['reserved', 'cap-reached'] as const)(
    'returns the server reservation status %s',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status }), {
        status: 200,
      })));

      await expect(reserveAccountOffer()).resolves.toBe(status);
      expect(fetch).toHaveBeenCalledWith('/api/user/passkey-offer', expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer clerk-token' },
        signal: expect.any(AbortSignal),
      }));
    },
  );

  it('fails closed when Clerk cannot provide a token', async () => {
    tokenImpl = async () => null;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(reserveAccountOffer()).resolves.toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['token failure', 'token-failure'],
    ['server rejection', 'server-rejection'],
    ['invalid response', 'invalid-response'],
    ['network failure', 'network-failure'],
  ] as const)('fails closed on %s', async (_label, scenario) => {
    if (scenario === 'token-failure') {
      tokenImpl = async () => { throw new Error('clerk unavailable'); };
    } else if (scenario === 'server-rejection') {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    } else if (scenario === 'invalid-response') {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"status":"other"}', { status: 200 })));
    } else {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    }

    await expect(reserveAccountOffer()).resolves.toBe('unavailable');
  });
});
