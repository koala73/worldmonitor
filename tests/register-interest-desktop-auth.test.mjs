import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

const originalEnv = { ...process.env };

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
});
