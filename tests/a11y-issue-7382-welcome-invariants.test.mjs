import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const read = (path) => readFileSync(resolve(root, path), 'utf8');

const footer = read('pro-test/src/components/Footer.tsx');
const logo = read('pro-test/src/components/Logo.tsx');
const nav = read('pro-test/src/welcome/Nav.tsx');
const pressNav = read('pro-test/src/components/PressFooterNav.tsx');
const app = read('pro-test/src/App.tsx');
const blogBase = read('blog-site/src/layouts/Base.astro');

/** Marketing chrome that renders the WORLD MONITOR lockup. */
const LOCKUP_SOURCES = Object.entries({
  'pro-test/src/components/Logo.tsx': logo,
  'pro-test/src/components/Footer.tsx': footer,
  'pro-test/src/App.tsx': app,
  'blog-site/src/layouts/Base.astro': blogBase,
});

describe('welcome a11y invariants (#7382)', () => {
  it('keeps footer copyright and byline at solid muted contrast (no opacity fade)', () => {
    assert.doesNotMatch(footer, /opacity-40/);
    assert.doesNotMatch(footer, /opacity-60/);
    assert.match(footer, /text-wm-muted/);
    assert.match(footer, /text-\[10px\] text-wm-muted/);
  });

  it('keeps the press-row label at solid muted contrast (no opacity fade)', () => {
    // #7383 added this row with the same opacity-60 fade #7414 swept out of
    // Footer/Logo, so it kept color-contrast red at 3.42:1 against #020202.
    assert.doesNotMatch(pressNav, /opacity-\d+/);
    assert.match(pressNav, /text-wm-muted/);
  });

  it('names the home control from visible WORLD MONITOR text (no mismatched aria-label)', () => {
    assert.doesNotMatch(logo, /aria-label=/);
    assert.match(logo, /WORLD MONITOR/);
    assert.match(logo, /aria-hidden="true"/);
  });

  it('exposes the lockup as ONE home link, not stacked sub-24px targets', () => {
    // #7383 split the single 32px-tall lockup anchor into a 14px wordmark
    // link plus a 10px byline link 16px apart, which axe target-size scores
    // as "safe clickable space has a diameter of 8px instead of 24px".
    const anchors = logo.match(/<a[\s>]/g) ?? [];
    assert.equal(anchors.length, 1, 'Logo must render exactly one anchor');
    assert.match(logo, /className="flex items-center gap-2/);
  });

  it('never nests an interactive control around the lockup', () => {
    // <a href="#"><Logo /></a> on the Enterprise page put an anchor inside an
    // anchor: invalid HTML, and the inner href silently wins the click.
    // Matched line-wise on purpose — an `onClick={(e) => ...}` attribute
    // contains a bare `>`, so a `<a[^>]*>` pattern stops short and can never
    // see the <Logo /> that follows.
    const wrapped = app
      .split('\n')
      .filter((line) => line.includes('<Logo') && /<a[\s>]/.test(line));
    assert.deepEqual(wrapped, [], 'Logo must not be wrapped in an anchor');
  });

  it('carries no Someone.ceo studio byline in marketing chrome', () => {
    for (const [path, source] of LOCKUP_SOURCES) {
      assert.doesNotMatch(source, /Someone\.ceo/i, `${path} must not render the studio byline`);
      assert.doesNotMatch(source, /SOMEONE_CEO_URL/, `${path} must not import the studio URL`);
    }
  });

  it('keeps Launch CTA aria-label matching visible copy (critical CSS + a11y)', () => {
    // Matching aria-label is intentional: prerender critical CSS keys off
    // nav[data-wm-nav] a[aria-label*="Launch"], and the label equals visible text.
    assert.match(nav, /aria-label=\{t\('welcome\.nav\.launch'\)\}/);
    assert.match(nav, /\{t\('welcome\.nav\.launch'\)\}/);
  });
});

