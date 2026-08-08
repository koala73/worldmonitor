import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './bootstrap.js';
import { issueSessionToken } from './_session.js';

function makePreflight(origin) {
  return new Request('https://api.worldmonitor.app/api/bootstrap?keys=techReadiness', {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
    },
  });
}

test('bootstrap preflight is compatible with credentialed browser fetches', async () => {
  const resp = await handler(makePreflight('https://www.worldmonitor.app'));

  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-origin'), 'https://www.worldmonitor.app');
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(resp.headers.get('vary'), 'Origin');
});

test('bootstrap GET response is compatible with credentialed browser fetches', async () => {
  const previousSecret = process.env.WM_SESSION_SECRET;
  process.env.WM_SESSION_SECRET = 'test-secret-for-bootstrap-cors-guardrail';
  try {
    const { token } = await issueSessionToken();
    const resp = await handler(new Request('https://api.worldmonitor.app/api/bootstrap?keys=techReadiness', {
      method: 'GET',
      headers: {
        origin: 'https://www.worldmonitor.app',
        cookie: `wm-session=${token}`,
      },
    }));

    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('access-control-allow-origin'), 'https://www.worldmonitor.app');
    assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(resp.headers.get('vary'), 'Origin');
  } finally {
    if (previousSecret === undefined) {
      delete process.env.WM_SESSION_SECRET;
    } else {
      process.env.WM_SESSION_SECRET = previousSecret;
    }
  }
});
