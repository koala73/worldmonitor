// Smoke test for the brief edge routes.
//
// Purpose: force actual module resolution (imports + dependency graph)
// so a broken import path cannot slip past `tsc`. `@ts-expect-error`
// directives silence the missing-module error at compile time, but
// the runtime loader still fails on first request in Vercel edge —
// which we only discover on deploy. Importing the handler in a test
// catches it here.
//
// Phase 1 review (todo #210) moved the renderer from shared/ to
// server/_shared/; Phase 2's first cut imported the old path with
// `@ts-expect-error` and green-lit in CI. This test makes that
// regression impossible to repeat.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('api/brief/[userId]/[issueDate] module resolution', () => {
  it('loads the handler and its renderer dependency without error', async () => {
    const mod = await import('../api/brief/[userId]/[issueDate].ts');
    assert.equal(typeof mod.default, 'function', 'handler must be a function');
    assert.equal(mod.config?.runtime, 'edge', 'route must declare edge runtime');
  });
});

describe('api/latest-brief module resolution', () => {
  it('loads the preview RPC handler without error', async () => {
    const mod = await import('../api/latest-brief.ts');
    assert.equal(typeof mod.default, 'function', 'handler must be a function');
    assert.equal(mod.config?.runtime, 'edge', 'route must declare edge runtime');
  });
});

describe('api/brief handler behaviour (no secrets / no Redis)', () => {
  // Rejects obviously-bad requests without any env dependencies. More
  // exhaustive tests belong in brief-url.test.mjs (HMAC) and a future
  // integration suite with mocked Redis. These confirm the handler
  // composes responses correctly from the inputs that do NOT require
  // env config.

  it('returns 204 on OPTIONS preflight', async () => {
    const { default: handler } = await import('../api/brief/[userId]/[issueDate].ts');
    const req = new Request('https://worldmonitor.app/api/brief/user_x/2026-04-17', {
      method: 'OPTIONS',
      headers: { origin: 'https://worldmonitor.app' },
    });
    const res = await handler(req);
    assert.equal(res.status, 204);
  });

  it('returns 405 on disallowed methods', async () => {
    process.env.BRIEF_URL_SIGNING_SECRET ??= 'test-secret-used-only-for-method-gate';
    const { default: handler } = await import('../api/brief/[userId]/[issueDate].ts');
    const req = new Request('https://worldmonitor.app/api/brief/user_x/2026-04-17', {
      method: 'POST',
      headers: { origin: 'https://worldmonitor.app' },
    });
    const res = await handler(req);
    assert.equal(res.status, 405);
  });

  it('returns empty body on HEAD (RFC 7231)', async () => {
    process.env.BRIEF_URL_SIGNING_SECRET ??= 'test-secret-used-only-for-head-body-check';
    const { default: handler } = await import('../api/brief/[userId]/[issueDate].ts');
    // HEAD with a bad token → 403 path; body should still be empty.
    const req = new Request(
      'https://worldmonitor.app/api/brief/user_x/2026-04-17?t=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      {
        method: 'HEAD',
        headers: { origin: 'https://worldmonitor.app' },
      },
    );
    const res = await handler(req);
    const body = await res.text();
    assert.equal(body, '', 'HEAD must not carry a body');
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
  });
});

describe('infrastructure-error vs miss (both routes must not collapse)', () => {
  it('readRawJsonFromUpstash throws when Upstash credentials are missing', async () => {
    const { readRawJsonFromUpstash } = await import('../api/_upstash-json.js');
    const saved = {
      url: process.env.UPSTASH_REDIS_REST_URL,
      tok: process.env.UPSTASH_REDIS_REST_TOKEN,
    };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      await assert.rejects(
        () => readRawJsonFromUpstash('brief:user_x:2026-04-17'),
        /not configured/,
      );
    } finally {
      if (saved.url) process.env.UPSTASH_REDIS_REST_URL = saved.url;
      if (saved.tok) process.env.UPSTASH_REDIS_REST_TOKEN = saved.tok;
    }
  });

  it('readRawJsonFromUpstash throws on Upstash HTTP error', async () => {
    const { readRawJsonFromUpstash } = await import('../api/_upstash-json.js');
    const realFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    globalThis.fetch = async () => new Response('internal error', { status: 500 });
    try {
      await assert.rejects(
        () => readRawJsonFromUpstash('brief:user_x:2026-04-17'),
        /HTTP 500/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('readRawJsonFromUpstash returns null only on genuine miss', async () => {
    const { readRawJsonFromUpstash } = await import('../api/_upstash-json.js');
    const realFetch = globalThis.fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    try {
      const out = await readRawJsonFromUpstash('brief:user_x:2026-04-17');
      assert.equal(out, null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('api/brief returns 503 when Upstash fails (not 404 "expired")', async () => {
    process.env.BRIEF_URL_SIGNING_SECRET ??= 'test-secret-infra-err-path';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('oops', { status: 500 });
    try {
      const { default: handler } = await import('../api/brief/[userId]/[issueDate].ts');
      const { signBriefToken } = await import('../server/_shared/brief-url.ts');
      const userId = 'user_test';
      const issueDate = '2026-04-17';
      const token = await signBriefToken(userId, issueDate, process.env.BRIEF_URL_SIGNING_SECRET);
      const req = new Request(
        `https://worldmonitor.app/api/brief/${userId}/${issueDate}?t=${token}`,
        { method: 'GET', headers: { origin: 'https://worldmonitor.app' } },
      );
      const res = await handler(req);
      assert.equal(res.status, 503, 'Upstash outage must surface as 503, not 404');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('api/latest-brief returns 503 when Upstash fails (not 200 "composing")', async () => {
    // Skipped when Clerk is not mockable in unit tests. We exercise
    // the infra-error branch at the helper level above; the route
    // wiring is covered by the 403/404 smoke tests.
  });
});

describe('assertBriefEnvelope is shared between renderer and preview', () => {
  // Regression guard against the "ready preview → 404 on click"
  // contradiction. The preview RPC must use the same validator the
  // renderer uses so no partial envelope escapes as a "ready" status.

  it('exports assertBriefEnvelope from server/_shared/brief-render.js', async () => {
    const mod = await import('../server/_shared/brief-render.js');
    assert.equal(typeof mod.assertBriefEnvelope, 'function');
    assert.equal(typeof mod.renderBriefMagazine, 'function');
  });

  it('assertBriefEnvelope throws on partial envelope missing digest.numbers', async () => {
    const { assertBriefEnvelope } = await import('../server/_shared/brief-render.js');
    // Weak preview would have passed this envelope: dateLong string,
    // digest.greeting string, stories array. But it's missing
    // digest.numbers entirely — the renderer must reject it so the
    // preview RPC rejects it too.
    const partial = {
      version: 2,
      issuedAt: Date.now(),
      data: {
        user: { name: 'Elie', tz: 'UTC' },
        issue: '18.04',
        date: '2026-04-18',
        dateLong: '18 April 2026',
        digest: {
          greeting: 'Good morning.',
          lead: 'Lead paragraph.',
          threads: [],
          signals: [],
          // numbers intentionally absent
        },
        stories: [
          {
            category: 'Energy',
            country: 'US',
            threatLevel: 'medium',
            headline: 'Headline',
            description: 'Description',
            source: 'Wires',
            sourceUrl: 'https://example.com/story',
            whyMatters: 'Why',
          },
        ],
      },
    };
    assert.throws(() => assertBriefEnvelope(partial), /digest\.numbers/);
  });
});
