import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ATTEMPT_META_TTL_S,
  LASTGOOD_MAX_AGE_MS,
  LASTGOOD_TTL_S,
  REVOKED_URLS_KEY,
  attemptMetaKey,
  classifyStaleSnapshot,
  filterRevokedUrls,
  isAcceptableDigest,
  isEligibleScope,
  lastGoodKey,
  shouldReplaceAccepted,
} from '../server/worldmonitor/news/v1/_lastgood';

const here = dirname(fileURLToPath(import.meta.url));
const digestSource = readFileSync(
  resolve(here, '..', 'server', 'worldmonitor', 'news', 'v1', 'list-feed-digest.ts'),
  'utf-8',
);

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const ONE_ITEM = { categories: { politics: { items: [{ link: 'https://a.test/1' }] } } };
const RICHER = { categories: { politics: { items: [{ link: 'https://a.test/1' }] }, tech: { items: [{ link: 'https://b.test/1' }] } } };

describe('durable last-good policy (#7084)', () => {
  it('keys the accepted snapshot and attempt metadata by scope', () => {
    assert.equal(lastGoodKey('full', 'en'), 'news:digest:lastgood:v1:full:en');
    assert.equal(attemptMetaKey('tech', 'fr'), 'news:digest:attempt:v1:tech:fr');
    assert.notEqual(lastGoodKey('full', 'en'), lastGoodKey('full', 'fr'));
    assert.notEqual(lastGoodKey('full', 'en'), lastGoodKey('tech', 'en'));
  });

  it('clamps scope keys to known-shape variants and 2-letter languages', () => {
    assert.ok(isEligibleScope('full', 'en'));
    assert.ok(!isEligibleScope('full', 'english'));
    assert.ok(!isEligibleScope('../etc', 'en'));
    assert.ok(!isEligibleScope('full', 'E1'));
  });

  it('expires the accepted snapshot after six hours', () => {
    assert.equal(LASTGOOD_TTL_S, 6 * 60 * 60);
    assert.equal(LASTGOOD_MAX_AGE_MS, 6 * 60 * 60 * 1000);
    assert.ok(ATTEMPT_META_TTL_S > LASTGOOD_TTL_S, 'attempt metadata outlives the snapshot');
  });

  it('accepts only structurally valid digests with real content', () => {
    assert.ok(isAcceptableDigest(ONE_ITEM));
    assert.ok(isAcceptableDigest(RICHER));
    assert.ok(!isAcceptableDigest({ categories: {} }));
    assert.ok(!isAcceptableDigest({ categories: { politics: { items: [] } } }));
    assert.ok(!isAcceptableDigest(null));
    assert.ok(!isAcceptableDigest(undefined));
    assert.ok(!isAcceptableDigest({}));
  });

  it('replaces when there is no accepted snapshot or it has expired', () => {
    assert.deepEqual(shouldReplaceAccepted(null, { categoryCount: 1 }, NOW), {
      replace: true,
      reason: 'no-accepted-snapshot',
    });
    const expired = { acceptedAt: NOW - LASTGOOD_MAX_AGE_MS - 1, categoryCount: 5 };
    assert.deepEqual(shouldReplaceAccepted(expired, { categoryCount: 1 }, NOW), {
      replace: true,
      reason: 'current-expired',
    });
  });

  it('a materially narrower candidate serves but does not displace a richer live snapshot', () => {
    const live = { acceptedAt: NOW - 60_000, categoryCount: 4 };
    assert.deepEqual(shouldReplaceAccepted(live, { categoryCount: 2 }, NOW), {
      replace: false,
      reason: 'narrower-than-live:2<4',
    });
    // Equal or richer replaces.
    assert.equal(shouldReplaceAccepted(live, { categoryCount: 4 }, NOW).replace, true);
    assert.equal(shouldReplaceAccepted(live, { categoryCount: 6 }, NOW).replace, true);
  });

  it('serves a valid snapshot inside the window and reports its age', () => {
    const ageMs = 45 * 60 * 1000;
    const verdict = classifyStaleSnapshot({ acceptedAt: NOW - ageMs, data: ONE_ITEM }, NOW);
    assert.equal(verdict.serve, true);
    assert.equal(verdict.outcome, 'stale');
    assert.equal(verdict.ageSeconds, 45 * 60);
  });

  it('does not serve a missing, expired, future-dated, or empty snapshot', () => {
    assert.equal(classifyStaleSnapshot(null, NOW).outcome, 'unavailable');
    assert.equal(
      classifyStaleSnapshot({ acceptedAt: NOW - LASTGOOD_MAX_AGE_MS - 5_000, data: ONE_ITEM }, NOW).outcome,
      'expired',
    );
    // A future acceptedAt is corrupt, not zero-age.
    assert.equal(classifyStaleSnapshot({ acceptedAt: NOW + 60_000, data: ONE_ITEM }, NOW).outcome, 'expired');
    assert.equal(
      classifyStaleSnapshot({ acceptedAt: NOW - 60_000, data: { categories: {} } }, NOW).outcome,
      'unavailable',
    );
  });

  it('applies the same revocation filter to item lists both paths share', () => {
    const items = [
      { link: 'https://a.test/1' },
      { link: 'https://b.test/2' },
      { link: undefined },
    ];
    assert.deepEqual(filterRevokedUrls(items, new Set()), { kept: items, dropped: 0 });
    const filtered = filterRevokedUrls(items, new Set(['https://a.test/1']));
    assert.deepEqual(
      filtered.kept.map((i) => i.link),
      ['https://b.test/2', undefined],
    );
    assert.equal(filtered.dropped, 1);
  });

  it('names the revocation key as a single narrow versioned set', () => {
    assert.equal(REVOKED_URLS_KEY, 'news:digest:revoked-urls:v1');
  });
});

describe('durable last-good wiring (#7084)', () => {
  it('publishes every fresh digest through the acceptance policy, awaited', () => {
    assert.match(digestSource, /await publishAcceptedSnapshot\(variant, lang, fresh\)/);
  });

  it('tries the durable snapshot before the warm-isolate fallback on a rejected rebuild', () => {
    const nullIdx = digestSource.indexOf("if (fresh === null)");
    const lastgoodIdx = digestSource.indexOf("serveLastGood(variant, lang, 'empty-rebuild')");
    const fallbackIdx = digestSource.indexOf('fallbackDigestCache.get(fallbackKey)?.data ?? empty()', nullIdx);
    assert.ok(nullIdx !== -1 && lastgoodIdx > nullIdx && fallbackIdx > lastgoodIdx, 'ordering: durable before isolate fallback');
  });

  it('tries the durable snapshot on build errors too, with the closed reason', () => {
    assert.match(digestSource, /serveLastGood\(variant, lang, 'build-error'\)/);
  });

  it('never claims durable fallback when Redis is unreadable', () => {
    assert.match(digestSource, /outcome=isolate-fallback reason=redis-unreadable/);
  });

  it('marks the stale response without re-dating the content', () => {
    assert.match(digestSource, /servedStale: true/);
    assert.match(digestSource, /staleReason: reason/);
    assert.match(digestSource, /state: 'stale' as const/);
    // generatedAt passes through untouched — only coverage flips.
    assert.ok(!/generatedAt: new Date\(\)\.toISOString\(\)/.test(digestSource.slice(
      digestSource.indexOf('async function serveLastGood'),
      digestSource.indexOf('async function recordFailedAttempt'),
    )), 'serveLastGood must not re-date the content');
  });

  it('applies the revocation set to fresh serialization inside buildDigest', () => {
    assert.match(digestSource, /const revokedUrls = await readRevokedUrlSet\(\);/);
    assert.match(digestSource, /filterRevokedUrls\(items, revokedUrls\)/);
  });

  it('records the failed attempt outcome for operators', () => {
    assert.match(digestSource, /recordFailedAttempt\(variant, lang, 'empty-rebuild'\)/);
    assert.match(digestSource, /recordFailedAttempt\(variant, lang, 'build-error'\)/);
  });

  it('keeps degraded responses no-store', () => {
    const nullIdx = digestSource.indexOf("if (fresh === null)");
    const branchEnd = digestSource.indexOf('}', nullIdx);
    const branch = digestSource.slice(nullIdx, branchEnd);
    assert.ok(branch.includes('markNoCacheResponse(ctx.request)'), 'no-store before any serving decision');
    assert.ok(branch.indexOf('markNoCacheResponse') < branch.indexOf('serveLastGood'), 'no-store precedes the stale attempt');
  });
});
