import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

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

function desktopReq(overrides = {}) {
  return {
    email: 'desktop@example.com',
    source: 'desktop-settings',
    appVersion: '2.8.0',
    referredBy: '',
    website: '',
    turnstileToken: '',
    ...overrides,
  };
}

let ApiError;
let registerInterest;
let createDesktopAuthSignature;
let timestampHeader;
let signatureHeader;
let desktopAuthWindowMs;

describe('LeadsService.registerInterest desktop auth', () => {
  beforeEach(async () => {
    process.env.WM_DESKTOP_SHARED_SECRET = 'desktop-test-secret';
    process.env.CONVEX_URL = 'https://fake-convex.cloud';
    process.env.VERCEL_ENV = 'production';
    delete process.env.WM_DESKTOP_AUTH_ALLOW_LEGACY;

    const mod = await import('../server/worldmonitor/leads/v1/register-interest.ts');
    registerInterest = mod.registerInterest;
    createDesktopAuthSignature = mod.createDesktopAuthSignature;
    timestampHeader = mod.DESKTOP_AUTH_TIMESTAMP_HEADER;
    signatureHeader = mod.DESKTOP_AUTH_SIGNATURE_HEADER;
    desktopAuthWindowMs = mod.DESKTOP_AUTH_WINDOW_MS;
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

  it('rejects unsigned desktop-source Turnstile bypass when shared secret is configured', async () => {
    await assert.rejects(
      () => registerInterest(makeCtx(), desktopReq()),
      (err) => err instanceof ApiError && err.statusCode === 403 && /desktop authentication/i.test(err.message),
    );
  });

  it('rejects unsigned legacy desktop requests when shared secret is configured', async () => {
    process.env.WM_DESKTOP_AUTH_ALLOW_LEGACY = 'true';

    await assert.rejects(
      () => registerInterest(makeCtx(), desktopReq()),
      (err) => err instanceof ApiError && err.statusCode === 403 && /desktop authentication/i.test(err.message),
    );
  });

  it('rejects stale desktop signatures', async () => {
    const req = desktopReq();
    const timestamp = String(Date.now() - desktopAuthWindowMs - 1_000);
    const signature = await createDesktopAuthSignature(process.env.WM_DESKTOP_SHARED_SECRET, timestamp, req);

    await assert.rejects(
      () => registerInterest(makeCtx({ [timestampHeader]: timestamp, [signatureHeader]: signature }), req),
      (err) => err instanceof ApiError && err.statusCode === 403,
    );
  });

  it('rejects tampered desktop signatures before Convex storage', async () => {
    const req = desktopReq();
    const timestamp = String(Date.now());
    const signature = await createDesktopAuthSignature(process.env.WM_DESKTOP_SHARED_SECRET, timestamp, req);

    await assert.rejects(
      () => registerInterest(makeCtx({ [timestampHeader]: timestamp, [signatureHeader]: signature }), {
        ...req,
        email: 'tampered@example.com',
      }),
      (err) => err instanceof ApiError && err.statusCode === 403,
    );
  });

  it('canonicalizes only string fields for desktop signatures', async () => {
    const timestamp = String(Date.now());
    const signatureWithNonStrings = await createDesktopAuthSignature(
      process.env.WM_DESKTOP_SHARED_SECRET,
      timestamp,
      desktopReq({
        appVersion: 280,
        referredBy: ['abc'],
        website: { bot: true },
        turnstileToken: false,
      }),
    );
    const signatureWithEmptyStrings = await createDesktopAuthSignature(
      process.env.WM_DESKTOP_SHARED_SECRET,
      timestamp,
      desktopReq({
        appVersion: '',
        referredBy: '',
        website: '',
        turnstileToken: '',
      }),
    );

    assert.equal(signatureWithNonStrings, signatureWithEmptyStrings);
  });

  it('allows unsigned legacy desktop requests only when rollout fallback is enabled and shared secret is unset', async () => {
    process.env.WM_DESKTOP_AUTH_ALLOW_LEGACY = 'true';
    delete process.env.WM_DESKTOP_SHARED_SECRET;
    delete process.env.CONVEX_URL;

    await assert.rejects(
      () => registerInterest(makeCtx(), desktopReq()),
      (err) => err instanceof ApiError && err.statusCode === 503,
    );
  });

  it('rejects desktop bypass when shared secret is missing', async () => {
    delete process.env.WM_DESKTOP_SHARED_SECRET;

    await assert.rejects(
      () => registerInterest(makeCtx(), desktopReq()),
      (err) => err instanceof ApiError && err.statusCode === 403 && /desktop authentication/i.test(err.message),
    );
  });

  it('accepts a valid desktop signature and continues past auth', async () => {
    const req = desktopReq();
    const timestamp = String(Date.now());
    const signature = await createDesktopAuthSignature(process.env.WM_DESKTOP_SHARED_SECRET, timestamp, req);
    delete process.env.CONVEX_URL;

    await assert.rejects(
      () => registerInterest(makeCtx({ [timestampHeader]: timestamp, [signatureHeader]: signature }), req),
      (err) => err instanceof ApiError && err.statusCode === 503,
    );
  });

  it('forwards validated signups through the secret-guarded Convex HTTP bridge', async () => {
    const redis = installRedis({});
    process.env.CONVEX_SITE_URL = 'https://fake-convex.site';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'convex-test-secret';
    process.env.RESEND_API_KEY = 'fake-resend-key';

    const req = desktopReq({ email: 'bridge@example.com' });
    const timestamp = String(Date.now());
    const signature = await createDesktopAuthSignature(
      process.env.WM_DESKTOP_SHARED_SECRET,
      timestamp,
      req,
    );
    let captured;
    let confirmation;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('https://redis.example')) {
        return redis.fetchImpl(input, init);
      }
      if (url.startsWith('https://cloudflare-dns.com')) {
        return new Response(JSON.stringify({ Answer: [{ type: 15, data: '10 mx.example.com.' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/dns-json' },
        });
      }
      if (url === 'https://api.resend.com/emails') {
        confirmation = JSON.parse(init.body);
        return new Response('{}', { status: 200 });
      }
      captured = { url, init };
      return new Response(JSON.stringify({
        status: 'registered',
        referralCode: 'ref123',
        referralCount: 0,
        position: 7,
        emailSuppressed: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await registerInterest(
      makeCtx({ [timestampHeader]: timestamp, [signatureHeader]: signature }),
      req,
    );

    assert.deepEqual(result, {
      status: 'registered',
      referralCode: '',
      referralCount: 0,
      position: 0,
      emailSuppressed: false,
    });
    assert.equal(captured.url, 'https://fake-convex.site/api/internal-register-interest');
    assert.equal(captured.init.headers['x-convex-shared-secret'], 'convex-test-secret');
    assert.equal(captured.init.headers['User-Agent'], 'worldmonitor-leads/1.0');
    assert.deepEqual(JSON.parse(captured.init.body), {
      email: 'bridge@example.com',
      source: 'desktop-settings',
      appVersion: '2.8.0',
    });
    assert.ok(confirmation.html.includes('https://worldmonitor.app/pro?ref=ref123'));
  });

  it('hides existing-address membership and referral metadata on retries', async () => {
    const redis = installRedis({});
    process.env.CONVEX_SITE_URL = 'https://fake-convex.site';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'convex-test-secret';

    const req = desktopReq({ email: 'repeat@example.com' });
    const timestamp = String(Date.now());
    const signature = await createDesktopAuthSignature(
      process.env.WM_DESKTOP_SHARED_SECRET,
      timestamp,
      req,
    );
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('https://redis.example')) return redis.fetchImpl(input, init);
      if (url.startsWith('https://cloudflare-dns.com')) {
        return new Response(JSON.stringify({ Answer: [{ type: 15, data: '10 mx.example.com.' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/dns-json' },
        });
      }
      return new Response(JSON.stringify({
        status: 'already_registered',
        referralCode: 'secret-referral-code',
        referralCount: 9,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await registerInterest(
      makeCtx({ [timestampHeader]: timestamp, [signatureHeader]: signature }),
      req,
    );
    assert.deepEqual(result, {
      status: 'registered',
      referralCode: '',
      referralCount: 0,
      position: 0,
      emailSuppressed: false,
    });
  });
});
