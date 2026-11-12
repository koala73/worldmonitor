// Runtime proof of the welcome-page a11y invariants from #7382 against the
// prerendered page (#8690, replacing the source-text checks that were in
// tests/a11y-issue-7382-welcome-invariants.test.mjs for the parts the build
// renders). Assertions read public/pro/welcome.html and localized landings, built by
// `npm run build:pro` (#6898): it skips in a checkout that has not built
// /pro and fails when WM_EXPECT_BUILT_OUTPUT=1 says CI did.
//
// What is observed in the built markup, not the TSX:
// - the nav lockup is ONE anchor whose accessible name is the visible
//   WORLD MONITOR text (no aria-label, decorative glyphs aria-hidden), so
//   axe target-size and name-mismatch stay green;
// - the Launch CTA's aria-label equals its visible text, which the
//   prerender's critical-CSS selector also keys off;
// - footer copyright and byline sit at solid muted contrast with no
//   opacity fade, by class or inline style;
// - no Someone.ceo studio byline anywhere in the rendered chrome.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { INDEXABLE_LANDING_LOCALES } from '../shared/indexable-landing-locales.ts';
import { guardProBuiltOutput, landingBuiltOutputPath, shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs';

const skip = shouldSkipProBuiltOutput();
guardProBuiltOutput();

let cached;
const html = () => (cached ??= readFileSync(new URL('../public/pro/welcome.html', import.meta.url), 'utf8'));
const textOf = (markup) => markup.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const anchors = (markup) => [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], inner: m[2], full: m[0] }));
const section = (markup, open, close) => {
  const start = markup.indexOf(open);
  assert.notEqual(start, -1, `${open} must be in the built page`);
  const end = markup.indexOf(close, start);
  assert.notEqual(end, -1, `${close} must follow ${open}`);
  return markup.slice(start, end + close.length);
};

describe('welcome page a11y (#7382), built output', { skip }, () => {
  it('renders the nav lockup as one anchor named by its visible WORLD MONITOR text', () => {
    const nav = section(html(), '<nav data-wm-nav="primary"', '</nav>');
    const window = new Window();
    try {
      window.document.body.innerHTML = nav;
      const chromeLinks = [...window.document.querySelectorAll('nav a')]
        .filter((a) => !a.closest('nav > div > details#welcome-tablet-navigation, nav > div > div.hidden[class~="lg:flex"]'));
      assert.equal(chromeLinks.length, 2, 'outside the desktop and tablet menus, the nav must have one lockup link and one Launch CTA');
      assert.equal(
        chromeLinks.filter((a) => a.getAttribute('data-umami-event-target') === 'welcome-nav').length,
        1,
        'one of the two links must be the Launch CTA',
      );
      const lockup = chromeLinks.find((a) => a.getAttribute('data-umami-event-target') !== 'welcome-nav');
      for (const token of ['flex', 'items-center', 'gap-2']) {
        assert.ok(lockup.classList.contains(token), `the lockup must have an unconditional ${token} class`);
      }
    } finally {
      window.close();
    }
    const lockups = anchors(nav).filter((a) => textOf(a.inner) === 'WORLD MONITOR');
    assert.equal(lockups.length, 1, 'exactly one lockup anchor in the nav');
    const [lockup] = lockups;
    assert.doesNotMatch(lockup.full, /aria-label(?:ledby)?=/, 'neither the lockup nor its descendants may override the visible name');
    assert.match(lockup.attrs, /href="https:\/\/worldmonitor\.app"/);
    const glyphWrapper = lockup.inner.match(/<span\b[^>]*>/);
    assert.ok(glyphWrapper && /aria-hidden="true"/.test(glyphWrapper[0]), 'the glyph wrapper is decorative');
    assert.doesNotMatch(lockup.inner, /<a\b/i, 'no nested anchor inside the lockup');
  });

  for (const locale of INDEXABLE_LANDING_LOCALES) {
    it(`keeps the ${locale.id} Launch CTA aria-label equal to its visible copy`, () => {
      const page = readFileSync(new URL(`../${landingBuiltOutputPath(locale)}`, import.meta.url), 'utf8');
      const nav = section(page, '<nav data-wm-nav="primary"', '</nav>');
      const copy = JSON.parse(readFileSync(new URL(`../pro-test/src/locales/${locale.id}.json`, import.meta.url), 'utf8'));
      const expected = copy.welcome.nav.launch;
      const window = new Window();
      try {
        window.document.body.innerHTML = nav;
        const launch = window.document.querySelectorAll('a[data-umami-event-target="welcome-nav"]');
        assert.equal(launch.length, 1, 'one Launch CTA in the nav');
        assert.equal(launch[0].getAttribute('aria-label'), expected, 'the label must use the locale copy');
        assert.equal(launch[0].textContent.replace(/\s+/g, ' ').trim(), expected, 'the visible CTA must use the locale copy');
      } finally {
        window.close();
      }
    });
  }

  it('keeps footer copyright and byline at solid muted contrast with no opacity fade', () => {
    const footer = section(html(), '<footer', '</footer>');
    assert.match(footer, /class="[^"]*\btext-xs text-wm-muted\b[^"]*"/, 'the footer text block is muted by colour');
    assert.match(footer, /©|&copy;/, 'the copyright line is rendered');
    const window = new Window();
    try {
      window.document.body.innerHTML = footer;
      for (const element of window.document.querySelectorAll('[class]')) {
        for (const token of element.classList) {
          const match = token.match(/(?:^|:)opacity-(?:(\d+(?:\.\d+)?)|\[(\d+(?:\.\d+)?|\.\d+)(%?)\])$/);
          if (!match) continue;
          const opacity = match[1] !== undefined ? Number(match[1]) / 100 : Number(match[2]) / (match[3] ? 100 : 1);
          assert.ok(opacity >= 1, `${token} must not reduce footer opacity`);
        }
      }
    } finally {
      window.close();
    }
    assert.doesNotMatch(footer, /style="[^"]*opacity/, 'no inline opacity fade either');
  });

  it('carries no Someone.ceo studio byline in the rendered chrome', () => {
    assert.doesNotMatch(html(), /someone\.ceo/i);
  });
});
