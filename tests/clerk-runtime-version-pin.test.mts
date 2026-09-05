/**
 * #7352 — the Clerk code we ship must be the Clerk code we test against, and
 * it must not change without a commit.
 *
 * Two resolution gaps existed: package.json declared `^6.13.0` while the
 * lockfile installed 6.25.6 (vite strips the range prefix to build the
 * Frontend API URL, so production SERVED 6.13.0 while TypeScript compiled
 * against 6.25.6 — twelve minors of drift between the runtime and its
 * types), and `CLERK_UI_VERSION = '1'` let the prebuilt SignIn/UserProfile
 * surfaces float across an entire major at request time with no repo change
 * and no CI signal.
 *
 * Both are pinned exactly now; this guard reds any reintroduction of a range.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const RANGE_CHARS = /[\^~<>=*x\s]/;

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { version?: string }>;
};
const clerkServiceSrc = readFileSync('src/services/clerk.ts', 'utf8');

const declared = pkg.dependencies?.['@clerk/clerk-js'] ?? pkg.devDependencies?.['@clerk/clerk-js'] ?? '';
const installed = lock.packages['node_modules/@clerk/clerk-js']?.version ?? '';

describe('Clerk runtime version pin (#7352)', () => {
  it('declares @clerk/clerk-js as an exact version, not a range', () => {
    assert.match(
      declared, EXACT_SEMVER,
      `@clerk/clerk-js must be pinned exactly — a range means the SERVED bundle ` +
      `(vite strips the prefix into __CLERK_JS_VERSION__) and the compiled-against ` +
      `types can drift by minors with no commit; got "${declared}"`,
    );
  });

  it('the declared version IS the installed version, so runtime and types agree', () => {
    assert.match(installed, EXACT_SEMVER, 'lockfile must carry a concrete install');
    assert.equal(
      declared, installed,
      'package.json and package-lock.json must name the same @clerk/clerk-js — ' +
      'the declared value is what production serves, the installed one is what tsc checks',
    );
  });

  it('the generated Frontend API SDK URL carries no range characters', () => {
    // Mirror vite.config.ts: the injected __CLERK_JS_VERSION__ is the declared
    // string with any range prefix stripped. With an exact pin the strip is a
    // no-op; if a range sneaks back, the stripped value diverges from the
    // declared one and this fails alongside the exactness guard above.
    const stripped = declared.replace(/^[\^~>=<\s]*/, '');
    assert.equal(stripped, declared, 'stripping must be a no-op on an exact pin');
    const url = `https://clerk.worldmonitor.app/npm/@clerk/clerk-js@${stripped}/dist/clerk.browser.js`;
    assert.ok(!RANGE_CHARS.test(`@${stripped}`.slice(1)), `URL version segment must be literal: ${url}`);
  });

  it('CLERK_UI_VERSION is an exact version, so the UI bundle cannot float across a major', () => {
    const match = clerkServiceSrc.match(/const CLERK_UI_VERSION = '([^']*)';/);
    assert.ok(match, 'CLERK_UI_VERSION must remain a plain literal in src/services/clerk.ts');
    assert.match(
      match![1]!, EXACT_SEMVER,
      `@clerk/ui@${match![1]} resolves at request time — a bare major lets Clerk change ` +
      'the prebuilt SignIn/UserProfile surfaces (including passkey management) with no ' +
      'repo change and no CI signal',
    );
  });

  it('the SDK pin stays on the major the UI pairing guard expects', () => {
    // vite.config.ts hard-fails on a non-6 major and points at CLERK_UI_VERSION;
    // mirroring it here keeps the pairing visible in the test run too.
    assert.equal(declared.split('.')[0], '6');
  });
});
