// #7084: the relay's digest-derived alert candidates must skip stale replays,
// but independent fresh X candidates must still run through the combined
// classification pass. The selection logic lives in scripts/lib so this mixed
// input behavior can be executed here; ais-relay.cjs boots on import.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildClassifyCandidateMap,
  isStaleDigestReplay,
  candidateLinkFor,
} = require('../scripts/lib/digest-stale-gate.cjs');

describe('relay digest stale gate (#7084)', () => {
  it('carries story tracking first-seen time so the relay can log how long an alert waited', () => {
    const now = Date.parse('2026-11-16T23:45:00Z');
    const digest = {
      categories: {
        politics: {
          items: [
            { title: 'tracked headline', source: 'CNN World', publishedAt: now - 60_000, storyMeta: { firstSeen: now - 30_000 } },
            { title: 'untracked headline', source: 'CNN World', publishedAt: now - 60_000 },
            { title: 'unset first seen', source: 'CNN World', publishedAt: now - 60_000, storyMeta: { firstSeen: 0 } },
          ],
        },
      },
    };
    const candidates = buildClassifyCandidateMap(digest, [], 'full', now, 6 * 60 * 60 * 1000);
    assert.equal(candidates.get('tracked headline').firstSeen, now - 30_000);
    assert.equal('firstSeen' in candidates.get('untracked headline'), false);
    assert.equal('firstSeen' in candidates.get('unset first seen'), false);
  });

  it('adds fresh pool items the category cap kept off the dashboard, after served ones (#10978)', () => {
    const now = Date.now();
    const digest = { categories: { politics: { items: [{ title: 'served headline', source: 'CNN World', publishedAt: now - 60_000, storyMeta: { firstSeen: now - 30_000 } }] } } };
    const pool = [
      { title: 'served headline', source: 'Gulf News', publishedAt: now - 60_000 },
      { title: 'ADNOC vessel attacked in Strait of Hormuz', source: 'Al Arabiya', publishedAt: now - 120_000, corroborationCount: 2 },
      { title: 'old pool headline', source: 'Al Arabiya', publishedAt: now - 7 * 3_600_000 },
    ];
    const candidates = buildClassifyCandidateMap(digest, [], 'full', now, 6 * 60 * 60 * 1000, undefined, pool);
    assert.equal(candidates.get('served headline').source, 'CNN World');
    assert.equal(candidates.get('served headline').firstSeen, now - 30_000);
    assert.equal(candidates.get('ADNOC vessel attacked in Strait of Hormuz').corroborationCount, 2);
    assert.equal(candidates.has('old pool headline'), false);
    assert.equal('fromPool' in candidates.get('served headline'), false);
    assert.equal(candidates.get('ADNOC vessel attacked in Strait of Hormuz').fromPool, true);
    const stale = { ...digest, coverage: { servedStale: true } };
    assert.equal(buildClassifyCandidateMap(stale, [], 'full', now, 6 * 60 * 60 * 1000, undefined, pool).size, 0);
  });

  it('marks a headline from a feed in another language, served or pooled, so it is labelled but never alerts', () => {
    const now = Date.now();
    const digest = { categories: { europe: { items: [
      { title: 'Es war Völkermord', source: 'Neue Zürcher Zeitung', publishedAt: now - 60_000 },
      { title: 'Court rules on genocide', source: 'BBC World', publishedAt: now - 60_000 },
      // lang ko, but an English Google News query.
      { title: 'Supreme Court overturns jail term', source: 'Hankyoreh', publishedAt: now - 60_000 },
    ] } } };
    const pool = [
      { title: 'Xi, Trump, dan Putin akhiri pertemuan', source: 'ANTARA News', publishedAt: now - 60_000 },
      { title: 'Tanker hit in Hormuz', source: 'Strategic Chokepoints', originPublisher: 'Reuters', publishedAt: now - 60_000 },
      { title: 'Unlisted feed headline', source: 'Not In The Catalog', publishedAt: now - 60_000 },
    ];
    const candidates = buildClassifyCandidateMap(digest, [], 'full', now, 6 * 60 * 60 * 1000, undefined, pool);
    assert.deepEqual([...candidates].filter(([, c]) => c.otherLanguage).map(([title]) => title), ['Es war Völkermord', 'Xi, Trump, dan Putin akhiri pertemuan']);
  });

  it('an English copy of a headline replaces a copy that cannot alert', () => {
    const now = Date.now();
    const title = 'Ukraine says missiles damaged Kerch Bridge';
    const digest = { categories: { europe: { items: [{ title, source: 'Hromadske', publishedAt: now - 60_000 }] } } };
    const pool = [{ title, source: 'BBC World', publishedAt: now - 120_000 }, { title, source: 'Koha', publishedAt: now - 30_000 }];
    const candidate = buildClassifyCandidateMap(digest, [], 'full', now, 6 * 60 * 60 * 1000, undefined, pool).get(title);
    assert.deepEqual([candidate.source, candidate.otherLanguage, candidate.fromPool], ['BBC World', undefined, undefined], 'a served headline stays served');
    const pooled = buildClassifyCandidateMap({ categories: {} }, [], 'full', now, 6 * 60 * 60 * 1000, undefined, [pool[1], pool[0]]).get(title);
    assert.deepEqual([pooled.source, pooled.otherLanguage, pooled.fromPool], ['BBC World', undefined, true]);
  });

  it('skips a server-marked stale replay', () => {
    assert.equal(isStaleDigestReplay({ coverage: { servedStale: true, staleReason: 'build-error' } }), true);
    assert.equal(isStaleDigestReplay({ coverage: { servedStale: true, staleReason: 'gate-held' } }), true);
  });

  it('runs the pass for fresh, partial, and coverage-less digests', () => {
    assert.equal(isStaleDigestReplay({ coverage: { servedStale: false, state: 'complete' } }), false);
    assert.equal(isStaleDigestReplay({ coverage: { state: 'partial' } }), false);
    // Pre-coverage responses and malformed bodies must not block alerting —
    // the gate is strictly about an explicit stale declaration.
    assert.equal(isStaleDigestReplay({}), false);
    assert.equal(isStaleDigestReplay(null), false);
    assert.equal(isStaleDigestReplay(undefined), false);
    assert.equal(isStaleDigestReplay({ coverage: { servedStale: 'true' } }), false);
  });

  it('suppresses stale RSS candidates but keeps fresh X candidates eligible', () => {
    const now = Date.parse('2026-08-26T07:00:00Z');
    const digest = {
      coverage: { servedStale: true, staleReason: 'build-error' },
      categories: {
        conflicts: {
          items: [{
            title: 'replayed RSS event',
            source: 'Reuters',
            publishedAt: now - 60_000,
            link: 'https://example.com/rss',
          }],
        },
      },
    };
    const xCandidates = [{
      title: 'fresh X event',
      source: 'Trusted X account',
      publishedAt: now - 30_000,
      corroborationCount: 1,
      link: 'https://x.com/trusted/status/1',
    }];

    const candidates = buildClassifyCandidateMap(digest, xCandidates, 'global', now, 6 * 60 * 60 * 1000);

    assert.deepEqual([...candidates.entries()], [[
      'fresh X event',
      {
        source: 'Trusted X account',
        publishedAt: now - 30_000,
        corroborationCount: 1,
        link: 'https://x.com/trusted/status/1',
        fromX: true,
      },
    ]]);
  });

  it('preserves fresh digest recency filtering and digest-first title dedupe', () => {
    const now = Date.parse('2026-08-26T07:00:00Z');
    const recencyMs = 6 * 60 * 60 * 1000;
    const digest = {
      coverage: { servedStale: false },
      categories: {
        conflicts: {
          items: [
            { title: 'fresh RSS event', source: 'Reuters', publishedAt: now - 60_000 },
            { title: 'old RSS event', source: 'AP', publishedAt: now - recencyMs - 1 },
          ],
        },
      },
    };
    const xCandidates = [
      { title: 'fresh RSS event', source: 'X duplicate', publishedAt: now, corroborationCount: 1, link: 'x-duplicate' },
      { title: 'fresh X event', source: 'Trusted X account', publishedAt: now, corroborationCount: 1, link: 'x-fresh' },
    ];

    const candidates = buildClassifyCandidateMap(digest, xCandidates, 'global', now, recencyMs);

    assert.deepEqual([...candidates.keys()], ['fresh RSS event', 'fresh X event']);
    assert.equal(candidates.get('fresh RSS event').source, 'Reuters');
  });

  it('marks only X-only candidates, so a headline in both keeps its digest build time', () => {
    // The relay records an alert's build-to-queue delay unless the candidate
    // came from X, which has no digest build. A headline in both inputs is the
    // digest's candidate and must keep that stage.
    const now = Date.parse('2026-11-17T14:00:00Z');
    const digest = {
      coverage: { servedStale: false },
      categories: { conflicts: { items: [{ title: 'in both', source: 'Reuters', publishedAt: now - 60_000 }] } },
    };
    const xCandidates = [
      { title: 'in both', source: 'X duplicate', publishedAt: now, corroborationCount: 1, link: 'x-dup' },
      { title: 'X only', source: 'Trusted X account', publishedAt: now, corroborationCount: 1, link: 'x-only' },
    ];

    const candidates = buildClassifyCandidateMap(digest, xCandidates, 'global', now, 6 * 60 * 60 * 1000);

    assert.equal(candidates.get('in both').fromX, undefined);
    assert.equal(candidates.get('X only').fromX, true);
  });

  it('is actually required by the relay at the digest alert pass', () => {
    // Wiring pin only — the behavioral coverage is above. The relay cannot be
    // imported (it boots on require), so the one thing asserted against its
    // source is that it consumes this module rather than a private copy.
    const { readFileSync } = require('node:fs');
    const src = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    assert.match(src, /require\('\.\/lib\/digest-stale-gate\.cjs'\)/);
    assert.match(src, /isStaleDigestReplay\(digest\)/);
    assert.match(src, /buildClassifyCandidateMap\(digest, xCandidates/);
  });
});

describe('relay rss_alert publisher-link gate (#8398)', () => {
  const now = Date.parse('2026-08-26T07:00:00Z');
  const recencyMs = 6 * 60 * 60 * 1000;
  const digestFor = (items) => ({
    coverage: { servedStale: false },
    categories: { conflicts: { items } },
  });

  it('keeps a link on the publisher family domain in relay candidates', () => {
    const candidates = buildClassifyCandidateMap(
      digestFor([{
        title: 'Reuters event',
        source: 'Reuters World',
        publishedAt: now - 60_000,
        link: 'https://www.reuters.com/world/europe/x',
      }]),
      [],
      'global',
      now,
      recencyMs,
    );
    assert.equal(candidates.get('Reuters event').link, 'https://www.reuters.com/world/europe/x');
  });

  it('blanks an off-publisher link while the title still classifies (#8398 acceptance)', () => {
    // A feed item with an off-publisher link must not produce a
    // notification carrying that link. The title stays a candidate (it
    // still classifies and can alert); only the hostile link is removed.
    const candidates = buildClassifyCandidateMap(
      digestFor([{
        title: 'Attacker event',
        source: 'Reuters World',
        publishedAt: now - 60_000,
        link: 'https://evil.example/phish',
      }]),
      [],
      'global',
      now,
      recencyMs,
    );
    assert.equal(candidates.get('Attacker event').link, '');
    assert.equal(candidates.get('Attacker event').source, 'Reuters World');
  });

  it('blanks links for unlisted feed labels (fail-closed, no silent fold-in)', () => {
    const candidates = buildClassifyCandidateMap(
      digestFor([{
        title: 'New outlet event',
        source: 'Some Brand New Feed',
        publishedAt: now - 60_000,
        link: 'https://somebrandnewfeed.example/a',
      }]),
      [],
      'global',
      now,
      recencyMs,
    );
    assert.equal(candidates.get('New outlet event').link, '');
  });

  // The digest checks each link against the feed's own host, which the relay
  // never sees. 2026-11-17: a critical Egypt Independent alert went out with
  // no link because the relay's family table has no entry for that publisher.
  const EGYPT_INDEPENDENT_LINK =
    'https://www.egyptindependent.com/exclusive-us-intel-indicates-iran-developing-plans/';

  it('keeps a link the digest verified, for a publisher the family table does not list', () => {
    const candidates = buildClassifyCandidateMap(
      digestFor([{
        title: 'Egypt Independent event',
        source: 'Egypt Independent',
        publishedAt: now - 60_000,
        link: EGYPT_INDEPENDENT_LINK,
        linkVerified: true,
      }]),
      [],
      'full',
      now,
      recencyMs,
    );
    assert.equal(candidates.get('Egypt Independent event').link, EGYPT_INDEPENDENT_LINK);
  });

  it('blanks an unlisted publisher link the digest did not verify', () => {
    for (const linkVerified of [undefined, false, null, 'true', 1, {}]) {
      assert.equal(
        candidateLinkFor({ link: EGYPT_INDEPENDENT_LINK, source: 'Egypt Independent', linkVerified }),
        '',
        `linkVerified=${JSON.stringify(linkVerified)}`,
      );
    }
  });

  it('never keeps a non-http(s) link, verified or not', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x', 'ftp://www.egyptindependent.com/x']) {
      assert.equal(candidateLinkFor({ link, source: 'Egypt Independent', linkVerified: true }), '', link);
    }
  });

  it('falls back to the family table for an item with no verified flag', () => {
    // A digest built before the flag shipped, or a cached feed row: same
    // result as before the flag existed.
    const reuters = 'https://www.reuters.com/world/europe/x';
    assert.equal(candidateLinkFor({ link: reuters, source: 'Reuters World' }), reuters);
    assert.equal(candidateLinkFor({ link: 'https://evil.example/phish', source: 'Reuters World' }), '');
  });

  it('candidateLinkFor passes a custom family resolver through', () => {
    assert.equal(
      candidateLinkFor(
        { link: 'https://www.reuters.com/x', source: 'Reuters World' },
        () => 'reuters',
      ),
      'https://www.reuters.com/x',
    );
    assert.equal(
      candidateLinkFor({ link: 'https://evil.example/x', source: 'Reuters World' }, () => 'reuters'),
      '',
    );
    assert.equal(candidateLinkFor({ link: '', source: 'Reuters World' }, () => 'reuters'), '');
  });
});
