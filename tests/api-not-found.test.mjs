import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import handler from '../api/not-found.ts';

const URL_BASE = 'https://worldmonitor.app';

describe('api/not-found.ts — structured JSON 404 for unmatched /api/* paths', () => {
  it('returns a 404 application/json envelope with code, message, and a resolution hint', async () => {
    const res = handler(new Request(`${URL_BASE}/api/does-not-exist`, { method: 'GET' }));
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'reflected-path body must be nosniff');
    const body = await res.json();
    assert.equal(body.error?.code, 'not_found');
    assert.ok(typeof body.error?.message === 'string' && body.error.message.length > 0, 'message must be present');
    assert.ok(body.error.message.includes('/api/does-not-exist'), 'message must echo the requested path');
    assert.ok(typeof body.error?.hint === 'string' && body.error.hint.length > 0, 'hint must be present');
    assert.ok(typeof body.documentation === 'string', 'documentation URL must be present');
  });

  it('is CORS-enabled (agents / cross-origin scanners can read the error)', async () => {
    const res = handler(new Request(`${URL_BASE}/api/x`, { method: 'GET' }));
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('answers an OPTIONS preflight with 204 + CORS', async () => {
    const res = handler(new Request(`${URL_BASE}/api/x`, { method: 'OPTIONS' }));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
  });

  it('never caches (a 404 must not be served as a cached 200 for a later-added route)', async () => {
    const res = handler(new Request(`${URL_BASE}/api/x`, { method: 'GET' }));
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  });
});
