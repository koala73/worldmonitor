/**
 * Regression for issue #3802: the relay's /health endpoint was returning
 * `auth: {...}` (sharedSecretEnabled, authHeader, allowVercelPreviewOrigins)
 * and `rateLimit: {...}` (exact thresholds) in its UNauthenticated
 * response. Both gave reconnaissance to attackers probing the relay:
 *
 *   - `auth.sharedSecretEnabled: false` confirmed a no-auth deployment.
 *   - `rateLimit.*` thresholds let an attacker tune scraping cadence to
 *     stay under the throttle.
 *
 * The /health handler is in `isPublicRoute` and has no auth gate, so
 * this test source-greps the handler body to assert the two field
 * categories don't reappear. Inspired by:
 * ~/.claude/skills/test-ci-gotchas/reference/source-grep-regression-test-for-unexercisable-defensive-branch.md
 *
 * (Why source-grep: ais-relay.cjs is a 9600-line single-process daemon
 * that's not easily importable in node:test. Spawning the relay and
 * curl'ing /health is expensive and flaky. The grep catches the exact
 * regression class at near-zero cost.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

describe('ais-relay /health does not expose auth/rateLimit recon (#3802)', () => {
  it('the /health handler block does NOT contain an `auth:` field', async () => {
    const source = await readFile(
      new URL('../scripts/ais-relay.cjs', import.meta.url),
      'utf8',
    );
    // Find the /health handler body. The anchor is unique enough.
    // ~70-line handler body — bound to 4000 chars to avoid runaway matching
    // if the handler ever grows. Bump if it ever exceeds.
    const handlerMatch = source.match(
      /if \(pathname === '\/health' \|\| pathname === '\/'\) \{[\s\S]{0,4000}?\n\s{2}\}/,
    );
    assert.ok(handlerMatch, 'expected to find /health handler block in ais-relay.cjs');
    const handlerBody = handlerMatch[0];

    // Strip JS comments so the in-line doc comment that NAMES the removed
    // `auth:` field as a defense-in-depth note doesn't false-positive.
    const stripped = handlerBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    assert.ok(
      !/\bauth:\s*\{/.test(stripped),
      'relay /health must NOT return an `auth: { ... }` block — issue #3802. ' +
        'Operators can read auth state from env vars / Railway dashboard. ' +
        'If you need it on a health endpoint, add an AUTHENTICATED /health/full ' +
        'instead of widening the public response.',
    );
  });

  it('the /health handler block does NOT contain a `rateLimit:` field', async () => {
    const source = await readFile(
      new URL('../scripts/ais-relay.cjs', import.meta.url),
      'utf8',
    );
    const handlerMatch = source.match(
      /if \(pathname === '\/health' \|\| pathname === '\/'\) \{[\s\S]{0,4000}?\n\s{2}\}/,
    );
    assert.ok(handlerMatch);
    const stripped = handlerMatch[0]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    assert.ok(
      !/\brateLimit:\s*\{/.test(stripped),
      'relay /health must NOT return a `rateLimit: { ... }` block — issue #3802. ' +
        'Exact thresholds let attackers tune scraping cadence to stay under ' +
        'the throttle. Operators read these from env vars.',
    );
  });

  it('the /health handler still returns `status: \"ok\"` and core uptime fields (no over-stripping)', async () => {
    const source = await readFile(
      new URL('../scripts/ais-relay.cjs', import.meta.url),
      'utf8',
    );
    const handlerMatch = source.match(
      /if \(pathname === '\/health' \|\| pathname === '\/'\) \{[\s\S]{0,4000}?\n\s{2}\}/,
    );
    assert.ok(handlerMatch);
    const body = handlerMatch[0];
    // Pin the legitimate operational fields so a future "strip everything"
    // refactor doesn't remove the uptime signal that monitoring tools need.
    assert.match(body, /status:\s*'ok'/, 'must keep status:"ok"');
    assert.match(body, /\bclients:\s*clients\.size/, 'must keep client count');
    assert.match(body, /\btelegram:\s*\{/, 'must keep telegram diagnostics');
    assert.match(body, /\boref:\s*\{/, 'must keep oref diagnostics');
    assert.match(body, /\bmemory:\s*\{/, 'must keep memory block (process state, not credential)');
  });
});
