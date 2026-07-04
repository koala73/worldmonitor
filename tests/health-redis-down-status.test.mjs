import { test } from 'node:test';
import assert from 'node:assert/strict';

// /api/health returns HTTP 503 ONLY for the hard-down REDIS_DOWN state, so a
// plain HTTP-status monitor (UptimeRobot, k8s probe, LB) detects a total
// backend outage. Every other state (HEALTHY/WARNING/DEGRADED/UNHEALTHY)
// intentionally returns 200 with the status in the body — see #2699, which
// moved off per-severity HTTP codes to stop warn-level seed jitter from
// flapping HTTP monitors.
//
// Run: node --test tests/health-redis-down-status.test.mjs

// Force the no-credentials path: with no Upstash/KV/Redis REST env vars set,
// getRedisCredentials() returns null → the handler throws → REDIS_DOWN.
for (const k of [
  'UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'REDIS_REST_TOKEN',
]) delete process.env[k];
process.env.WORLDMONITOR_VALID_KEYS = 'test-health-admin-key';

const { default: handler } = await import('../api/health.js');

test('detailed health requires an operator API key before Redis is queried', async () => {
  // Real Request (no Origin header) — the handler reads req.headers.get('origin')
  // via isDisallowedOrigin/getCorsHeaders, so a plain object would crash.
  const req = new Request('https://api.worldmonitor.app/api/health');
  const res = await handler(req);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'API key required');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
});

test('health history requires an operator API key before Redis is queried', async () => {
  const req = new Request('https://api.worldmonitor.app/api/health?history=1');
  const res = await handler(req);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'API key required');
});

test('detailed health does not expose user-key gateway fallback internals', async () => {
  const req = new Request('https://api.worldmonitor.app/api/health', {
    headers: { 'x-worldmonitor-key': 'wm_user_abc123' },
  });
  const res = await handler(req);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'Invalid API key');
});

test('compact health remains public and REDIS_DOWN returns HTTP 503', async () => {
  const req = new Request('https://api.worldmonitor.app/api/health?compact=1');
  const res = await handler(req);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'REDIS_DOWN');
  assert.ok('checkedAt' in body, 'snapshot must carry checkedAt');
  // No Origin → getCorsHeaders falls back to the canonical app origin (the
  // origin-gated handler does not emit ACAO:* for unknown/absent origins).
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
});

test('authenticated detailed health can reach the Redis-down probe', async () => {
  const req = new Request('https://api.worldmonitor.app/api/health', {
    headers: { 'x-worldmonitor-key': 'test-health-admin-key' },
  });
  const res = await handler(req);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'REDIS_DOWN');
  assert.ok('checkedAt' in body, 'snapshot must carry checkedAt');
  // No Origin → getCorsHeaders falls back to the canonical app origin (the
  // origin-gated handler does not emit ACAO:* for unknown/absent origins).
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
});

test('OPTIONS preflight returns 204 (never 503)', async () => {
  const req = new Request('https://api.worldmonitor.app/api/health', { method: 'OPTIONS' });
  const res = await handler(req);
  assert.equal(res.status, 204);
});

test('disallowed Origin is rejected with 403 before any Redis work', async () => {
  const req = new Request('https://api.worldmonitor.app/api/health', {
    headers: { origin: 'https://evil.example.com' },
  });
  const res = await handler(req);
  assert.equal(res.status, 403);
});
