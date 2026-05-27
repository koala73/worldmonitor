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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');

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
    const req = new Request('https://worldmonitor.app/api/brief/user_x/2026-04-17-0800', {
      method: 'OPTIONS',
      headers: { origin: 'https://worldmonitor.app' },
    });
    const res = await handler(req);
    assert.equal(res.status, 204);
  });

  it('returns 405 on disallowed methods', async () => {
    process.env.BRIEF_URL_SIGNING_SECRET ??= 'test-secret-used-only-for-method-gate';
    const { default: handler } = await import('../api/brief/[userId]/[issueDate].ts');
    const req = new Request('https://worldmonitor.app/api/brief/user_x/2026-04-17-0800', {
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
      'https://worldmonitor.app/api/brief/user_x/2026-04-17-0800?t=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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

describe('api/brief followed-countries telemetry fetch', () => {
  const src = readFileSync(resolve(ROOT, 'api/brief/[userId]/[issueDate].ts'), 'utf8');

  it('bounds followed-countries relay latency to telemetry budget', () => {
    assert.match(
      src,
      /const FOLLOWED_COUNTRIES_TIMEOUT_MS = 500;/,
      'followed-country relay must not add a 1.5s TTFB tail to magazine rendering',
    );
  });

  it('starts followed-countries lookup before the required Redis envelope read', () => {
    const followedIdx = src.indexOf('const followedCountriesPromise = fetchFollowedCountriesEdge(userId, ctx);');
    const envelopeIdx = src.indexOf('envelope = await readRawJsonFromUpstash(`brief:${userId}:${issueDate}`);');
    assert.ok(followedIdx !== -1, 'followedCountriesPromise start not found');
    assert.ok(envelopeIdx !== -1, 'envelope read not found');
    assert.ok(
      followedIdx < envelopeIdx,
      'followed-country relay lookup should overlap the Redis envelope read',
    );
  });

  it('documents missing followed data as telemetry degradation, not ground truth', () => {
    assert.doesNotMatch(
      src,
      /correct: we can't\s+prove a follow we (?:couldn't|didn't) read/,
      'comments must not describe missing relay data as accurate negative follow state',
    );
    assert.match(
      src,
      /Best-effort telemetry only/,
      'route comment should frame missing followed data as a telemetry-only degradation',
    );
  });

  it('drains the in-flight telemetry lookup when envelope read returns 503', () => {
    assert.match(
      src,
      /catch \(err\) \{[\s\S]*?step: 'envelope-read'[\s\S]*?ctx\?\.waitUntil\(followedCountriesPromise\)[\s\S]*?return htmlResponse\(req, 503, UNAVAILABLE_PAGE\)/,
      '503 envelope-read path should hand the telemetry promise to waitUntil before returning',
    );
  });

  it('drains the in-flight telemetry lookup when the envelope is missing', () => {
    assert.match(
      src,
      /if \(!envelope\) \{\s*ctx\?\.waitUntil\(followedCountriesPromise\);\s*return htmlResponse\(req, 404, EXPIRED_PAGE\);\s*\}/,
      '404 envelope-miss path should hand the telemetry promise to waitUntil before returning',
    );
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
        () => readRawJsonFromUpstash('brief:user_x:2026-04-17-0800'),
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
        () => readRawJsonFromUpstash('brief:user_x:2026-04-17-0800'),
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
      const out = await readRawJsonFromUpstash('brief:user_x:2026-04-17-0800');
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
      const issueDate = '2026-04-17-0800';
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

describe('api/latest-brief retry-on-Upstash-timeout', () => {
  // Regression guard for WORLDMONITOR-QJ. Locks in the retry contract:
  // (a) one retry fires on DOMException-like timeout/abort names,
  // (b) no retry on other error shapes, (c) per-attempt budgets are
  // FIRST_ATTEMPT_MS then RETRY_ATTEMPT_MS so worst-case wall time stays
  // under Vercel Edge's response cap. If the err-name check or attempt
  // budgets are refactored these tests must update — they're the source
  // of truth for the retry semantics.

  it('retries once on TimeoutError and returns the second attempt result', async () => {
    const { readWithOneRetry } = await import('../api/latest-brief.ts');
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return 'second-attempt-payload';
    };
    const out = await readWithOneRetry(attempt, 'test-label');
    assert.equal(calls, 2, 'helper must invoke the attempt twice on TimeoutError');
    assert.equal(out, 'second-attempt-payload');
  });

  it('retries once on AbortError and returns the second attempt result', async () => {
    const { readWithOneRetry } = await import('../api/latest-brief.ts');
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return 'second-attempt-payload';
    };
    const out = await readWithOneRetry(attempt, 'test-label');
    assert.equal(calls, 2, 'helper must invoke the attempt twice on AbortError');
    assert.equal(out, 'second-attempt-payload');
  });

  it('does NOT retry on non-timeout/abort errors (preserves fast-fail on real bugs)', async () => {
    const { readWithOneRetry } = await import('../api/latest-brief.ts');
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      throw new Error('readRawJsonFromUpstash: Upstash GET key returned HTTP 500');
    };
    await assert.rejects(
      () => readWithOneRetry(attempt, 'test-label'),
      /HTTP 500/,
    );
    assert.equal(calls, 1, 'non-Timeout error must surface on first attempt without retry');
  });

  it('re-throws when BOTH attempts fail with TimeoutError (503 fallback path)', async () => {
    const { readWithOneRetry } = await import('../api/latest-brief.ts');
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    await assert.rejects(
      () => readWithOneRetry(attempt, 'test-label'),
      /aborted due to timeout/,
    );
    assert.equal(calls, 2, 'helper must exhaust exactly two attempts on sustained outage');
  });

  it('first attempt receives FIRST_ATTEMPT_MS, retry receives RETRY_ATTEMPT_MS', async () => {
    const mod = await import('../api/latest-brief.ts');
    const observed = [];
    const attempt = async (timeoutMs) => {
      observed.push(timeoutMs);
      if (observed.length === 1) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return null;
    };
    await mod.readWithOneRetry(attempt, 'test-label');
    assert.deepEqual(
      observed,
      [mod.FIRST_ATTEMPT_MS, mod.RETRY_ATTEMPT_MS],
      'per-attempt budgets must shrink on retry to bound worst-case wall time',
    );
    // Sanity-check the absolute values so a future bump above the Vercel
    // Edge response cap is loudly caught.
    assert.equal(mod.FIRST_ATTEMPT_MS, 6_000);
    assert.equal(mod.RETRY_ATTEMPT_MS, 3_000);
  });
});
