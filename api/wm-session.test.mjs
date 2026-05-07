import { strict as assert } from 'node:assert';
import test from 'node:test';

const SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
process.env.WM_SESSION_SECRET = SECRET;

const { default: handler } = await import('./wm-session.js');
const { validateSessionToken } = await import('./_session.js');

function makeReq(method, { origin } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  return new Request('https://api.worldmonitor.app/api/wm-session', { method, headers });
}

test('POST from trusted origin returns a valid wms_ token', async () => {
  const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.match(body.token, /^wms_/);
  assert.equal(typeof body.exp, 'number');
  assert.equal(await validateSessionToken(body.token), true);
});

test('OPTIONS preflight returns 204 with CORS', async () => {
  const resp = await handler(makeReq('OPTIONS', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

test('GET method is rejected with 405', async () => {
  const resp = await handler(makeReq('GET', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 405);
});

test('Disallowed origin gets 403', async () => {
  const resp = await handler(makeReq('POST', { origin: 'https://evil.example.com' }));
  assert.equal(resp.status, 403);
});

test('No origin (curl) is allowed (rate limit + token TTL are the throttles)', async () => {
  const resp = await handler(makeReq('POST', {}));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.match(body.token, /^wms_/);
});

test('Returns 503 when WM_SESSION_SECRET is missing', async () => {
  const stash = process.env.WM_SESSION_SECRET;
  delete process.env.WM_SESSION_SECRET;
  try {
    const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }));
    assert.equal(resp.status, 503);
    const body = await resp.json();
    assert.match(body.error, /Session service not configured/);
  } finally {
    process.env.WM_SESSION_SECRET = stash;
  }
});
