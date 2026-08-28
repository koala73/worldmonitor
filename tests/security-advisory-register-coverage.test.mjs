// The travel-advisory LEVEL index must cover every country the register
// publishes, not just the first pageful.
//
// `intelligence:advisories:v1` carries two things with different jobs: an
// `advisories` array (a recency-ordered news list, deliberately bounded) and a
// `byCountry` map (ISO2 -> advisory level). Only `byCountry` answers "how risky
// is travel to X", and it is the sole source for GetCountryRiskResponse's
// top-level `advisoryLevel` and for the CII scorer's advisory input.
//
// Those two jobs were served by one bound. `fetchFeed` truncated every feed to
// 15 items before any of it reached `buildByCountryMap`, which is correct for
// the ~20 news-style feeds (WHO, CDC, ECDC, embassy bulletins) but wrong for
// the US State Dept feed: that is not a news feed, it is a full country
// register publishing one standing advisory per country. 219 items in, 15 kept,
// ~204 countries' levels discarded — so production served `advisoryLevel: ""`
// for Russia, Ukraine, Syria, Afghanistan and every other country outside the
// surviving handful, and the CII scorer fell back to its hardcoded table for
// all of them (`advisoryProvenance: "fallback"`, never `"live"`).
//
// The fix separates the two bounds: the index is built from everything fetched,
// the stored list stays capped per source so the payload does not grow.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ADVISORY_FEED_BYTES,
  buildByCountryMap,
  capPerSource,
  fetchAll,
  fetchFeed,
  mapFeedItems,
  parseUsLevel,
  readBoundedFeedText,
} from '../scripts/seed-security-advisories.mjs';

// The real feed descriptor: the url matters because fetchFeed refuses domains
// outside shared/rss-allowed-domains.json, so a fake host would make the test
// pass by returning [] rather than by exercising anything.
const STATE_DEPT = {
  name: 'US State Dept',
  sourceCountry: 'US',
  sourceCategory: 'travel-advisory',
  url: 'https://travel.state.gov/_res/rss/TAsTWs.xml',
  levelParser: 'us',
};

function rssFor(items) {
  const body = items.map(i =>
    `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pubDate}</pubDate></item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${body}</channel></rss>`;
}

/** Stubbed transport so fetchFeed's own body is the code under test. */
function stubFetch(xml) {
  return async () => ({ ok: true, status: 200, text: async () => xml });
}

// The register's real title format, verified against
// https://travel.state.gov/_res/rss/TAsTWs.xml — every item is
// "<Country> - Level N: <text>", with the level in the title and no <ta:level>.
const REGISTER = [
  ['Russia', 4, 'Do Not Travel'],
  ['Ukraine', 4, 'Do Not Travel'],
  ['Syria', 4, 'Do Not Travel'],
  ['Afghanistan', 4, 'Do Not Travel'],
  ['Iran', 4, 'Do Not Travel'],
  ['Nigeria', 3, 'Reconsider Travel'],
  ['Colombia', 3, 'Reconsider Travel'],
  ['Egypt', 3, 'Reconsider Travel'],
  ['Mexico', 2, 'Exercise Increased Caution'],
  ['France', 2, 'Exercise Increased Caution'],
  ['India', 2, 'Exercise Increased Caution'],
  ['Kenya', 2, 'Exercise Increased Caution'],
  ['Turkey', 2, 'Exercise Increased Caution'],
  ['Brazil', 2, 'Exercise Increased Caution'],
  ['Peru', 2, 'Exercise Increased Caution'],
  // Everything from here on fell past the old 15-item cut.
  ['Japan', 1, 'Exercise Normal Precautions'],
  ['Germany', 2, 'Exercise Increased Caution'],
  ['Australia', 1, 'Exercise Normal Precautions'],
  ['Canada', 1, 'Exercise Normal Precautions'],
  ['Norway', 1, 'Exercise Normal Precautions'],
  ['Portugal', 1, 'Exercise Normal Precautions'],
  ['Chile', 1, 'Exercise Normal Precautions'],
  ['Morocco', 2, 'Exercise Increased Caution'],
  ['Vietnam', 1, 'Exercise Normal Precautions'],
  ['Thailand', 1, 'Exercise Normal Precautions'],
];

function registerItems() {
  return REGISTER.map(([country, level, text], i) => ({
    title: `${country} - Level ${level}: ${text}`,
    link: `https://travel.state.gov/content/travel/en/traveladvisories/${country.toLowerCase()}.html`,
    pubDate: new Date(Date.UTC(2026, 7, 26, 12, 0, i)).toUTCString(),
  }));
}

// A news-style feed: many items about ONE country, no per-item advisory level.
function bulletinItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Security Alert: demonstration notice ${i + 1}`,
    link: `https://ua.usembassy.gov/alert-${i + 1}/`,
    pubDate: new Date(Date.UTC(2026, 7, 26, 9, 0, i)).toUTCString(),
  }));
}

describe('seed-security-advisories — advisory level index coverage', () => {
  it('parses the level out of the register title format', () => {
    // No <ta:level> element exists on this feed; the level is in the title.
    assert.equal(parseUsLevel('Russia - Level 4: Do Not Travel'), 'do-not-travel');
    assert.equal(parseUsLevel('Nigeria - Level 3: Reconsider Travel'), 'reconsider');
    assert.equal(parseUsLevel('Mexico - Level 2: Exercise Increased Caution'), 'caution');
    assert.equal(parseUsLevel('Japan - Level 1: Exercise Normal Precautions'), 'normal');
    // Duplicated suffixes appear verbatim in the live feed.
    assert.equal(parseUsLevel('Israel - Level 3: Reconsider Travel - Level 3: Reconsider Travel'), 'reconsider');
    assert.equal(parseUsLevel('China'), 'info', 'a bare country name carries no level');
  });

  it('indexes every country the register publishes, not just the first pageful', async () => {
    // Drives fetchFeed itself — the function that truncated — rather than the
    // mapping helper downstream of it. Asserting on the helper alone would
    // stay green with the cut restored, which is exactly the failure mode this
    // guard exists to prevent.
    const mapped = await fetchFeed(STATE_DEPT, stubFetch(rssFor(registerItems())));
    assert.equal(
      mapped.length, REGISTER.length,
      `fetchFeed returned ${mapped.length} of ${REGISTER.length} register entries — it is truncating the feed`,
    );
    const byCountry = buildByCountryMap(mapped);

    // The regression: a 15-item cut kept Russia but dropped Germany, and the
    // countries it kept were an accident of feed ordering, not of risk.
    assert.ok(
      Object.keys(byCountry).length >= REGISTER.length - 1,
      `expected ~${REGISTER.length} countries indexed, got ${Object.keys(byCountry).length} — ` +
        'the register is being truncated before it reaches the index',
    );
    assert.equal(byCountry.RU, 'do-not-travel');
    assert.equal(byCountry.UA, 'do-not-travel');
    assert.equal(byCountry.SY, 'do-not-travel');
    assert.equal(byCountry.AF, 'do-not-travel');
    // Past the old cut-off — these are what production was losing.
    assert.equal(byCountry.DE, 'caution');
    assert.equal(byCountry.JP, 'normal');
    assert.equal(byCountry.TH, 'normal');
  });

  it('uses the injected fetcher for every feed', async () => {
    let requestCount = 0;
    const report = await fetchAll({
      feeds: [STATE_DEPT],
      doFetch: async () => {
        requestCount += 1;
        return { ok: true, status: 200, text: async () => rssFor(registerItems()) };
      },
    });

    assert.equal(requestCount, 1);
    assert.equal(report.advisories.length, 15);
    assert.equal(report.byCountry.DE, 'caution');
  });

  it('rejects an oversized feed body before parsing it', async () => {
    let cancelled = false;
    let released = false;
    const reader = {
      async read() {
        return { done: false, value: new Uint8Array(MAX_ADVISORY_FEED_BYTES + 1) };
      },
      async cancel() { cancelled = true; },
      releaseLock() { released = true; },
    };

    await assert.rejects(
      readBoundedFeedText({ headers: { get: () => null }, body: { getReader: () => reader } }),
      /RESPONSE_TOO_LARGE/,
    );
    assert.equal(cancelled, true, 'oversized streams must be cancelled');
    assert.equal(released, true, 'stream locks must be released after rejection');
  });

  it('rejects an oversized advertised feed before reading its body', async () => {
    let cancelled = false;
    let textCalled = false;

    await assert.rejects(
      readBoundedFeedText({
        headers: { get: () => String(MAX_ADVISORY_FEED_BYTES + 1) },
        body: { cancel: async () => { cancelled = true; } },
        text: async () => { textCalled = true; return ''; },
      }),
      /RESPONSE_TOO_LARGE/,
    );
    assert.equal(cancelled, true);
    assert.equal(textCalled, false);
  });

  it('keeps the stored advisory list bounded per source', () => {
    // Coverage must not be bought with an unbounded payload: the news list
    // stays capped, only the index reads everything.
    const items = [
      ...mapFeedItems(registerItems(), STATE_DEPT),
      ...mapFeedItems(bulletinItems(40), { name: 'US Embassy Ukraine', sourceCountry: 'US', sourceCategory: 'travel-advisory', targetCountry: 'UA' }),
    ];
    const capped = capPerSource(items, 15);

    assert.ok(capped.length < items.length, 'cap must actually drop items');
    const perSource = capped.reduce((acc, a) => {
      acc[a.source] = (acc[a.source] ?? 0) + 1;
      return acc;
    }, {});
    for (const [source, n] of Object.entries(perSource)) {
      assert.ok(n <= 15, `${source} kept ${n} items, over the per-source cap`);
    }
    assert.equal(perSource['US State Dept'], 15);
    assert.equal(perSource['US Embassy Ukraine'], 15);
  });

  it('does not let a news feed inflate the country index', () => {
    // 40 bulletins about Ukraine must not become 40 index entries, and must
    // not claim a travel level the feed never stated.
    const mapped = mapFeedItems(bulletinItems(40), {
      name: 'US Embassy Ukraine', sourceCountry: 'US', sourceCategory: 'travel-advisory', targetCountry: 'UA',
    });
    assert.deepEqual(
      buildByCountryMap(mapped), {},
      'level-less bulletins carry no advisory level, so they must not enter the index',
    );
  });
});
