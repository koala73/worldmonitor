// Focused regression for koala73/worldmonitor#4714.
//
// Inside Climate News' official WordPress feed (insideclimatenews.org/feed/)
// sits behind Cloudflare bot-management and returned HTTP 403 on 100% of
// Climate-News Railway runs. The issue forbids WAF/bot-detection evasion;
// the official feed's atom:link rel="self" is that same origin, and no
// ungated official mirror (FeedBurner, JSON Feed, etc.) exists. Option 2
// drops the source (9 → 8 feeds). This test pins the remaining list so the
// blocked host cannot silently return.
//
// Seam: CLIMATE_NEWS_FEEDS is exported from the seeder (guarded by isMain
// so importing it here does not trigger a real seed run).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CLIMATE_NEWS_FEEDS } from '../scripts/seed-climate-news.mjs';

const SEEDER_SOURCE = readFileSync(new URL('../scripts/seed-climate-news.mjs', import.meta.url), 'utf8');
const VARIANT_DOCS = readFileSync(new URL('../docs/climate-variant-full.md', import.meta.url), 'utf8');
const ATTRIBUTION_DOCS = readFileSync(new URL('../docs/source-attribution.mdx', import.meta.url), 'utf8');
const ATTRIBUTION_MANIFEST = JSON.parse(
  readFileSync(new URL('../shared/source-attribution-manifest.json', import.meta.url), 'utf8'),
);

const EXPECTED_SOURCE_NAMES = [
  'Carbon Brief',
  'The Guardian Environment',
  'ReliefWeb Disasters',
  'NASA Earth Observatory',
  'UNEP',
  'Phys.org Earth Science',
  'Copernicus Climate',
  'Climate Central',
];

describe('seed-climate-news feed list (#4714)', () => {
  it('has eight sources and does not include Cloudflare-blocked Inside Climate News', () => {
    assert.equal(CLIMATE_NEWS_FEEDS.length, 8);
    assert.deepEqual(
      CLIMATE_NEWS_FEEDS.map((feed) => feed.sourceName),
      EXPECTED_SOURCE_NAMES,
    );
    assert.ok(
      !CLIMATE_NEWS_FEEDS.some((feed) => /inside\s*climate/i.test(feed.sourceName)),
      'Inside Climate News must not remain in the climate-news seeder',
    );
  });

  it('does not reintroduce the Cloudflare-gated ICN host', () => {
    // A URL literal would also re-register the host in the source-attribution
    // scan (scripts/, not comments-exempt). Keep the hostname out of the seeder.
    assert.doesNotMatch(SEEDER_SOURCE, /insideclimatenews\.org/i);
    assert.doesNotMatch(SEEDER_SOURCE, /Inside Climate News/);
  });

  it('keeps remaining feeds as HTTPS URLs or the ReliefWeb API adapter', () => {
    for (const feed of CLIMATE_NEWS_FEEDS) {
      if (feed.isApi) {
        assert.equal(feed.sourceName, 'ReliefWeb Disasters');
        assert.equal(feed.url, undefined);
        continue;
      }
      assert.match(feed.url, /^https:\/\//);
    }
  });

  it('retires the ICN host in the source-attribution ledger instead of leaving a stale observed row', () => {
    const entry = ATTRIBUTION_MANIFEST.entries.find((row) => row.host === 'insideclimatenews.org');
    assert.ok(entry, 'historical credit for the retired host must remain in the ledger');
    assert.equal(entry.observed, false);
    assert.equal(entry.status, 'excluded');
    assert.equal(entry.references, undefined);
    assert.match(ATTRIBUTION_DOCS, /insideclimatenews\.org \(insideclimatenews\.org\) \| Excluded \/ candidate — No current fetch observed/);
    assert.doesNotMatch(VARIANT_DOCS, /insideclimatenews\.org/);
    assert.doesNotMatch(VARIANT_DOCS, /Inside Climate News/);
  });
});
