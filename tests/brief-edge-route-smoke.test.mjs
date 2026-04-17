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
