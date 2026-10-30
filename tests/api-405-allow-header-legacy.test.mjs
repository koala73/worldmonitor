// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/api-405-allow-header-legacy.test.mjs`.
//
// RFC 9110 §15.5.6: a 405 response MUST carry an `Allow` header naming the
// methods the resource supports. This suite pins the legacy JavaScript
// handlers whose method guard reached 405 without it. Each case sends a
// method the handler refuses and checks `Allow` against the method list the
// handler advertises on its own OPTIONS preflight, so the two cannot drift.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const { default: productCatalog } = await import('../api/product-catalog.js');
const { default: cachePurge } = await import('../api/cache-purge.js');
const { default: correlationRuntimeMode } = await import('../api/correlation-runtime-mode.js');
const { default: xFeed } = await import('../api/x-feed.js');
const { default: telegramFeed } = await import('../api/telegram-feed.js');
const { default: securityReport } = await import('../api/security/report.js');

const ORIGIN = 'https://worldmonitor.app';

const CASES = [
  { name: 'product-catalog', path: '/api/product-catalog', handler: productCatalog, allow: 'GET, DELETE, OPTIONS', refused: 'PUT' },
  { name: 'cache-purge', path: '/api/cache-purge', handler: cachePurge, allow: 'POST, OPTIONS', refused: 'GET' },
  { name: 'correlation-runtime-mode', path: '/api/correlation-runtime-mode', handler: correlationRuntimeMode, allow: 'GET, OPTIONS', refused: 'POST' },
  { name: 'x-feed', path: '/api/x-feed', handler: xFeed, allow: 'GET, OPTIONS', refused: 'POST' },
  { name: 'telegram-feed', path: '/api/telegram-feed', handler: telegramFeed, allow: 'GET, OPTIONS', refused: 'POST' },
  { name: 'security/report', path: '/api/security/report', handler: securityReport, allow: 'POST, OPTIONS', refused: 'GET' },
];

const ctx = { waitUntil() {} };

describe('legacy handler 405 responses carry an Allow header', () => {
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
