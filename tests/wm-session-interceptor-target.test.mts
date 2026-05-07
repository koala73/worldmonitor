// Regression coverage for the URL-matcher inside the wm-session fetch
// interceptor (src/services/wm-session.ts).
//
// Bug history:
//   PR #3541 / #3557 (merged 2026-05-02) introduced the interceptor and
//   wired its `apiOrigin` to `getApiBaseUrl()`. That helper returns the
//   empty string for non-desktop runtimes, so on production browsers the
//   interceptor's cross-origin match path was silently a no-op. Every
//   absolute fetch URL like `https://api.worldmonitor.app/api/bootstrap`
//   slipped through unwrapped, no `X-WorldMonitor-Key` header was attached,
//   and the gateway returned `{"error":"API key required"}` → 401 on
//   every browser endpoint.
//
//   PR #3574 (merged 2026-05-03) fixed it by switching to
//   `getCanonicalApiOrigin()` (which always returns a non-empty value).
//   That fix is invisible to compile-time checks — `getApiBaseUrl()` and
//   `getCanonicalApiOrigin()` have the same TypeScript signature.
//
// What this test pins:
//   - The relative `/api/...` path is intercepted regardless of apiOrigin.
//   - The absolute `https://api.worldmonitor.app/api/...` path IS intercepted
//     when apiOrigin is the canonical origin (the post-fix behaviour).
//   - The same absolute path is NOT intercepted when apiOrigin is empty
//     (the pre-fix bug — explicit anti-regression).
//   - Cross-origin third-party URLs (Sentry, Convex, Clerk, etc.) are never
//     intercepted regardless of apiOrigin.
//
// If a future contributor "simplifies" the interceptor back to reading
// `getApiBaseUrl()`, the static-import assertion at the bottom of this file
// fails loudly so they can't ship the regression by accident.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isApiCallTarget } from '../src/services/wm-session.ts';

const CANONICAL_ORIGIN = 'https://api.worldmonitor.app';

describe('wm-session interceptor URL matcher (PR #3574 regression)', () => {
  it('matches a relative /api/ path even when apiOrigin is empty', () => {
    // Same-origin code paths (e.g. dev server proxy) build URLs as
    // `/api/bootstrap` directly. Must always intercept these.
    assert.equal(isApiCallTarget('/api/bootstrap', ''), true);
    assert.equal(isApiCallTarget('/api/news/v1/list-feed-digest', CANONICAL_ORIGIN), true);
  });

  it('REGRESSION: matches absolute URLs to the canonical API origin', () => {
    // The exact failure mode PR #3574 fixed. `panels-*.js` builds full URLs
    // because `worldmonitor.app` and `api.worldmonitor.app` are different
    // subdomains; the interceptor must catch them by origin.
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app/api/bootstrap', CANONICAL_ORIGIN),
      true,
    );
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app/api/market/v1/list-crypto-quotes', CANONICAL_ORIGIN),
      true,
    );
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app/api/economic/v1/get-fred-series-batch', CANONICAL_ORIGIN),
      true,
    );
  });

  it('REGRESSION: documents the pre-fix bug — empty apiOrigin silently misses absolute URLs', () => {
    // This is the bug. Locking it in as an explicit assertion so a future
    // refactor can't undo the fix without confronting WHY this matters.
    // Before PR #3574, getApiBaseUrl() returned '' on browsers, so the live
    // interceptor saw the SAME empty-string apiOrigin and silently no-op'd
    // every cross-origin call. The bug manifested as universal 401s.
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app/api/bootstrap', ''),
      false,
      'with empty apiOrigin the matcher CANNOT recognize absolute API URLs — '
        + 'this is exactly why getApiBaseUrl() (which returns empty for browsers) '
        + 'is the wrong helper for the interceptor. Use getCanonicalApiOrigin().',
    );
  });

  it('does not match cross-origin third-party URLs', () => {
    // Sentry, Convex, Clerk, etc. must pass through untouched.
    assert.equal(
      isApiCallTarget('https://o4505.ingest.sentry.io/api/12345/envelope/', CANONICAL_ORIGIN),
      false,
    );
    assert.equal(
      isApiCallTarget('https://tacit-curlew-777.convex.cloud/api/query', CANONICAL_ORIGIN),
      false,
    );
    assert.equal(
      isApiCallTarget('https://clerk.worldmonitor.app/v1/client', CANONICAL_ORIGIN),
      false,
    );
    // /api/ that is hosted on a non-API origin must not be intercepted.
    assert.equal(
      isApiCallTarget('https://example.com/api/anything', CANONICAL_ORIGIN),
      false,
    );
  });

  it('SECURITY: rejects look-alike hosts that embed the canonical origin as a prefix', () => {
    // PR #3575 review finding. A naive `url.startsWith(apiOrigin)` matches
    // ANY hostname that begins with the canonical-origin string — which
    // includes attacker-controlled subdomains like:
    //   `https://api.worldmonitor.app.evil.example/api/bootstrap`
    // The actual hostname there is `api.worldmonitor.app.evil.example`, NOT
    // ours. Without strict origin parsing the interceptor would attach the
    // wms_ token, sending it to the attacker. Pin both shapes documented in
    // the review note.
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app.evil.example/api/bootstrap', CANONICAL_ORIGIN),
      false,
      'host suffix attack: api.worldmonitor.app.evil.example must NOT be treated as our origin',
    );
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app@evil.example/api/bootstrap', CANONICAL_ORIGIN),
      false,
      'userinfo attack: api.worldmonitor.app@evil.example must resolve to host=evil.example, NOT our origin',
    );
    // Variant: a port appended to the canonical hostname is a different origin.
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app:8443/api/bootstrap', CANONICAL_ORIGIN),
      false,
      'a different port is a different origin per RFC 6454',
    );
    // Variant: http (not https) is a different origin.
    assert.equal(
      isApiCallTarget('http://api.worldmonitor.app/api/bootstrap', CANONICAL_ORIGIN),
      false,
      'protocol downgrade is a different origin — never attach token over plain http',
    );
  });

  it('SECURITY: does not match non-/api/ paths even on the canonical origin', () => {
    // Tightening that came with the strict-origin-parse fix. The wms_ token
    // is only meant for /api/ endpoints; any other path on the API host
    // (static assets, _next/, healthcheck, etc.) doesn't need it and we
    // shouldn't broadcast the token there.
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app/_next/static/chunks/foo.js', CANONICAL_ORIGIN),
      false,
    );
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app/health', CANONICAL_ORIGIN),
      false,
    );
    assert.equal(
      isApiCallTarget('https://api.worldmonitor.app/', CANONICAL_ORIGIN),
      false,
    );
  });

  it('matches a URL object passed as a string (panels build with new URL().href)', () => {
    const u = new URL('/api/bootstrap?tier=fast', CANONICAL_ORIGIN);
    assert.equal(isApiCallTarget(u.href, CANONICAL_ORIGIN), true);
  });

  it('returns false on garbage input rather than throwing', () => {
    assert.equal(isApiCallTarget('', CANONICAL_ORIGIN), false);
    assert.equal(isApiCallTarget('not-a-url', CANONICAL_ORIGIN), false);
  });
});

describe('wm-session.ts must not regress to getApiBaseUrl (static-import guard)', () => {
  // Belt-and-suspenders: a string-level check that prevents a future PR from
  // silently re-introducing the pre-#3574 import. The matcher test above
  // covers BEHAVIOUR; this test covers the SOURCE so a refactor can't ship
  // the bug by accident even if the matcher changes shape.
  it('imports getCanonicalApiOrigin and not getApiBaseUrl', () => {
    const __filename = fileURLToPath(import.meta.url);
    const repoRoot = path.resolve(path.dirname(__filename), '..');
    const source = readFileSync(
      path.join(repoRoot, 'src/services/wm-session.ts'),
      'utf8',
    );

    const importLine = source
      .split('\n')
      .find((line) => line.startsWith('import') && line.includes('./runtime'));

    assert.ok(importLine, 'expected an import from ./runtime in wm-session.ts');
    assert.match(
      importLine!,
      /getCanonicalApiOrigin/,
      'wm-session.ts must import getCanonicalApiOrigin from ./runtime — '
        + 'see PR #3574 for why getApiBaseUrl is the wrong helper here.',
    );
    assert.doesNotMatch(
      importLine!,
      /\bgetApiBaseUrl\b/,
      'wm-session.ts must NOT import getApiBaseUrl. That helper returns the '
        + 'empty string for non-desktop runtimes, which silently breaks the '
        + 'cross-origin match in the fetch interceptor (production incident '
        + '2026-05-03 — every browser request 401\'d).',
    );
  });
});
