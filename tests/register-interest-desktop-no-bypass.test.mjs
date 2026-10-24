/**
 * registerInterest has exactly one anti-bot gate: server-side Turnstile.
 *
 * A `source: "desktop-settings"` request used to skip Turnstile when it carried
 * an HMAC over a shared desktop key. That path is deleted. These tests pin that
 * a desktop-source request is refused the same way a web request is, that no
 * header or environment switch reopens a bypass, and that a Turnstile-verified
 * desktop request still reaches Convex with `source` kept as a plain label.
 */

import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const CONVEX_BRIDGE_URL = 'https://fake-convex.site/api/internal-register-interest';
const RESEND_URL = 'https://api.resend.com/emails';

function makeCtx(headers = {}) {
  return {
    request: new Request('https://worldmonitor.app/api/leads/v1/register-interest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }),
    pathParams: {},
    headers,
  };
}

function signupReq(source, overrides = {}) {
  return {
    email: `${source}@example.com`,
    source,
    appVersion: '2.8.0',
    referredBy: '',
    website: '',
    turnstileToken: '',
    ...overrides,
  };
}

// The retired desktop signature: HMAC-SHA256 over `<timestamp>\n<canonical JSON>`
// with a key the server no longer knows about. A correctly formed one must be
// treated as noise.
function legacyDesktopHeaders(req, secret) {
  const timestamp = String(Date.now());
  const canonical = JSON.stringify({
    email: req.email,
    source: req.source,
    appVersion: req.appVersion,
    referredBy: req.referredBy,
    website: req.website,
    turnstileToken: req.turnstileToken,
  });
  const signature = `sha256=${createHmac('sha256', secret).update(`${timestamp}\n${canonical}`).digest('hex')}`;
  return {
    'x-worldmonitor-desktop-timestamp': timestamp,
    'x-worldmonitor-desktop-signature': signature,
  };
}

function stubNetwork({ turnstileSuccess, redis = null, convexStatus = 'registered' }) {
  const calls = { turnstile: [], convex: [], resend: [] };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const { origin } = new URL(url);
    if (redis && origin === 'https://redis.example') return redis.fetchImpl(input, init);
    if (url === TURNSTILE_VERIFY_URL) {
      calls.turnstile.push(Object.fromEntries(new URLSearchParams(init.body)));
      return Response.json({ success: turnstileSuccess });
    }
    if (origin === 'https://cloudflare-dns.com') {
      return Response.json({ Answer: [{ type: 15, data: '10 mx.example.com.' }] });
    }
    if (url === RESEND_URL) {
      calls.resend.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    if (url === CONVEX_BRIDGE_URL) {
      calls.convex.push({ headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({
        status: convexStatus,
        referralCode: 'ref123',
        referralCount: 9,
        position: 7,
        emailSuppressed: false,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}

let ApiError;
let mod;
let registerInterest;

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected registerInterest to reject');
}

describe('LeadsService.registerInterest has no desktop bypass', () => {
  beforeEach(async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.TURNSTILE_SECRET_KEY = 'turnstile-test-secret';
    process.env.CONVEX_SITE_URL = 'https://fake-convex.site';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'convex-test-secret';
    delete process.env.RESEND_API_KEY;

    mod = await import('../server/worldmonitor/leads/v1/register-interest.ts');
    registerInterest = mod.registerInterest;
    const gen = await import('../src/generated/server/worldmonitor/leads/v1/service_server.ts');
    ApiError = gen.ApiError;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  it('exports no desktop signing helpers or header constants', () => {
    assert.equal(mod.createDesktopAuthSignature, undefined);
    assert.deepEqual(Object.keys(mod).filter((name) => /desktop/i.test(name)), []);
  });

  it('refuses a desktop-source request without a Turnstile token exactly like a web request', async () => {
    const calls = stubNetwork({ turnstileSuccess: false });

    const desktop = await rejection(registerInterest(makeCtx(), signupReq('desktop-settings')));
    const web = await rejection(registerInterest(makeCtx(), signupReq('web-form')));

    for (const err of [desktop, web]) {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.message, 'Bot verification failed');
    }
    assert.equal(calls.turnstile.length, 2, 'both sources must be challenged by Turnstile');
    assert.deepEqual(calls.turnstile.map((call) => call.response), ['', '']);
    assert.equal(calls.convex.length, 0);
  });

  it('fails closed for a desktop-source request when Turnstile is unconfigured in production', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const calls = stubNetwork({ turnstileSuccess: true });

    const desktop = await rejection(registerInterest(makeCtx(), signupReq('desktop-settings')));
    const web = await rejection(registerInterest(makeCtx(), signupReq('web-form')));

    for (const err of [desktop, web]) {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 403);
      assert.equal(err.message, 'Bot verification failed');
    }
    assert.equal(calls.turnstile.length, 0);
    assert.equal(calls.convex.length, 0);
  });

  it('ignores legacy desktop signature headers and legacy environment switches', async () => {
    process.env.WM_DESKTOP_SHARED_SECRET = 'desktop-test-secret';
    process.env.WM_DESKTOP_AUTH_ALLOW_LEGACY = 'true';
    const calls = stubNetwork({ turnstileSuccess: false });
    const req = signupReq('desktop-settings');

    const signed = await rejection(
      registerInterest(makeCtx(legacyDesktopHeaders(req, 'desktop-test-secret')), req),
    );
    assert.ok(signed instanceof ApiError);
    assert.equal(signed.statusCode, 403);
    assert.equal(signed.message, 'Bot verification failed');

    delete process.env.TURNSTILE_SECRET_KEY;
    const unsigned = await rejection(registerInterest(makeCtx(), req));
    assert.ok(unsigned instanceof ApiError);
    assert.equal(unsigned.statusCode, 403);
    assert.equal(unsigned.message, 'Bot verification failed');

    assert.equal(calls.turnstile.length, 1);
    assert.equal(calls.convex.length, 0);
  });

  it('forwards a Turnstile-verified desktop-source signup through the same Convex path as a web signup', async () => {
    const redis = installRedis({}, { keepVercelEnv: true });
    process.env.RESEND_API_KEY = 'fake-resend-key';
    const calls = stubNetwork({ turnstileSuccess: true, redis });

    const req = signupReq('desktop-settings', { email: 'bridge@example.com', turnstileToken: 'desktop-token' });
    const result = await registerInterest(makeCtx({ 'x-forwarded-for': '203.0.113.9' }), req);

    assert.deepEqual(result, {
      status: 'registered',
      referralCode: '',
      referralCount: 0,
      position: 0,
      emailSuppressed: false,
    });
    assert.equal(calls.turnstile.length, 1);
    assert.equal(calls.turnstile[0].response, 'desktop-token');
    assert.equal(calls.convex.length, 1);
    assert.equal(calls.convex[0].headers['x-convex-shared-secret'], 'convex-test-secret');
    assert.equal(calls.convex[0].headers['User-Agent'], 'worldmonitor-leads/1.0');
    assert.deepEqual(calls.convex[0].body, {
      email: 'bridge@example.com',
      source: 'desktop-settings',
      appVersion: '2.8.0',
    });
    assert.equal(calls.resend.length, 1);
    assert.ok(calls.resend[0].html.includes('https://worldmonitor.app/pro?ref=ref123'));

    const touched = [...redis.redis.keys(), ...redis.sortedSets.keys()];
    assert.deepEqual(touched.filter((key) => key.includes('#desktop')), [], 'no desktop-scoped rate-limit key may remain');
  });

  it('hides existing-address membership and referral metadata on retries', async () => {
    const redis = installRedis({}, { keepVercelEnv: true });
    const calls = stubNetwork({ turnstileSuccess: true, redis, convexStatus: 'already_registered' });

    const req = signupReq('desktop-settings', { email: 'repeat@example.com', turnstileToken: 'desktop-token' });
    const result = await registerInterest(makeCtx(), req);

    assert.deepEqual(result, {
      status: 'registered',
      referralCode: '',
      referralCount: 0,
      position: 0,
      emailSuppressed: false,
    });
    assert.equal(calls.convex.length, 1);
    assert.equal(calls.resend.length, 0);
  });
});
