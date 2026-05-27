import { strict as assert } from 'node:assert';
import test from 'node:test';

const SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
process.env.WM_SESSION_SECRET = SECRET;
process.env.WIDGET_AGENT_KEY = 'widget-secret';
process.env.PRO_WIDGET_KEY = 'pro-secret';
process.env.WORLDMONITOR_VALID_KEYS = 'enterprise-secret';

const { default: handler } = await import('./wm-session.js');
const { validateSessionToken } = await import('./_session.js');

function makeReq(method, { origin } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  return new Request('https://api.worldmonitor.app/api/wm-session', { method, headers });
}

function makeLocalReq(method, { origin } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  return new Request('http://localhost:5173/api/wm-session', { method, headers });
}

function setCookies(resp) {
  return resp.headers.getSetCookie ? resp.headers.getSetCookie() : [resp.headers.get('set-cookie')].filter(Boolean);
}

function cookieValue(cookies, name) {
  const prefix = `${name}=`;
  const found = cookies.find((cookie) => cookie.startsWith(prefix));
  if (!found) return '';
  return decodeURIComponent(found.slice(prefix.length).split(';')[0]);
}

function finalCookieJar(cookies) {
  const jar = new Map();
  for (const cookie of cookies) {
    const [nameValue, ...attrs] = cookie.split(';').map((part) => part.trim());
    const [name, encodedValue = ''] = nameValue.split('=');
    const domainAttr = attrs.find((attr) => attr.toLowerCase().startsWith('domain='));
    const pathAttr = attrs.find((attr) => attr.toLowerCase().startsWith('path='));
    const maxAgeAttr = attrs.find((attr) => attr.toLowerCase().startsWith('max-age='));
    const domain = domainAttr ? domainAttr.slice('domain='.length).toLowerCase() : 'api.worldmonitor.app';
    const path = pathAttr ? pathAttr.slice('path='.length) : '/';
    const key = `${name};${domain};${path}`;
    if (maxAgeAttr && Number(maxAgeAttr.slice('max-age='.length)) <= 0) {
      jar.delete(key);
      continue;
    }
    jar.set(key, decodeURIComponent(encodedValue));
  }
  return jar;
}

test('POST from trusted origin sets a valid HttpOnly wms_ session cookie without exposing token JSON', async () => {
  const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.token, undefined);
  assert.equal(typeof body.exp, 'number');
  const cookies = setCookies(resp);
  const token = cookieValue(cookies, 'wm-session');
  assert.match(token, /^wms_/);
  assert.equal(await validateSessionToken(token), true);
  assert.match(cookies.join('\n'), /wm-session=.*HttpOnly/);
  assert.match(cookies.join('\n'), /wm-session=.*Domain=\.worldmonitor\.app/);
});

test('localhost session cookie remains host-only for dev', async () => {
  const resp = await handler(makeLocalReq('POST', { origin: 'http://localhost:5173' }));
  assert.equal(resp.status, 200);
  const cookies = setCookies(resp);
  const session = cookies.find((cookie) => cookie.startsWith('wm-session='));
  assert.ok(session, 'wm-session cookie should be set');
  assert.doesNotMatch(session, /Domain=/);
});

test('OPTIONS preflight returns 204 with CORS', async () => {
  const resp = await handler(makeReq('OPTIONS', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
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
  assert.equal(body.token, undefined);
  assert.match(cookieValue(setCookies(resp), 'wm-session'), /^wms_/);
});

test('no-key session refresh preserves existing HttpOnly key cookies', async () => {
  const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 200);
  const cookies = setCookies(resp);
  assert.ok(cookies.some((cookie) => cookie.startsWith('wm-session=')));
  assert.equal(cookies.some((cookie) => cookie.startsWith('wm-widget-key=')), false);
  assert.equal(cookies.some((cookie) => cookie.startsWith('wm-pro-key=')), false);
});

test('legacy widget/pro keys are moved into short-lived HttpOnly cookies', async () => {
  const req = new Request('https://api.worldmonitor.app/api/wm-session', {
    method: 'POST',
    headers: {
      origin: 'https://worldmonitor.app',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ widgetKey: 'widget-secret', proKey: 'pro-secret' }),
  });
  const resp = await handler(req);
  assert.equal(resp.status, 200);
  const cookies = setCookies(resp);
  const joined = cookies.join('\n');
  assert.match(joined, /wm-widget-key=widget-secret;.*HttpOnly/);
  assert.match(joined, /wm-pro-key=pro-secret;.*HttpOnly/);
  assert.match(joined, /wm-widget-key=widget-secret;.*Domain=\.worldmonitor\.app/);
  assert.match(joined, /wm-pro-key=pro-secret;.*Domain=\.worldmonitor\.app/);
  assert.match(joined, /Max-Age=43200/);
});

test('enterprise key can be exchanged into a short-lived HttpOnly pro cookie', async () => {
  const req = new Request('https://api.worldmonitor.app/api/wm-session', {
    method: 'POST',
    headers: {
      origin: 'https://worldmonitor.app',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ proKey: 'enterprise-secret' }),
  });
  const resp = await handler(req);
  assert.equal(resp.status, 200);
  const cookies = setCookies(resp);
  assert.match(cookies.join('\n'), /wm-pro-key=enterprise-secret;.*HttpOnly/);
});

test('invalid legacy keys are rejected and not persisted as HttpOnly cookies', async () => {
  const req = new Request('https://api.worldmonitor.app/api/wm-session', {
    method: 'POST',
    headers: {
      origin: 'https://worldmonitor.app',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ widgetKey: 'wrong-widget-key', proKey: 'wrong-pro-key' }),
  });
  const resp = await handler(req);
  assert.equal(resp.status, 401);
  const body = await resp.json();
  assert.equal(body.error, 'Invalid session key');
  const joined = setCookies(resp).join('\n');
  assert.doesNotMatch(joined, /wm-widget-key=wrong-widget-key/);
  assert.doesNotMatch(joined, /wm-pro-key=wrong-pro-key/);
});

test('legacy cookie tombstones do not delete replacement HttpOnly key cookies', async () => {
  const req = new Request('https://api.worldmonitor.app/api/wm-session', {
    method: 'POST',
    headers: {
      origin: 'https://worldmonitor.app',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ widgetKey: 'widget-secret', proKey: 'pro-secret' }),
  });
  const resp = await handler(req);
  assert.equal(resp.status, 200);
  const jar = finalCookieJar(setCookies(resp));
  assert.equal(jar.get('wm-widget-key;.worldmonitor.app;/'), 'widget-secret');
  assert.equal(jar.get('wm-pro-key;.worldmonitor.app;/'), 'pro-secret');
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
