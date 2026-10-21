import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import catchAll, { config } from '../api/[...notfound].ts';
import notFound from '../api/not-found.ts';

function isShadowingApiNotFoundRewrite(rewrite) {
  if (rewrite?.destination !== '/api/not-found') return false;
  return /^\/api\/(?::[^/]*\*|\(\.\*\))$/.test(rewrite.source ?? '');
}

// Regression guard for #4724: the `/api/:path*` -> /api/not-found rewrite (#4698)
// was an afterFiles rewrite that shadowed every dynamic `api/<svc>/v1/[rpc].ts`
// gateway, 404ing the entire versioned REST surface in production. The fix moves
// the JSON-404 handler to a filesystem catch-all (`api/[...notfound].ts`), which
// has the lowest dynamic-route precedence and so cannot shadow real endpoints.
describe('api/[...notfound].ts — filesystem catch-all replaces the shadowing rewrite (#4724)', () => {
  it('delegates to the shared api/not-found.ts handler', () => {
    assert.equal(catchAll, notFound, 'catch-all must re-export the shared not-found handler (single source of truth)');
  });

  it('runs on the edge runtime', () => {
    assert.equal(config?.runtime, 'edge');
  });

  it('returns the structured JSON 404 envelope for an unmatched path', async () => {
    const res = catchAll(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes', { method: 'GET' }));
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error?.code, 'not_found');
    assert.ok(body.error.message.includes('/api/seismology/v1/list-earthquakes'), 'message must echo the requested path');
  });

  it('detects equivalent broad API rewrites that would shadow dynamic gateways', () => {
    for (const source of ['/api/:path*', '/api/:slug*', '/api/(.*)']) {
      assert.equal(isShadowingApiNotFoundRewrite({ source, destination: '/api/not-found' }), true, `${source} must be blocked`);
    }

    assert.equal(isShadowingApiNotFoundRewrite({ source: '/api/health', destination: '/api/not-found' }), false);
    assert.equal(isShadowingApiNotFoundRewrite({ source: '/mcp', destination: '/api/mcp' }), false);
  });

  it('vercel.json no longer contains a broad API rewrite that shadows dynamic gateways', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    const shadow = (vercel.rewrites ?? []).find(isShadowingApiNotFoundRewrite);
    assert.equal(
      shadow,
      undefined,
      'do not reintroduce a broad /api/* -> /api/not-found rewrite; it shadows dynamic [rpc].ts gateways (#4724). Use the api/[...notfound].ts filesystem catch-all instead.',
    );
  });
});
