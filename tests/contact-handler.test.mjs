import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeRequest(body, opts = {}) {
  return new Request('https://worldmonitor.app/api/contact', {
    method: opts.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'origin': 'https://worldmonitor.app',
      ...(opts.headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function validBody(overrides = {}) {
  return {
    name: 'Test User',
    email: 'test@example.com',
    organization: 'TestCorp',
    phone: '+1 555 123 4567',
    message: 'Hello',
    source: 'enterprise-contact',
    turnstileToken: 'valid-token',
    ...overrides,
  };
}

let handler;

describe('api/contact', () => {
  beforeEach(async () => {
    process.env.CONVEX_URL = 'https://fake-convex.cloud';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.VERCEL_ENV = 'production';

    // Re-import to get fresh module state (rate limiter)
    const mod = await import(`../api/contact.js?t=${Date.now()}`);
    handler = mod.default;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach(k => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  describe('validation', () => {
    it('rejects GET requests', async () => {
      const res = await handler(new Request('https://worldmonitor.app/api/contact', {
        method: 'GET',
        headers: { origin: 'https://worldmonitor.app' },
      }));
      assert.equal(res.status, 405);
    });

    it('rejects missing email', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody({ email: '' })));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /email/i);
    });

    it('rejects invalid email format', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody({ email: 'not-an-email' })));
      assert.equal(res.status, 400);
    });

    it('rejects missing name', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody({ name: '' })));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /name/i);
    });

    it('rejects free email domains with 422', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody({ email: 'test@gmail.com' })));
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.match(data.error, /work email/i);
    });

    it('rejects missing organization', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody({ organization: '' })));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /company/i);
    });

    it('rejects missing phone', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody({ phone: '' })));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /phone/i);
    });

    it('rejects invalid phone format', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody({ phone: '(((((' })));
      assert.equal(res.status, 400);
    });

    it('rejects disallowed origins', async () => {
      const req = new Request('https://worldmonitor.app/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'https://evil.com' },
        body: JSON.stringify(validBody()),
      });
      const res = await handler(req);
      assert.equal(res.status, 403);
    });

    it('silently accepts honeypot submissions', async () => {
      const res = await handler(makeRequest(validBody({ website: 'http://spam.com' })));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'sent');
    });
  });

  describe('Turnstile handling', () => {
    it('rejects when Turnstile verification fails', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) {
          return new Response(JSON.stringify({ success: false }));
        }
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody()));
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.match(data.error, /bot/i);
    });

    it('rejects in production when TURNSTILE_SECRET_KEY is unset', async () => {
      delete process.env.TURNSTILE_SECRET_KEY;
      process.env.VERCEL_ENV = 'production';
      globalThis.fetch = async () => new Response('{}');
      const res = await handler(makeRequest(validBody()));
      assert.equal(res.status, 403);
    });

    it('allows in development when TURNSTILE_SECRET_KEY is unset', async () => {
      delete process.env.TURNSTILE_SECRET_KEY;
      process.env.VERCEL_ENV = 'development';
      let convexCalled = false;
      globalThis.fetch = async (url, _opts) => {
        if (url.includes('fake-convex')) {
          convexCalled = true;
          return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        }
        if (url.includes('resend')) return new Response(JSON.stringify({ id: '1' }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody()));
      assert.equal(res.status, 200);
    });
  });

  describe('notification failures', () => {
    it('returns emailSent: false when RESEND_API_KEY is missing', async () => {
      delete process.env.RESEND_API_KEY;
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody()));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'sent');
      assert.equal(data.emailSent, false);
    });

    it('returns emailSent: false when Resend API returns error', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        if (url.includes('resend')) return new Response('Rate limited', { status: 429 });
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody()));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'sent');
      assert.equal(data.emailSent, false);
    });

    it('returns emailSent: true on successful notification', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        if (url.includes('resend')) return new Response(JSON.stringify({ id: 'msg_123' }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody()));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'sent');
      assert.equal(data.emailSent, true);
    });

    it('still succeeds (stores in Convex) even when email fails', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (url.includes('fake-convex')) return new Response(JSON.stringify({ status: 'success', value: { status: 'sent' } }));
        if (url.includes('resend')) throw new Error('Network failure');
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody()));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'sent');
      assert.equal(data.emailSent, false);
    });
  });

  describe('Convex storage', () => {
    it('returns 503 when CONVEX_URL is missing', async () => {
      delete process.env.CONVEX_URL;
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody()));
      assert.equal(res.status, 503);
    });

    it('returns 500 when Convex mutation fails', async () => {
      globalThis.fetch = async (url) => {
        if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
        if (url.includes('fake-convex')) return new Response('Internal error', { status: 500 });
        return new Response('{}');
      };
      const res = await handler(makeRequest(validBody()));
      assert.equal(res.status, 500);
    });
  });
});
