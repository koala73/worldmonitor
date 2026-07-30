/**
 * Regression for issue #3802: the relay's /health endpoint was returning
 * attacker-aiding fields in its UNauthenticated response:
 *
 *   - `auth.authHeader` — revealed the non-standard header name
 *     (`x-relay-key`) attackers should target.
 *   - `auth.allowVercelPreviewOrigins` — CORS-policy leak.
 *   - `rateLimit: { windowMs, defaultMax, openskyMax, rssMax }` — exact
 *     thresholds that let attackers tune scraping cadence to stay under
 *     the throttle.
 *
 * The /health handler is in `isPublicRoute` and has no auth gate, so
 * this test source-greps the handler body to assert the three field
 * categories don't reappear.
 *
 * IMPORTANT: `auth.enabled` and `auth.sharedSecretEnabled` are
 * PRESERVED on purpose. PR #3812 / #3815 added them as the
 * operator-visible "is auth configured?" signal; their behaviour is
 * pinned by tests/relay-auth.test.mjs. The contract is "operators get
 * a coarse boolean; we don't reveal the credential header name or rate
 * thresholds."
 *
 * Inspired by:
 * ~/.claude/skills/test-ci-gotchas/reference/source-grep-regression-test-for-unexercisable-defensive-branch.md
 *
 * (Why source-grep: ais-relay.cjs is a 9600-line single-process daemon
 * that's not easily importable in node:test. Spawning the relay and
 * curl'ing /health is expensive and flaky for THIS check; the existing
 * relay-auth.test.mjs already pays that cost for the auth.enabled
 * contract.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function getHealthHandlerBody() {
  const source = await readFile(
    new URL('../scripts/ais-relay.cjs', import.meta.url),
    'utf8',
  );
  // Anchor the /health handler block. ~80-line handler — bound to 8000
  // chars to avoid runaway matching if the handler ever grows.
  const handlerMatch = source.match(
    /if \(pathname === '\/health' \|\| pathname === '\/'\) \{[\s\S]{0,8000}?\n\s{2}\}/,
  );
  assert.ok(handlerMatch, 'expected to find /health handler block in ais-relay.cjs');
  // Strip JS comments so the in-line doc comment that NAMES the removed
  // fields as a defense-in-depth note doesn't false-positive.
  return handlerMatch[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('ais-relay /health attacker-recon fields removed (#3802)', () => {
  it('does NOT expose `authHeader` (would reveal the non-standard header name to target)', async () => {
    const body = await getHealthHandlerBody();
    assert.ok(
      !/\bauthHeader\b/.test(body),
      'relay /health must NOT return `authHeader` — issue #3802. ' +
        'The CORS Allow-Headers preflight already exposes it; do not bundle ' +
        'it on /health to make the one-step attack two-step.',
    );
  });

  it('does NOT expose `allowVercelPreviewOrigins` (CORS-policy leak)', async () => {
    const body = await getHealthHandlerBody();
    assert.ok(
      !/\ballowVercelPreviewOrigins\b/.test(body),
      'relay /health must NOT return `allowVercelPreviewOrigins` — issue #3802. ' +
        'Operators read CORS policy from env vars, not /health.',
    );
  });

  it('does NOT contain a `rateLimit:` block (exact thresholds let attackers tune scraping)', async () => {
    const body = await getHealthHandlerBody();
    assert.ok(
      !/\brateLimit:\s*\{/.test(body),
      'relay /health must NOT return a `rateLimit: { ... }` block — issue #3802. ' +
        'Operators read these from env vars / Railway dashboard.',
    );
  });
});

describe('ais-relay /health operator-monitoring contract preserved (#3812 / #3815)', () => {
  it('STILL exposes `auth.enabled` (operator-visible "is auth configured?" signal)', async () => {
    const body = await getHealthHandlerBody();
    assert.match(
      body,
      /\benabled:\s*!AUTH_EFFECTIVELY_DISABLED\b/,
      'relay /health MUST keep `auth.enabled` — codified by PR #3812 + tests/relay-auth.test.mjs. ' +
        'Removing it lies to operator monitoring. If you genuinely need to remove it, ' +
        'coordinate with the contract test owner first.',
    );
  });

  it('STILL exposes `auth.sharedSecretEnabled` (back-compat field for monitoring tools)', async () => {
    const body = await getHealthHandlerBody();
    assert.match(
      body,
      /\bsharedSecretEnabled:\s*!!RELAY_SHARED_SECRET\b/,
      'relay /health MUST keep `auth.sharedSecretEnabled` — back-compat per PR #3815.',
    );
  });

  it('STILL returns core uptime fields (no over-stripping)', async () => {
    const body = await getHealthHandlerBody();
    assert.match(body, /status:\s*'ok'/, 'must keep status:"ok"');
    assert.match(body, /\bclients:\s*clients\.size/, 'must keep client count');
    assert.match(body, /\btelegram:\s*\{/, 'must keep telegram diagnostics');
    assert.match(body, /\boref:\s*\{/, 'must keep oref diagnostics');
    assert.match(body, /\bmemory:\s*\{/, 'must keep memory block');
  });
});
