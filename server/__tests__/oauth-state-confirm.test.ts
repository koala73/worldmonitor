// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../auth-session', () => ({
  validateBearerToken: vi.fn(async () => ({ valid: true, userId: 'user_oauth' })),
}));
vi.mock('../_shared/pro-entitlement', () => ({
  checkTierProEntitlement: vi.fn(async () => ({ allowed: true })),
}));
// Slack start runs a fail-closed per-user limiter before the state write; keep
// its Upstash traffic out of the single fetch stub these tests assert on.
vi.mock('../../api/_rate-limit.js', () => ({
  checkRateLimit: vi.fn(async () => null),
}));

const ROUTES = [
  {
    name: 'discord',
    modulePath: '../../api/discord/oauth/start.ts',
    url: 'https://worldmonitor.app/api/discord/oauth/start',
    clientId: 'DISCORD_CLIENT_ID',
    redirect: 'DISCORD_REDIRECT_URI',
    redirectValue: 'https://worldmonitor.app/api/discord/oauth/callback',
    host: 'discord.com',
  },
  {
    name: 'slack',
    modulePath: '../../api/slack/oauth/start.ts',
    url: 'https://worldmonitor.app/api/slack/oauth/start',
    clientId: 'SLACK_CLIENT_ID',
    redirect: 'SLACK_REDIRECT_URI',
    redirectValue: 'https://worldmonitor.app/api/slack/oauth/callback',
    host: 'slack.com',
  },
] as const;

function requestFor(url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-jwt', Origin: 'https://worldmonitor.app' },
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

for (const route of ROUTES) {
  test(`${route.name} oauth start returns 503 when the Redis token is missing`, async () => {
    vi.stubEnv(route.clientId, 'client');
    vi.stubEnv(route.redirect, route.redirectValue);
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake-upstash.invalid');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { default: handler } = await import(route.modulePath);
    const res = await handler(requestFor(route.url));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain(route.host);
  });

  test(`${route.name} oauth start does not return a URL when Redis SET failed inside HTTP 200`, async () => {
    vi.stubEnv(route.clientId, 'client');
    vi.stubEnv(route.redirect, route.redirectValue);
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake-upstash.invalid');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ error: 'OOM' }]), { status: 200 })));
    const { default: handler } = await import(route.modulePath);
    const res = await handler(requestFor(route.url));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(route.host);
  });

  test(`${route.name} oauth start returns the authorize URL only after SET OK`, async () => {
    vi.stubEnv(route.clientId, 'client');
    vi.stubEnv(route.redirect, route.redirectValue);
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake-upstash.invalid');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ result: 'OK' }]), { status: 200 })));
    const { default: handler } = await import(route.modulePath);
    const res = await handler(requestFor(route.url));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.oauthUrl).toContain(route.host);
  });
}
