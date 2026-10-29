// The homepage and /pro quote people who vouched for World Monitor, high on
// the page, and only people who gave permission. Press stays a linked row
// beside the quotes rather than repeated as press quotes.

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
const PRESS_HOSTS = new Set(
  [...read('shared/press.ts').matchAll(/'(https:\/\/[^']+)'/g)].map((m) => new URL(m[1]).hostname),
);

describe('homepage and /pro voices', () => {
  it('quotes only people who gave permission, each linked to their own post', () => {
    assert.equal(voices.length, (voicesSource.match(/\bquote: '/g) ?? []).length, 'every VOICES entry must parse');
    assert.ok(voices.length >= 6);
    for (const { name, href } of voices) {
      const url = new URL(href);
      assert.equal(url.protocol, 'https:', `${name} link must be https`);
      if (url.hostname === 'x.com') {
        const handle = url.pathname.split('/')[1];
        assert.ok(PERMITTED_X_HANDLES.has(handle), `${name} (@${handle}) has no recorded permission`);
        assert.match(url.pathname, /^\/\w+\/status\/\d+$/, `${name} must link the exact post`);
      }
      assert.ok(!PRESS_HOSTS.has(url.hostname), `${name}: press belongs in the press row, not the quotes`);
    }
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
