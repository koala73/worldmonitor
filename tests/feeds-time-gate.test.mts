// Every Google-News-backed server feed MUST carry a `when:Nd` time gate.
// Without one, Google News returns any indexed page on the target domain —
// including static institutional landing pages with no temporal relevance —
// which is the contamination class that landed three Pentagon static pages in
// user_3BovQ1tYlaz2YIGYAdDPXGFBgKy's brief 2026-04-25-2001.
//
// Feeds are declared once in shared/news-catalog.json with expanded URLs, so
// the check reads the server view the digest fetches.
//
// See: docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md
// (R1, U1).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildServerIntelSources, buildServerVariantFeeds } from '../shared/news-catalog.ts';

const GOOGLE_NEWS_SEARCH = 'https://news.google.com/rss/search';

function serverGoogleNewsFeeds(): Array<{ name: string; query: string }> {
  const feeds = [
    ...Object.values(buildServerVariantFeeds()).flatMap((byCategory) => Object.values(byCategory).flat()),
    ...buildServerIntelSources(),
  ];
  return feeds
    .filter((feed) => feed.url.startsWith(GOOGLE_NEWS_SEARCH))
    .map((feed) => ({ name: feed.name, query: new URL(feed.url).searchParams.get('q') ?? '' }));
}

describe('server Google News feeds carry a time gate', () => {
  it('every server Google News query carries a when:Nd clause', () => {
    // Accept when:1d through when:99d anywhere in the query.
    const offenders = serverGoogleNewsFeeds().filter((feed) => !/\bwhen:\d{1,2}d\b/.test(feed.query));
    assert.deepEqual(
      offenders,
      [],
      `Found ${offenders.length} Google News feed(s) without a when:Nd time gate. ` +
        `Without when:Nd, Google News surfaces static institutional pages from ` +
        `the target domain. Add when:1d (daily news), when:3d (slower-cadence ` +
        `news), or when:7d (think-tank analysis) per the cadence of the source.`,
    );
  });

  it('finds the server Google News feeds (guards an empty extraction)', () => {
    assert.ok(serverGoogleNewsFeeds().length >= 10);
  });
});
