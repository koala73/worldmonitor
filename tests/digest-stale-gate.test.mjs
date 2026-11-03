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
