// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { limit, construct } = vi.hoisted(() => ({ limit: vi.fn(), construct: vi.fn() }));
vi.mock('@upstash/redis', () => ({ Redis: class {} }));
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    static slidingWindow = vi.fn();
    constructor() { construct(); }
    limit = limit;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'private-token');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  limit.mockReset();
  construct.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function check() {
  const { checkBurst } = await import('../_shared/api-key-rate-limit');
  return checkBurst(60, 'private-account');
}

describe('account burst decision', () => {
  test('SDK timeout-success is unavailable, not allowed', async () => {
    limit.mockResolvedValue({ success: true, reason: 'timeout', limit: 60, reset: 0 });
    expect(await check()).toEqual({ ok: null, reason: 'timeout' });
  });
  test('missing configuration is unavailable', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    expect(await check()).toEqual({ ok: null, reason: 'not_configured' });
    expect(limit).not.toHaveBeenCalled();
  });
  test.each(['construction', 'request'])('%s errors are unavailable', async (stage) => {
    if (stage === 'construction') construct.mockImplementation(() => { throw new Error('private-token'); });
    else limit.mockRejectedValue(new Error('private-token'));
    expect(await check()).toEqual({ ok: null, reason: 'error' });
  });
  test('healthy allow and deny retain their limits', async () => {
    limit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, limit: 60, reset: 123 });
    expect(await check()).toEqual({ ok: true });
    expect(await check()).toEqual({ ok: false, limit: 60, reset: 123 });
  });
  test('diagnostics have fixed labels and are bounded across identities and failure reasons', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    limit.mockRejectedValue(new Error('private-token private-account'));
    const { checkBurst } = await import('../_shared/api-key-rate-limit');
    await checkBurst(60, 'private-account');
    limit.mockResolvedValue({ success: true, reason: 'timeout' });
    await checkBurst(60, 'another-private-account');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenLastCalledWith('[api-key-rate-limit] burst unavailable', { reason: 'error' });
    clock.mockReturnValue(61_000);
    await checkBurst(60, 'another-private-account');
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenLastCalledWith('[api-key-rate-limit] burst unavailable', { reason: 'timeout' });
  });
});
