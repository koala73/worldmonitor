import assert from 'node:assert/strict';
import test from 'node:test';
import { getClientIp, verifyTurnstile } from '../server/_shared/turnstile.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalConsoleError = console.error;

function restoreEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  restoreEnv();
});

test('getClientIp prefers cf-connecting-ip, then x-real-ip', () => {
  const request = new Request('https://worldmonitor.app/api/test', {
    headers: {
      'x-forwarded-for': '198.51.100.8, 203.0.113.10',
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '192.0.2.5',
    },
  });

  assert.equal(getClientIp(request), '203.0.113.7');
});

test('getClientIp falls back to x-real-ip when cf-connecting-ip is absent', () => {
  const request = new Request('https://worldmonitor.app/api/test', {
    headers: {
      'x-forwarded-for': '198.51.100.8',
      'x-real-ip': '192.0.2.5',
    },
  });

  assert.equal(getClientIp(request), '192.0.2.5');
});

test('getClientIp ignores spoofable x-forwarded-for and returns unknown sentinel (#3531)', () => {
  // Direct request bypassing Cloudflare: only x-forwarded-for present.
  // Must NOT be honoured — caller-supplied identity would let an attacker
  // rotate buckets and beat the per-IP rate-limit window.
  const request = new Request('https://worldmonitor.app/api/test', {
    headers: { 'x-forwarded-for': '198.51.100.8, 203.0.113.10' },
  });

  assert.equal(getClientIp(request), 'unknown');
});

test('verifyTurnstile allows missing secret when policy is allow', async () => {
  delete process.env.TURNSTILE_SECRET_KEY;
  process.env.VERCEL_ENV = 'production';

  const ok = await verifyTurnstile({
    token: 'token',
    ip: '192.0.2.1',
    missingSecretPolicy: 'allow',
  });

  assert.equal(ok, true);
});

test('verifyTurnstile rejects missing secret in production when policy is allow-in-development', async () => {
  delete process.env.TURNSTILE_SECRET_KEY;
  process.env.VERCEL_ENV = 'production';
  console.error = () => {};

  const ok = await verifyTurnstile({
    token: 'token',
    ip: '192.0.2.1',
    logPrefix: '[test]',
    missingSecretPolicy: 'allow-in-development',
  });

  assert.equal(ok, false);
});

test('verifyTurnstile posts to Cloudflare and returns success state', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'test-secret';
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = options.body;
    return new Response(JSON.stringify({ success: true }));
  };

  const ok = await verifyTurnstile({
    token: 'valid-token',
    ip: '203.0.113.15',
  });

  assert.equal(ok, true);
  assert.equal(requestBody.get('secret'), 'test-secret');
  assert.equal(requestBody.get('response'), 'valid-token');
  assert.equal(requestBody.get('remoteip'), '203.0.113.15');
});
