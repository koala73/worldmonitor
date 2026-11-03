import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({ token: vi.fn() }));
vi.mock('@/services/clerk', () => ({
  getClerkToken: () => clerk.token(),
  getCurrentClerkUser: () => null,
}));
vi.mock('@/services/convex-client', () => ({
  getConvexClient: vi.fn(),
  getConvexApi: vi.fn(),
  waitForConvexAuthForUser: vi.fn(),
}));

const { fetchMcpQuota } = await import('@/services/mcp-clients');
const quota = { used: 0, limit: 50, resetsAt: '2026-10-19T00:00:00.000Z' };
const fetchMock = vi.fn();

beforeEach(() => {
  clerk.token.mockReset().mockResolvedValue('fixture-session');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('MCP quota display input', () => {
  it('preserves a successful zero and requests the authenticated quota endpoint', async () => {
    fetchMock.mockResolvedValue(Response.json(quota));
    await expect(fetchMcpQuota()).resolves.toEqual(quota);
    expect(fetchMock).toHaveBeenCalledWith('/api/user/mcp-quota', {
      method: 'GET', headers: { Authorization: 'Bearer fixture-session' },
    });
  });

  it.each([0, 250, null])('preserves the successful plan limit %s', async (limit) => {
    fetchMock.mockResolvedValue(Response.json({ ...quota, limit }));
    await expect(fetchMcpQuota()).resolves.toEqual({ ...quota, limit });
  });

  it('does not invent zero when the session is missing', async () => {
    clerk.token.mockResolvedValue(null);
    await expect(fetchMcpQuota()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 503])('does not invent zero after HTTP %s', async (status) => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    await expect(fetchMcpQuota()).rejects.toThrow();
  });

  it('does not invent zero after a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fixture offline'));
    await expect(fetchMcpQuota()).rejects.toThrow();
  });

  it.each([
    null, {}, { ...quota, used: undefined }, { ...quota, used: -1 },
    { ...quota, used: '0' }, { ...quota, limit: undefined },
    { ...quota, limit: -1 }, { ...quota, resetsAt: 'invalid' },
  ])('does not invent values for malformed payload %j', async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(fetchMcpQuota()).rejects.toThrow();
  });
});
