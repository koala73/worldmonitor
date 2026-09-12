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
let EdgeFreeEmailDomains;

describe('LeadsService.submitContact', () => {
  beforeEach(async () => {
    process.env.CONVEX_URL = 'https://fake-convex.convex.cloud';
    delete process.env.CONVEX_SITE_URL;
    process.env.CONVEX_SERVER_SHARED_SECRET = 'synthetic-contact-secret';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.VERCEL_ENV = 'production';

    // Handler + error classes share one module instance so `instanceof` works.
    const mod = await import('../server/worldmonitor/leads/v1/submit-contact.ts');
    submitContact = mod.submitContact;
    EdgeFreeEmailDomains = mod.FREE_EMAIL_DOMAINS;
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

    it('keeps the edge and Convex free-email policies aligned', async () => {
      const { FREE_EMAIL_DOMAINS: ConvexFreeEmailDomains } =
        await import('../convex/lib/emailDomain.ts');

      assert.deepEqual(
        [...EdgeFreeEmailDomains].sort(),
        [...ConvexFreeEmailDomains].sort(),
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
          return new Response(JSON.stringify({ status: 'sent' }));
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
        if (typeof url === 'string' && url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'sent' }));
        return new Response('{}');
      };
      const res = await submitContact(makeCtx(), validReq());
      assert.equal(res.status, 'sent');
      assert.equal(res.emailSent, false);
    });

    it('returns emailSent: false when Resend API returns error', async () => {
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (typeof url === 'string' && url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'sent' }));
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
        if (typeof url === 'string' && url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'sent' }));
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
        if (typeof url === 'string' && url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'sent' }));
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

    for (const status of [422, 429]) {
      it(`preserves storage policy status ${status} without notifying`, async () => {
        globalThis.fetch = async (url) => {
          if (url.includes('turnstile')) return Response.json({ success: true });
          assert.ok(url.includes('/leads/submit-contact'));
          return Response.json({ error: 'policy' }, { status });
        };
        await assert.rejects(() => submitContact(makeCtx(), validReq()),
          (err) => err instanceof ApiError && err.statusCode === status);
      });
    }

    it('sends the server secret only to the contact bridge after Turnstile succeeds', async () => {
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push(url);
        if (url.includes('turnstile')) return Response.json({ success: true });
        if (url.includes('fake-convex')) {
          assert.equal(url, 'https://fake-convex.convex.site/leads/submit-contact');
          assert.equal(init.headers['x-convex-shared-secret'], 'synthetic-contact-secret');
          assert.equal(JSON.parse(init.body).email, 'test@example.com');
          return Response.json({ status: 'sent' });
        }
        assert.equal(init.headers['x-convex-shared-secret'], undefined);
        return Response.json({ id: 'synthetic-email' });
      };
      assert.deepEqual(await submitContact(makeCtx(), validReq()), { status: 'sent', emailSent: true });
      assert.equal(calls.length, 3);
      assert.ok(calls[0].includes('turnstile'));
    });

    it('fails closed without the server secret', async () => {
      delete process.env.CONVEX_SERVER_SHARED_SECRET;
      globalThis.fetch = async (url) => {
        assert.ok(url.includes('turnstile'));
        return Response.json({ success: true });
      };
      await assert.rejects(() => submitContact(makeCtx(), validReq()),
        (err) => err instanceof ApiError && err.statusCode === 503);
    });

    for (const body of ['not json', '{}', '{"status":"failed"}']) {
      it(`does not notify on invalid storage acknowledgment ${body}`, async () => {
        globalThis.fetch = async (url) => {
          if (url.includes('turnstile')) return Response.json({ success: true });
          assert.ok(url.includes('/leads/submit-contact'));
          return new Response(body);
        };
        await assert.rejects(() => submitContact(makeCtx(), validReq()),
          (err) => err instanceof ApiError && err.statusCode === 503);
      });
    }
  });
});
