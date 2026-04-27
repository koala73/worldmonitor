/**
 * Functional tests for LeadsService.SubmitContact handler.
 * Tests the typed handler directly (not the HTTP gateway).
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeCtx(headers = {}) {
  const req = new Request('https://worldmonitor.app/api/leads/v1/submit-contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  return { request: req, pathParams: {}, headers };
}

function validReq(overrides = {}) {
  return {
    email: 'test@example.com',
    name: 'Test User',
    organization: 'TestCorp',
    phone: '+1 555 123 4567',
    message: 'Hello',
    source: 'enterprise-contact',
    website: '',
    turnstileToken: 'valid-token',
    ...overrides,
  };
}

let submitContact;
let ValidationError;
let ApiError;

describe('LeadsService.submitContact', () => {
  beforeEach(async () => {
    process.env.CONVEX_URL = 'https://fake-convex.cloud';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.VERCEL_ENV = 'production';

    // Handler + error classes share one module instance so `instanceof` works.
    const mod = await import('../server/worldmonitor/leads/v1/submit-contact.ts');
    submitContact = mod.submitContact;
    const gen = await import('../src/generated/server/worldmonitor/leads/v1/service_server.ts');
    ValidationError = gen.ValidationError;
    ApiError = gen.ApiError;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  describe('validation', () => {
    it('rejects missing email with ValidationError', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      await assert.rejects(
        () => submitContact(makeCtx(), validReq({ email: '' })),
        (err) => err instanceof ValidationError && err.violations[0].field === 'email',
      );
    });

    it('rejects invalid email format', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      await assert.rejects(
        () => submitContact(makeCtx(), validReq({ email: 'not-an-email' })),
        (err) => err instanceof ValidationError,
      );
    });

    it('rejects missing name', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      await assert.rejects(
        () => submitContact(makeCtx(), validReq({ name: '' })),
        (err) => err instanceof ValidationError && err.violations[0].field === 'name',
      );
    });

    it('rejects free email domains with 422 ApiError', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      await assert.rejects(
        () => submitContact(makeCtx(), validReq({ email: 'test@gmail.com' })),
        (err) => err instanceof ApiError && err.statusCode === 422 && /work email/i.test(err.message),
      );
    });

    it('rejects missing organization', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      await assert.rejects(
        () => submitContact(makeCtx(), validReq({ organization: '' })),
        (err) => err instanceof ValidationError && err.violations[0].field === 'organization',
      );
    });

    it('rejects missing phone', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      await assert.rejects(
        () => submitContact(makeCtx(), validReq({ phone: '' })),
        (err) => err instanceof ValidationError && err.violations[0].field === 'phone',
      );
    });

    it('rejects invalid phone format', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      await assert.rejects(
        () => submitContact(makeCtx(), validReq({ phone: '(((((' })),
        (err) => err instanceof ValidationError,
      );
    });

    it('silently accepts honeypot submissions without calling upstreams', async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => { fetchCalled = true; return new Response('{}'); };
      const res = await submitContact(makeCtx(), validReq({ website: 'http://spam.com' }));
      assert.equal(res.status, 'sent');
      assert.equal(res.emailSent, false);
      assert.equal(fetchCalled, false);
    });
  });

  describe('Turnstile handling', () => {
    it('rejects when Turnstile verification fails', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) {
          return new Response(JSON.stringify({ success: false }));
        }
        return new Response('{}');
      };
      await assert.rejects(
        () => submitContact(makeCtx(), validReq()),
        (err) => err instanceof ApiError && err.statusCode === 403 && /bot/i.test(err.message),
      );
    });

    it('rejects in production when TURNSTILE_SECRET_KEY is unset', async () => {
      delete process.env.TURNSTILE_SECRET_KEY;
      process.env.VERCEL_ENV = 'production';
      globalThis.fetch = async () => new Response('{}');
      await assert.rejects(
        () => submitContact(makeCtx(), validReq()),
        (err) => err instanceof ApiError && err.statusCode === 403,
      );
    });

    it('allows in development when TURNSTILE_SECRET_KEY is unset', async () => {
      delete process.env.TURNSTILE_SECRET_KEY;
      process.env.VERCEL_ENV = 'development';
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('fake-convex')) {
          return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        }
        if (typeof url === 'string' && url.includes('resend')) return new Response(JSON.stringify({ id: '1' }));
        return new Response('{}');
      };
      const res = await submitContact(makeCtx(), validReq());
      assert.equal(res.status, 'sent');
    });
  });

  describe('notification failures', () => {
    it('returns emailSent: false when RESEND_API_KEY is missing', async () => {
      delete process.env.RESEND_API_KEY;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (typeof url === 'string' && url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        return new Response('{}');
      };
      const res = await submitContact(makeCtx(), validReq());
      assert.equal(res.status, 'sent');
      assert.equal(res.emailSent, false);
    });

    it('returns emailSent: false when Resend API returns error', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (typeof url === 'string' && url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        if (typeof url === 'string' && url.includes('resend')) return new Response('Rate limited', { status: 429 });
        return new Response('{}');
      };
      const res = await submitContact(makeCtx(), validReq());
      assert.equal(res.status, 'sent');
      assert.equal(res.emailSent, false);
    });

    it('returns emailSent: true on successful notification', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (typeof url === 'string' && url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        if (typeof url === 'string' && url.includes('resend')) return new Response(JSON.stringify({ id: 'msg_123' }));
        return new Response('{}');
      };
      const res = await submitContact(makeCtx(), validReq());
      assert.equal(res.status, 'sent');
      assert.equal(res.emailSent, true);
    });

    it('still succeeds (stores in Convex) even when email fails', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (typeof url === 'string' && url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        if (typeof url === 'string' && url.includes('resend')) throw new Error('Network failure');
        return new Response('{}');
      };
      const res = await submitContact(makeCtx(), validReq());
      assert.equal(res.status, 'sent');
      assert.equal(res.emailSent, false);
    });
  });

  describe('Convex storage', () => {
    it('throws 503 ApiError when CONVEX_URL is missing', async () => {
      delete process.env.CONVEX_URL;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      await assert.rejects(
        () => submitContact(makeCtx(), validReq()),
        (err) => err instanceof ApiError && err.statusCode === 503,
      );
    });

    it('propagates Convex failure', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (typeof url === 'string' && url.includes('fake-convex')) return new Response('Internal error', { status: 500 });
        return new Response('{}');
      };
      await assert.rejects(() => submitContact(makeCtx(), validReq()));
    });
  });
});
