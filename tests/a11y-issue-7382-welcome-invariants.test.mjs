// Text checks that stay (#8690, section 2) for the welcome-page a11y
// invariants from #7382. The parts the prerender renders (nav lockup,
// Launch CTA label, footer contrast, studio byline) now run against the
// built page in tests/pro-welcome-a11y-built.test.mjs. What remains here is
// client-only or outside the pro build:
// - the press row (PressNav) and the Enterprise view's lockup are rendered by
//   the React app after hydration, not by prerender.mjs, so their markup is
//   only in the TSX;
// - the Enterprise lockup's hash-clearing click handler is behaviour of a
//   hash route the prerender never visits;
// - blog-site/src/layouts/Base.astro belongs to a separate Astro build that
//   the test runners do not produce.
// Move the client-only checks into the built-output suite when prerendered.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const read = (path) => readFileSync(resolve(root, path), 'utf8');

const logo = read('pro-test/src/components/Logo.tsx');
const pressNav = read('pro-test/src/components/PressNav.tsx');
const app = read('pro-test/src/App.tsx');
const blogBase = read('blog-site/src/layouts/Base.astro');

/** Marketing chrome that renders the WORLD MONITOR lockup. */
const LOCKUP_SOURCES = Object.entries({
  'pro-test/src/components/Logo.tsx': logo,
  'pro-test/src/App.tsx': app,
  'blog-site/src/layouts/Base.astro': blogBase,
});

describe('welcome a11y invariants (#7382)', () => {
  it('keeps the press-row label at solid muted contrast (no opacity fade)', () => {
    // #7383 added this row with the same opacity-60 fade #7414 swept out of
    // Footer/Logo, so it kept color-contrast red at 3.42:1 against #020202.
    assert.doesNotMatch(pressNav, /opacity-\d+/);
    assert.match(pressNav, /text-wm-muted/);
  });

  it('never nests an interactive control around the lockup', () => {
    // <a href="#"><Logo /></a> on the Enterprise page put an anchor inside an
    // anchor: invalid HTML.
    // Matched line-wise on purpose — an `onClick={(e) => ...}` attribute
    // contains a bare `>`, so a `<a[^>]*>` pattern stops short and can never
    // see the <Logo /> that follows.
    const wrapped = app
      .split('\n')
      .filter((line) => line.includes('<Logo') && /<a[\s>]/.test(line));
    assert.deepEqual(wrapped, [], 'Logo must not be wrapped in an anchor');
  });

  it('keeps the Enterprise lockup returning to the Pro page, not leaving the site', () => {
    // The removed wrapper was not inert. It caught the click bubbling up from
    // the whole lockup and called preventDefault(), so the inner anchor's
    // href never navigated — clicking the wordmark on /pro#enterprise cleared
    // the hash and stayed on /pro (confirmed against production).
    // Unwrapping without forwarding the handler would silently send that
    // click off-site to worldmonitor.app, so Logo takes the destination.
    assert.match(logo, /href = 'https:\/\/worldmonitor\.app'/, 'Logo keeps the home default');
    assert.match(logo, /href=\{href\}/);
    assert.match(logo, /onClick=\{onClick\}/);
    assert.match(
      app,
      /<Logo\s+href="#"\s+onClick=\{\(e\) => \{ e\.preventDefault\(\); window\.location\.hash = ''; \}\}\s*\/>/,
      'the Enterprise nav lockup must still clear the hash instead of leaving the site',
    );
  });

  it('carries no Someone.ceo studio byline in marketing chrome', () => {
    for (const [path, source] of LOCKUP_SOURCES) {
      assert.doesNotMatch(source, /Someone\.ceo/i, `${path} must not render the studio byline`);
      assert.doesNotMatch(source, /SOMEONE_CEO_URL/, `${path} must not import the studio URL`);
    }
  });
});
