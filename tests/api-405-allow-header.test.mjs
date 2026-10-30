// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/api-405-allow-header.test.mjs`.
//
// RFC 9110 §15.5.6: a 405 response MUST carry an `Allow` header naming the
// methods the resource supports. Most entry points already do; this suite pins
// the handlers that reached their method guard without it. Each case sends a
// method the handler refuses and checks that `Allow` matches the method list
// the handler advertises on its CORS preflight, so the two cannot drift apart.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.WM_SESSION_SECRET ||= 'test-secret-must-be-at-least-32-chars-long-xxx';
process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const { default: oauthRegister } = await import('../api/oauth/register.js');
const { default: wmSession } = await import('../api/wm-session.js');
const { default: analyticsHealth } = await import('../api/analytics-health.js');
const { createRelayHandler } = await import('../api/_relay.js');
const { default: userPrefs } = await import('../api/user-prefs.ts');
const { default: notificationSuppressions } = await import('../api/notification-suppressions.js');
const { default: rssProxy } = await import('../api/rss-proxy.js');

const ORIGIN = 'https://worldmonitor.app';

/** @type {Array<{ name: string, path: string, handler: (req: Request, ctx?: unknown) => Promise<Response>, allow: string, refused: string }>} */
const CASES = [
  { name: 'oauth/register', path: '/oauth/register', handler: oauthRegister, allow: 'POST, OPTIONS', refused: 'PUT' },
  { name: 'wm-session', path: '/api/wm-session', handler: wmSession, allow: 'POST, OPTIONS', refused: 'GET' },
  { name: 'analytics-health', path: '/api/analytics-health', handler: analyticsHealth, allow: 'POST, OPTIONS', refused: 'GET' },
  { name: 'relay handler', path: '/api/relay-test', handler: createRelayHandler({ relayPath: '/relay-test' }), allow: 'GET, OPTIONS', refused: 'POST' },
  { name: 'user-prefs', path: '/api/user-prefs', handler: userPrefs, allow: 'GET, POST, OPTIONS', refused: 'DELETE' },
  { name: 'notification-suppressions', path: '/api/notification-suppressions', handler: notificationSuppressions, allow: 'GET, OPTIONS', refused: 'POST' },
  { name: 'rss-proxy', path: '/api/rss-proxy', handler: rssProxy, allow: 'GET, OPTIONS', refused: 'POST' },
];

const ctx = { waitUntil() {} };

describe('405 responses carry an Allow header', () => {
  for (const { name, path, handler, allow, refused } of CASES) {
    it(`${name}: ${refused} is refused with Allow: ${allow}`, async () => {
      const res = await handler(new Request(`${ORIGIN}${path}`, {
        method: refused,
        headers: { origin: ORIGIN },
        ...(refused === 'GET' ? {} : { body: '{}' }),
      }), ctx);
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), allow, `${name} must name its supported methods`);
    });

    it(`${name}: Allow matches the preflight method list`, async () => {
      const preflight = await handler(new Request(`${ORIGIN}${path}`, {
        method: 'OPTIONS',
        headers: { origin: ORIGIN, 'access-control-request-method': allow.split(',')[0].trim() },
      }), ctx);
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-methods'), allow);
    });
  }
});
