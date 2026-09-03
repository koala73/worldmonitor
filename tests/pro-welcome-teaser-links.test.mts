/**
 * The live (post-hydration) half of the #7608 fix.
 *
 * The frozen half — the committed fallback rendered into the SEO prerender —
 * is covered by tests/welcome-teasers.test.mjs. This file covers the browser
 * path that replaces it a moment later, where the same rule has to hold: a
 * headline shown beside a masthead must link to the article that backs it, and
 * anything that is not a verifiable article URL must degrade to plain text
 * rather than become a live href.
 *
 * That check is a single ternary in a file with no other test, and it is the
 * only thing standing between a hostile or useless RSS <link> and an anchor in
 * a real visitor's browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fetchLiveTeasers } from '../pro-test/src/services/teasers.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const originalFetch = globalThis.fetch;

interface DigestItem {
  title: string;
  source: string;
  link?: string;
  publishedAt: number;
  importanceScore: number;
}

function digestItem(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    title: 'Outside forces fuel Sudan war, new report finds',
    source: 'UN News',
    link: 'https://news.un.org/feed/view/en/story/2026/09/1168270',
    publishedAt: Date.now() - 60 * 60 * 1000,
    importanceScore: 50,
    ...overrides,
  };
}

/**
 * Serve the news digest and fail every other teaser endpoint, so each case
 * exercises the headline path alone and the other three cards keep their
 * committed fallback.
 */
function stubDigest(items: DigestItem[]): void {
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.endsWith('/api/wm-session')) {
      return { ok: true, status: 200, json: async () => ({ token: 't' }) };
    }
    if (href.includes('list-feed-digest')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          generatedAt: new Date().toISOString(),
          categories: { politics: { items } },
        }),
      };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
}

describe('live welcome headlines link only to verifiable articles', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('keeps a genuine publisher link', async () => {
    stubDigest([digestItem()]);
    const { headlines } = await fetchLiveTeasers();
    assert.equal(headlines.items[0].url, 'https://news.un.org/feed/view/en/story/2026/09/1168270');
    assert.equal(headlines.items[0].source, 'UN News');
  });

  it('drops a non-https link instead of rendering it as an href', async () => {
    for (const link of ['http://example.test/a', 'javascript:alert(1)', '', undefined]) {
      stubDigest([digestItem({ title: `link=${String(link)}`, link })]);
      const { headlines } = await fetchLiveTeasers();
      assert.equal(
        headlines.items[0].url,
        '',
        `${String(link)} must degrade to plain text, not become a live href`,
      );
      // The row still publishes — only its link is withheld.
      assert.equal(headlines.items[0].title, `link=${String(link)}`);
    }
  });

  it('drops an aggregator redirect, matching the freeze', async () => {
    // scripts/freeze-crawlable-live-pulse.mjs rejects these because the URL is
    // opaque and expiring: the masthead is real but a reader cannot check the
    // story. The live path must not be laxer than the frozen one.
    stubDigest([digestItem({ link: 'https://news.google.com/rss/articles/CBMifzFBVV95cUx' })]);
    const { headlines } = await fetchLiveTeasers();
    assert.equal(headlines.items[0].url, '');
  });

  it('breaks importance ties the same way the freeze does', async () => {
    // Sorting on importance alone leaves ties to array order, so a tie at the
    // fourth slot could swap which headline the live fetch shows versus the
    // frozen row it replaces in place.
    const now = Date.now();
    stubDigest([
      digestItem({ title: 'older', importanceScore: 80, publishedAt: now - 9_000_000 }),
      digestItem({ title: 'newer', importanceScore: 80, publishedAt: now - 1_000 }),
      digestItem({ title: 'highest', importanceScore: 99, publishedAt: now - 9_000_000 }),
    ]);
    const { headlines } = await fetchLiveTeasers();
    assert.deepEqual(headlines.items.map((h) => h.title), ['highest', 'newer', 'older']);
  });
});

describe('third-party headline text survives the prerender splice', () => {
  // Positive control for the hazard itself. Without this, the assertion below
  // reads as style preference rather than a defect being held closed.
  it('a STRING replacement expands $-patterns in the injected markup', () => {
    const page = '<html><body><div id="root"></div></body></html>';
    const marker = '<div id="root"></div>';
    // React escapes `'` to `&#x27;`, so a headline containing `$'` arrives at
    // the splice as a literal `$&` -- the "insert the matched substring" pattern.
    const ssr = '<li>Oil at $&#x27;record&#x27; highs</li>';
    const corrupted = page.replace(marker, `<div id="root">${ssr}</div>`);
    assert.equal(
      (corrupted.match(/id="root"/g) ?? []).length,
      2,
      'premise: a string replacement splices a second #root into the page',
    );
    // A backtick, which React does not escape, is worse: it inserts everything
    // before the match -- the whole preceding document.
    const withBacktick = page.replace(marker, '<div id="root"><li>a $` b</li></div>');
    assert.match(withBacktick, /<html><body><div id="root"><li>a <html>/);
  });

  it('prerender.mjs splices with function replacements, not replacement strings', () => {
    const source = readFileSync(resolve(repoRoot, 'pro-test/prerender.mjs'), 'utf8');
    for (const call of [
      'html.replace(emptyRoot,',
      'html.replace(stylesheetTag,',
      'rewritten.replace(sourceAssetPattern,',
    ]) {
      const index = source.indexOf(call);
      assert.notEqual(index, -1, `${call} moved -- update this guard`);
      assert.match(
        source.slice(index, index + call.length + 8),
        /\(\) =>/,
        `${call} must take a replacer FUNCTION: since #7608 the spliced markup carries `
        + 'headline text from third-party RSS feeds, and a string replacement would let '
        + 'a $-pattern in a headline rewrite the page',
      );
    }
  });

  it('the function form leaves the same headline verbatim', () => {
    const page = '<html><body><div id="root"></div></body></html>';
    const marker = '<div id="root"></div>';
    const ssr = '<li>Oil at $&#x27;record&#x27; highs</li>';
    const safe = page.replace(marker, () => `<div id="root">${ssr}</div>`);
    assert.equal((safe.match(/id="root"/g) ?? []).length, 1);
    assert.match(safe, /Oil at \$&#x27;record&#x27; highs/);
  });
});
