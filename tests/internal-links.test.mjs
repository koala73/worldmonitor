import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUBRIC, LinkIndex, applyLinks, buildJevRequest, buildQueue, canonicalHref, hrefFor, mayLink,
  parseJevAnswers, parseMarkdown, placeLinks, plainSegments,
} from '../scripts/lib/internal-links.mjs';

const SITE = 'https://www.worldmonitor.app';

function mdPage(url, kind, text, extra = {}) {
  const md = parseMarkdown(text);
  return {
    key: canonicalHref(url, 'site'), url, kind, file: `${kind}/${url.split('/').pop()}.md`,
    title: md.front.title, about: md.front.description ?? '', headings: md.headings, plain: md.plain, prose: md.prose,
    outbound: new Set(md.hrefs.map((h) => canonicalHref(h, kind)).filter(Boolean)), editable: true, ...extra,
  };
}

const target = (url, kind, title, extra = {}) => ({
  key: canonicalHref(url, 'site'), url, kind, title, about: `${title} explained.`, headings: [], plain: `${title} ${title}`, prose: [], outbound: new Set(), editable: false, ...extra,
});

describe('parseMarkdown', () => {
  it('keeps only prose lines: no frontmatter, fences, headings, JSX, tables, labels or MDX comments', () => {
    const md = parseMarkdown([
      '---', 'title: "Chokepoints"', 'description: How we score them', '---',
      'import X from "./x"',
      '# Heading about the Strait of Hormuz',
      'The Strait of Hormuz carries a fifth of seaborne oil.',
      '```js', 'const hormuz = "Strait of Hormuz";', '```',
      '<Card', '  title="Strait of Hormuz"', '  href="/chokepoints/hormuz"', '>',
      '| Strait of Hormuz | 20% |',
      'Common errors:',
      '{/* Strait of Hormuz', 'note */}',
      '- The Suez Canal is the second route.',
    ].join('\n'));
    assert.deepEqual(md.front, { title: 'Chokepoints', description: 'How we score them' });
    assert.deepEqual(md.prose.map((p) => p.line), [6, 18]);
    assert.deepEqual(md.headings, ['Heading about the Strait of Hormuz']);
    assert.deepEqual(md.hrefs, ['/chokepoints/hormuz']);
  });

  it('records markdown links and href attributes as existing links', () => {
    const md = parseMarkdown('See [the docs](/methodology/chokepoints) and <a href="https://www.worldmonitor.app/blog/posts/x/">x</a>. ![img](/i.png)');
    assert.deepEqual(md.hrefs, ['/methodology/chokepoints', 'https://www.worldmonitor.app/blog/posts/x/']);
  });
});

describe('plainSegments', () => {
  it('never offers code, links, URLs, tags or a bold lead-in', () => {
    const line = '- **Desktop App:** the `desktop app` and [desktop app](/d) at https://x.dev/desktop-app <Tip /> desktop app';
    const text = plainSegments(line).map((s) => s.text).join('|');
    assert.equal((text.match(/desktop app/gi) ?? []).length, 1);
    assert.doesNotMatch(text, /Desktop App/);
  });
});

describe('canonicalHref / hrefFor', () => {
  it('resolves Mintlify-relative docs links under /docs and drops off-site links', () => {
    assert.equal(canonicalHref('/methodology/chokepoints#x', 'docs'), `${SITE}/docs/methodology/chokepoints`);
    assert.equal(canonicalHref('/blog/posts/a/', 'docs'), `${SITE}/blog/posts/a`);
    assert.equal(canonicalHref('/docs/Changelog', 'blog'), `${SITE}/docs/changelog`);
    assert.equal(canonicalHref('https://github.com/koala73/worldmonitor', 'blog'), null);
    assert.equal(canonicalHref('#faq', 'docs'), null);
  });

  it("writes each surface's own link convention", () => {
    const docs = { kind: 'docs' };
    const blog = { kind: 'blog' };
    const docT = { kind: 'docs', url: `${SITE}/docs/panels/stock-analysis` };
    const blogT = { kind: 'blog', url: `${SITE}/blog/posts/a/` };
    const siteT = { kind: 'site', url: `${SITE}/chokepoints/suez-canal/` };
    assert.equal(hrefFor(docs, docT), '/panels/stock-analysis');
    assert.equal(hrefFor(blog, blogT), '/blog/posts/a/');
    assert.equal(hrefFor(blog, docT), `${SITE}/docs/panels/stock-analysis`);
    assert.equal(hrefFor(docs, siteT), `${SITE}/chokepoints/suez-canal/`);
  });

  it('keeps reference docs off blog posts and never repeats an existing link', () => {
    const src = { key: 'a', kind: 'docs', outbound: new Set(['b']) };
    assert.equal(mayLink(src, { key: 'b', kind: 'docs' }), false);
    assert.equal(mayLink(src, { key: 'a', kind: 'docs' }), false);
    assert.equal(mayLink(src, { key: 'c', kind: 'blog' }), false);
    assert.equal(mayLink({ ...src, kind: 'blog' }, { key: 'c', kind: 'blog' }), true);
  });
});

describe('anchor candidates', () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `filler${i}`).join(' ');
  const others = Array.from({ length: 12 }, (_, i) => target(`${SITE}/docs/other-${i}`, 'docs', `Other ${i} topic${i}`));

  it('offers the whole capitalized name, never a cut-off head of it', () => {
    const src = mdPage(`${SITE}/blog/posts/prices`, 'blog', `---\ntitle: Prices\n---\nWe track the FAO Food Price Index every week. ${filler(10)}`);
    const tgt = target(`${SITE}/docs/api-reference/economicservice/getfaofoodpriceindex`, 'docs', 'Food Price API');
    const idx = new LinkIndex([src, tgt, ...others]);
    assert.deepEqual(idx.anchors(0, 1).map((a) => a.phrase), ['FAO Food Price Index']);
  });

  it('offers the noun phrase with and without its next word for the judge to choose', () => {
    const src = mdPage(`${SITE}/docs/premium-finance`, 'docs', `---\ntitle: Premium finance\n---\nRequests share one premium stock analysis cache. ${filler(10)}`);
    const tgt = target(`${SITE}/docs/panels/premium-stock`, 'docs', 'Premium Stock');
    const idx = new LinkIndex([src, tgt, ...others]);
    assert.deepEqual(idx.anchors(0, 1).map((a) => a.phrase).sort(), ['premium stock', 'premium stock analysis']);
  });

  it('allows a one-word anchor only for a generated page name', () => {
    const src = mdPage(`${SITE}/blog/posts/iran`, 'blog', `---\ntitle: Risk\n---\nTensions around Iran rose again. The Errors page lists codes. ${filler(10)}`);
    const country = target(`${SITE}/countries/iran/`, 'site', 'Iran Country Instability Index', { name: 'Iran' });
    const errors = target(`${SITE}/docs/usage-errors`, 'docs', 'Errors');
    const idx = new LinkIndex([src, country, errors, ...others]);
    assert.deepEqual(idx.anchors(0, 1).map((a) => a.phrase), ['Iran']);
    assert.deepEqual(idx.anchors(0, 2), []);
  });

  it('builds no job for a page that already links the only candidate', () => {
    const text = `---\ntitle: Hormuz\n---\nThe [Strait of Hormuz](${SITE}/chokepoints/strait-of-hormuz/) closed. ${filler(130)}`;
    const src = mdPage(`${SITE}/blog/posts/h`, 'blog', text);
    const tgt = target(`${SITE}/chokepoints/strait-of-hormuz/`, 'site', 'Strait of Hormuz');
    assert.deepEqual(buildQueue([src, tgt, ...others], { minWords: 10 }), []);
  });
});

describe('Jev request and placement', () => {
  const job = {
    source: 'src',
    targets: [
      { id: 't1', key: 'k1', url: 'u1', title: 'Scenario Engine', about: '', anchors: [{ phrase: 'Scenario Engine', line: 3, sentence: 's' }, { phrase: 'scenario', line: 4, sentence: 's' }] },
      { id: 't2', key: 'k2', url: 'u2', title: 'Engine room', about: '', anchors: [{ phrase: 'Engine', line: 3, sentence: 's' }] },
      { id: 't3', key: 'k3', url: 'u3', title: 'Desktop app', about: '', anchors: [{ phrase: 'desktop app', line: 9, sentence: 's' }] },
    ],
  };

  it('asks one link and one anchor question per target', () => {
    const req = buildJevRequest(job, { url: 'u', title: 'T', plain: 'a b c' });
    assert.deepEqual(Object.keys(req.questions), ['t1_link', 't1_anchor', 't2_link', 't2_anchor', 't3_link', 't3_anchor']);
    assert.equal(req.questions.t1_link.type, 'noul');
    assert.deepEqual(Object.keys(req.questions.t1_anchor.criteria), ['a1', 'a2', 'none']);
  });

  it('treats malformed or unknown answers as no', () => {
    const v = parseJevAnswers({ answers: { t1_link: { type: 'noul', noul: 0.9 }, t1_anchor: { type: 'choice', choice: 'a7', confidence: 0.9 } } }, job);
    assert.deepEqual(v.t1, { link: 0.9, anchor: 'none', anchorConfidence: 0.9 });
    assert.deepEqual(v.t2, { link: 0, anchor: 'none', anchorConfidence: 0 });
  });

  it('places sure links best first, each phrase once, below the per-page cap', () => {
    const verdicts = {
      t1: { link: 0.8, anchor: 'a1', anchorConfidence: 0.9 },
      t2: { link: 0.95, anchor: 'a1', anchorConfidence: 0.9 },
      t3: { link: RUBRIC.linkThreshold - 0.01, anchor: 'a1', anchorConfidence: 0.9 },
    };
    const placed = placeLinks(job, verdicts);
    assert.deepEqual(placed.map((p) => [p.target, p.anchor]), [['k2', 'Engine']]);
  });
});

describe('applyLinks', () => {
  it('wraps the first plain occurrence and leaves code, links and words that merely contain it alone', () => {
    const text = 'x\nUse `desktop app` or the [desktop app](/a), desktop apps, then the desktop app.';
    const { text: out, skipped } = applyLinks(text, [{ line: 1, anchor: 'desktop app', href: '/desktop-app' }]);
    assert.equal(out, 'x\nUse `desktop app` or the [desktop app](/a), desktop apps, then the [desktop app](/desktop-app).');
    assert.deepEqual(skipped, []);
  });

  it('reports a link whose anchor is gone and changes nothing', () => {
    const text = 'a\nb';
    const { text: out, skipped } = applyLinks(text, [{ line: 1, anchor: 'desktop app', href: '/d' }]);
    assert.equal(out, text);
    assert.equal(skipped.length, 1);
  });

  it('is idempotent: a second apply finds the anchor inside the link it made and skips', () => {
    const link = { line: 0, anchor: 'Scenario Engine', href: '/scenario-engine' };
    const once = applyLinks('The Scenario Engine runs.', [link]).text;
    const twice = applyLinks(once, [link]);
    assert.equal(twice.text, once);
    assert.equal(twice.skipped.length, 1);
  });
});
