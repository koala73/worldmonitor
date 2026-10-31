// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/api-405-allow-header-ts.test.mjs`.
//
// RFC 9110 §15.5.6: a 405 response MUST carry an `Allow` header naming the
// methods the resource supports. This suite pins the TypeScript handlers
// whose method guard reached 405 without it. Each case sends a method the
// handler refuses and checks `Allow` against the handler's declared method
// list; where the handler answers OPTIONS with the same list, the preflight
// is checked too so the two cannot drift.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.WM_SESSION_SECRET ||= 'test-secret-must-be-at-least-32-chars-long-xxx';
process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';
// widget-agent checks its key before the method guard; notification-channels
// validates the bearer session and needs its Convex relay configured first.
process.env.WIDGET_AGENT_KEY ||= 'widget-agent-allow-test-key';
process.env.CONVEX_SITE_URL ||= 'https://example.convex.site';
process.env.CONVEX_TENANT_RELAY_SECRET ||= 'relay-secret-for-allow-test';

const ORIGIN = 'https://worldmonitor.app';
const load = async (path) => (await import(path)).default;

const CASES = [
  { name: 'latest-brief', path: '/api/latest-brief', module: '../api/latest-brief.ts', allow: 'GET, OPTIONS', refused: 'POST', preflight: true },
  { name: 'chat-analyst', path: '/api/chat-analyst', module: '../api/chat-analyst.ts', allow: 'POST, OPTIONS', refused: 'GET', preflight: true },
  { name: 'customer-portal', path: '/api/customer-portal', module: '../api/customer-portal.ts', allow: 'GET, POST, OPTIONS', refused: 'PUT', preflight: true },
  { name: 'invalidate-user-api-key-cache', path: '/api/invalidate-user-api-key-cache', module: '../api/invalidate-user-api-key-cache.ts', allow: 'POST, OPTIONS', refused: 'GET', preflight: true },
  { name: 'channel-oauth-bind', path: '/api/channel-oauth-bind', module: '../api/channel-oauth-bind.ts', allow: 'POST', refused: 'GET', preflight: false },
  { name: 'notify', path: '/api/notify', module: '../api/notify.ts', allow: 'POST, OPTIONS', refused: 'GET', preflight: true },
  { name: 'create-checkout', path: '/api/create-checkout', module: '../api/create-checkout.ts', allow: 'POST, OPTIONS', refused: 'GET', preflight: true },
  { name: 'widget-agent', path: '/api/widget-agent', module: '../api/widget-agent.ts', allow: 'GET, POST, OPTIONS', refused: 'PUT', preflight: true, headers: { 'X-Widget-Key': process.env.WIDGET_AGENT_KEY } },
  { name: 'symbol-search', path: '/api/symbol-search', module: '../api/symbol-search.ts', allow: 'GET, OPTIONS', refused: 'POST', preflight: true },
  {
    name: 'notification-channels', path: '/api/notification-channels', module: '../api/notification-channels.ts', allow: 'GET, POST, OPTIONS', refused: 'PUT', preflight: true,
    headers: { Authorization: 'Bearer allow-test-session' },
    prepare: async () => {
      const { __setNotificationChannelsDepsForTests } = await import('../api/notification-channels.ts');
      __setNotificationChannelsDepsForTests({ validateBearerToken: async () => ({ valid: true, userId: 'allow-test-user' }) });
    },
  },
  { name: 'referral/me', path: '/api/referral/me', module: '../api/referral/me.ts', allow: 'GET, OPTIONS', refused: 'POST', preflight: true },
  { name: 'oauth/token', path: '/oauth/token', module: '../api/oauth/token.ts', allow: 'POST, OPTIONS', refused: 'GET', preflight: true },
  { name: 'internal/brief-why-matters', path: '/api/internal/brief-why-matters', module: '../api/internal/brief-why-matters.ts', allow: 'POST', refused: 'GET', preflight: false },
  { name: 'brief/share-url', path: '/api/brief/share-url', module: '../api/brief/share-url.ts', allow: 'POST, OPTIONS', refused: 'GET', preflight: true },
  { name: 'skills/fetch-agentskills', path: '/api/skills/fetch-agentskills', module: '../api/skills/fetch-agentskills.ts', allow: 'POST, OPTIONS', refused: 'GET', preflight: false },
  { name: 'brief/carousel', path: '/api/brief/carousel/user/2026-10-30/1', module: '../api/brief/carousel/[userId]/[issueDate]/[page].ts', allow: 'GET, HEAD, OPTIONS', refused: 'POST', preflight: false },
  { name: 'brief/public', path: '/api/brief/public/abc', module: '../api/brief/public/[hash].ts', allow: 'GET, HEAD, OPTIONS', refused: 'POST', preflight: false },
  { name: 'brief/[userId]', path: '/api/brief/user/2026-10-30', module: '../api/brief/[userId]/[issueDate].ts', allow: 'GET, HEAD, OPTIONS', refused: 'POST', preflight: false },
  { name: 'v2/shipping/webhooks/[subscriberId]/[action]', path: '/api/v2/shipping/webhooks/sub/test', module: '../api/v2/shipping/webhooks/[subscriberId]/[action].ts', allow: 'POST, OPTIONS', refused: 'GET', preflight: true },
  { name: 'v2/shipping/webhooks/[subscriberId]', path: '/api/v2/shipping/webhooks/sub', module: '../api/v2/shipping/webhooks/[subscriberId].ts', allow: 'GET, DELETE, OPTIONS', refused: 'POST', preflight: true },
];

const ctx = { waitUntil() {} };

describe('TypeScript handler 405 responses carry an Allow header', () => {
  for (const { name, path, module, allow, refused, preflight, headers = {}, prepare } of CASES) {
    it(`${name}: ${refused} is refused with Allow: ${allow}`, async () => {
      const handler = await load(module);
      await prepare?.();
      const res = await handler(new Request(`${ORIGIN}${path}`, {
        method: refused,
        headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
        ...(refused === 'GET' || refused === 'HEAD' ? {} : { body: '{}' }),
      }), ctx);
      assert.equal(res.status, 405, `${name} must answer 405 to ${refused}`);
      assert.equal(res.headers.get('allow'), allow, `${name} must name its supported methods`);
    });

    if (preflight) {
      it(`${name}: Allow matches the preflight method list`, async () => {
        const handler = await load(module);
        const res = await handler(new Request(`${ORIGIN}${path}`, {
          method: 'OPTIONS',
          headers: { origin: ORIGIN, 'access-control-request-method': allow.split(',')[0].trim() },
        }), ctx);
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-methods'), allow);
      });
    }
  }
});
