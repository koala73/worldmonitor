// The homepage and /pro quote the press and people who vouched for World
// Monitor, high on the page, in one sideways-scrolling row. X authors appear
// only with permission, and every card opens the article or the exact post.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

const voicesSource = read('pro-test/src/components/Voices.tsx');
const voices = [...voicesSource.matchAll(/\{\s*quote: '((?:[^'\\]|\\.)*)',\s*name: '([^']+)',\s*role: '([^']+)',\s*href: '([^']+)',(\s*translatedFrom: '(\w+)',)?\s*\}/g)]
  .map((m) => ({ quote: m[1], name: m[2], href: m[4], translatedFrom: m[6] }));

// X authors who gave permission on 2026-10-29. A new X voice needs the
// author's go-ahead first, then an entry here.
const PERMITTED_X_HANDLES = new Set(['ihteshamali', 'didier_lopes', 'bilawalsidhu', 'heynavtoor', 'AkinUnver', 'ntv_rd', 'MarioNawfal']);
const PRESS_URLS = new Set([...read('shared/press.ts').matchAll(/'(https:\/\/[^']+)'/g)].map((m) => m[1]));

describe('homepage and /pro voices', () => {
  it('quotes press articles and permitted X authors, each linked to the source', () => {
    assert.equal(voices.length, (voicesSource.match(/\bquote: '/g) ?? []).length, 'every VOICES entry must parse');
    assert.ok(voices.length >= 4 && voices.length <= 6, `keep the row short, got ${voices.length}`);
    for (const { name, href } of voices) {
      const url = new URL(href);
      assert.equal(url.protocol, 'https:', `${name} link must be https`);
      if (url.hostname === 'x.com') {
        const handle = url.pathname.split('/')[1];
        assert.ok(PERMITTED_X_HANDLES.has(handle), `${name} (@${handle}) has no recorded permission`);
        assert.match(url.pathname, /^\/\w+\/status\/\d+$/, `${name} must link the exact post`);
      } else {
        assert.ok(PRESS_URLS.has(href), `${name} must link an article listed in shared/press.ts`);
      }
    }
    const firstX = voices.findIndex((v) => new URL(v.href).hostname === 'x.com');
    assert.ok(firstX > 0, 'press quotes lead the row');
    assert.ok(voices.slice(firstX).every((v) => new URL(v.href).hostname === 'x.com'), 'press quotes come before X posts');
  });

  it('makes each whole card the link, in one row that scrolls sideways', () => {
    const cards = voicesSource.slice(voicesSource.indexOf('export const VoiceCards'));
    assert.ok(cards.length > 0, 'VoiceCards must be defined');
    assert.match(cards, /<ul ref=\{rowRef\} className="[^"]*\bflex\b[^"]*\boverflow-x-auto\b[^"]*\bsnap-x\b/);
    assert.match(cards, /<li [^>]*>\s*<a\s+href=\{voice\.href\}[^>]*>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<blockquote/);
    // The quotes are English on every locale, so screen readers must not voice them as the page language.
    // ...and RTL pages (ar, fa) must not reorder their punctuation.
    assert.match(cards, /<blockquote lang="en" dir="ltr"/);
    assert.match(cards, /<span lang="en" dir="ltr">\s*<span className="font-bold text-wm-text">\{voice\.name\}/);
    assert.doesNotMatch(cards, /columns-\d/);
  });

  // Paging and end states, in LTR and RTL, are exercised by clicking in
  // tests/dom/welcome-voices-arrows.test.mts.
  it('labels both arrows through i18n', () => {
    const buttons = [...voicesSource.matchAll(/<button [^\n]*/g)].map((m) => m[0]);
    assert.equal(buttons.length, 2);
    assert.match(buttons[0], /aria-label=\{t\('welcome\.voices\.prev'\)\}/);
    assert.match(buttons[1], /aria-label=\{t\('welcome\.voices\.next'\)\}/);
  });

  it('labels translated quotes', () => {
    const nippon = voices.find((v) => v.name === 'Nippon TV R&D Lab');
    assert.equal(nippon?.translatedFrom, 'ja');
    assert.match(voicesSource, /translatedFrom === 'ja' && [\s\S]*?t\('welcome\.voices\.translatedJa'\)/);
  });

  it('puts the quotes near the top of the homepage and /pro, with the press row beside them', () => {
    assert.match(read('pro-test/src/WelcomeApp.tsx'), /<TaskRoutes \/>\s*<LiveStrip \/>\s*<Voices \/>/);
    const proOrder = read('pro-test/src/App.tsx').match(/<ProHomeShell[\s\S]*?<\/ProHomeShell>/)?.[0] ?? '';
    const sections = [...proOrder.matchAll(/<([A-Z]\w+)\b/g)].map((m) => m[1]);
    assert.ok(sections.indexOf('SocialProof') > -1 && sections.indexOf('SocialProof') < sections.indexOf('TwoPathSplit'),
      `/pro SocialProof must come before the feature deep-dives, got ${sections.join(', ')}`);
    assert.doesNotMatch(read('pro-test/src/components/Footer.tsx'), /PressNav/);
  });
});
