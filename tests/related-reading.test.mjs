import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RELATED_READING_PATH, loadRelatedReading, renderRelatedReading } from '../scripts/related-reading.mjs';
import { RELATED_RUBRIC, buildRelatedRequest, pickRelated } from '../scripts/lib/internal-links.mjs';

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function fixtureRoot(pages) {
  const root = mkdtempSync(join(tmpdir(), 'related-reading-'));
  mkdirSync(join(root, 'docs/panels'), { recursive: true });
  writeFileSync(join(root, 'docs/panels/hormuz-tracker.mdx'), '---\ntitle: Hormuz\n---\n');
  if (pages) {
    mkdirSync(dirname(join(root, RELATED_READING_PATH)), { recursive: true });
    writeFileSync(join(root, RELATED_READING_PATH), JSON.stringify({ pages }));
  }
  return root;
}

const blogPostPaths = new Set(['/blog/posts/what-is-a-maritime-chokepoint/']);

describe('loadRelatedReading', () => {
  it('reads blog and docs links keyed by generated page path', () => {
    const root = fixtureRoot({
      '/crises/hormuz-gulf-security/': [
        { href: '/docs/panels/hormuz-tracker', title: 'Hormuz Trade Tracker' },
        { href: '/blog/posts/what-is-a-maritime-chokepoint/', title: 'What is a maritime chokepoint?' },
      ],
    });
    try {
      const map = loadRelatedReading({ rootDir: root, blogPostPaths });
      assert.deepEqual(map.get('/crises/hormuz-gulf-security/').map((i) => i.href), ['/docs/panels/hormuz-tracker', '/blog/posts/what-is-a-maritime-chokepoint/']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is empty when the file does not exist', () => {
    const root = fixtureRoot(null);
    try {
      assert.equal(loadRelatedReading({ rootDir: root, blogPostPaths }).size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [label, items] of [
    ['a deleted blog post', [{ href: '/blog/posts/gone/', title: 'Gone' }]],
    ['a missing docs page', [{ href: '/docs/panels/nope', title: 'Nope' }]],
    ['an off-site link', [{ href: 'https://example.com/', title: 'Elsewhere' }]],
    ['a blank title', [{ href: '/docs/panels/hormuz-tracker', title: ' ' }]],
    ['more than the cap', Array.from({ length: RELATED_RUBRIC.max + 1 }, () => ({ href: '/docs/panels/hormuz-tracker', title: 'H' }))],
  ]) {
    it(`fails the build on ${label}`, () => {
      const root = fixtureRoot({ '/countries/iran/': items });
      try {
        assert.throws(() => loadRelatedReading({ rootDir: root, blogPostPaths }), /related-reading\.json/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('renderRelatedReading', () => {
  it('renders nothing without links and escapes titles', () => {
    assert.equal(renderRelatedReading(undefined, escapeHtml), '');
    assert.equal(renderRelatedReading([], escapeHtml), '');
    const html = renderRelatedReading([{ href: '/docs/a', title: 'A <b> & "c"' }], escapeHtml);
    assert.match(html, /<h2>Related reading<\/h2>/);
    assert.match(html, /<a href="\/docs\/a">A &lt;b> &amp; &quot;c&quot;<\/a>/);
  });
});

describe('related reading judge', () => {
  const candidates = [
    { title: 'Hormuz Trade Tracker', about: 'Panel' },
    { title: 'Data sources', about: 'Every feed' },
    { title: 'What is a chokepoint', about: 'Explainer' },
    { title: 'Algorithms', about: 'Scores' },
  ];

  it('asks one yes/no question per candidate', () => {
    const req = buildRelatedRequest({ url: 'u', title: 'Hormuz', about: 'a', plain: 'x y' }, candidates);
    assert.deepEqual(Object.keys(req.questions), ['t1', 't2', 't3', 't4']);
    assert.ok(Object.values(req.questions).every((q) => q.type === 'noul'));
  });

  it('keeps sure answers only, best first, at most the cap', () => {
    const body = { answers: { t1: { noul: 0.9 }, t2: { noul: RELATED_RUBRIC.threshold - 0.01 }, t3: { noul: 0.95 }, t4: { noul: 0.8 } } };
    const picked = pickRelated(body, candidates, { ...RELATED_RUBRIC, max: 2 });
    assert.deepEqual(picked.map((p) => p.candidate.title), ['What is a chokepoint', 'Hormuz Trade Tracker']);
    assert.deepEqual(pickRelated({}, candidates), []);
  });
});
