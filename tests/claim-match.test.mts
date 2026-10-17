// verify_claim matching core (#9092): finds coverage, never grades it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAIM_CANDIDATE_LIMIT,
  CLAIM_MATCH_MAX_CLUSTERS,
  buildClaimCard,
  claimCandidates,
  checkClaimFigures,
  claimOverlap,
  claimTokens,
  evidenceFromMatches,
  matchClaimToClusters,
} from '../server/_shared/claim-match.ts';
import { assessCorroboration } from '../server/_shared/corroboration.ts';
import type { ClusteredEventCore, NewsItemCore } from '../shared/news-clustering-core.js';

function item(source: string, title: string, extra: Partial<NewsItemCore> = {}): NewsItemCore {
  return { source, title, link: `https://example.test/${encodeURIComponent(source)}/${encodeURIComponent(title)}`, pubDate: new Date('2026-10-09T12:00:00Z'), isAlert: false, ...extra };
}

function cluster(id: string, items: NewsItemCore[], uniquePublisherCount = items.length): ClusteredEventCore {
  return {
    id,
    primaryTitle: items[0]!.title,
    primarySource: items[0]!.source,
    primaryLink: items[0]!.link,
    sourceCount: items.length,
    uniquePublisherCount,
    topSources: [],
    allItems: items,
    firstSeen: items[0]!.pubDate,
    lastUpdated: items[0]!.pubDate,
    isAlert: false,
  };
}

describe('claim tokens and overlap', () => {
  it('drops stopwords and folds accents', () => {
    assert.deepEqual(claimTokens('The Café says Trump announces a diesel deal'), ['cafe', 'trump', 'announces', 'diesel', 'deal']);
  });

  it('scores the share of the claim a headline carries, with stem matches at three quarters', () => {
    const exact = claimOverlap('Trump diesel deal Russia', 'Trump strikes diesel deal with Russia');
    assert.equal(exact.score, 1);
    assert.equal(exact.shared, 4);
    const stemmed = claimOverlap('drone strikes', 'drone strike hits camp');
    assert.equal(stemmed.score, (1 + 0.75) / 2);
  });

  it('an empty or stopword-only claim matches nothing', () => {
    assert.deepEqual(claimOverlap('', 'anything'), { score: 0, shared: 0 });
    assert.deepEqual(claimOverlap('the and of', 'the and of'), { score: 0, shared: 0 });
  });
});

describe('matchClaimToClusters', () => {
  const diesel = cluster('a', [item('Reuters', 'Trump announces diesel deal with Russia'), item('BBC World', 'Russia to supply diesel after Trump deal')]);
  const dieselTwo = cluster('b', [item('CNBC', 'Diesel deal: Trump says Russia will ship fuel')]);
  const quake = cluster('c', [item('AP News', 'Earthquake strikes Panama, dozens hurt')]);

  it('keeps every cluster about the event, best first, and drops the rest', () => {
    const matches = matchClaimToClusters('Trump announces diesel deal with Russia', [quake, dieselTwo, diesel]);
    assert.deepEqual(matches.map((m) => m.cluster.id), ['a', 'b']);
    assert.ok(matches[0]!.score >= matches[1]!.score);
  });

  it('one shared word is not a match', () => {
    assert.deepEqual(matchClaimToClusters('Trump', [diesel]), []);
    assert.deepEqual(matchClaimToClusters('Panama canal tolls rise', [quake]), []);
  });

  it('matches on a member headline, not only the primary', () => {
    const matches = matchClaimToClusters('Russia to supply diesel', [diesel]);
    assert.equal(matches.length, 1);
  });

  it('caps the clusters kept', () => {
    const many = Array.from({ length: CLAIM_MATCH_MAX_CLUSTERS + 3 }, (_, i) => cluster(`x${i}`, [item(`Outlet ${i}`, 'Trump announces diesel deal with Russia')]));
    assert.equal(matchClaimToClusters('Trump diesel deal Russia', many).length, CLAIM_MATCH_MAX_CLUSTERS);
  });
});

describe('evidence and verdict over matched clusters', () => {
  it('syndicated feeds of one publisher count once (single-publisher)', () => {
    const syndicated = cluster('s', [item('Reuters', 'Trump announces diesel deal with Russia'), item('Reuters World', 'Trump announces diesel deal with Russia')], 1);
    const evidence = evidenceFromMatches(matchClaimToClusters('Trump announces diesel deal with Russia', [syndicated]));
    assert.deepEqual(assessCorroboration(evidence), { state: 'single-publisher', publishers: 1 });
  });

  it('independent publishers across several clusters corroborate', () => {
    const a = cluster('a', [item('Reuters', 'Trump announces diesel deal with Russia')]);
    const b = cluster('b', [item('BBC World', 'Trump diesel deal with Russia announced')]);
    const evidence = evidenceFromMatches(matchClaimToClusters('Trump announces diesel deal with Russia', [a, b]));
    assert.deepEqual(assessCorroboration(evidence), { state: 'corroborated', publishers: 2 });
  });

  it('the digest publisher count is a floor, as in evidenceFromCluster', () => {
    const a = cluster('a', [item('Reuters', 'Trump announces diesel deal with Russia', { corroborationCount: 5 })]);
    const evidence = evidenceFromMatches([{ cluster: a, score: 1 }]);
    assert.equal(evidence.reportedPublishers, 5);
    assert.deepEqual(assessCorroboration(evidence), { state: 'corroborated', publishers: 5 });
  });

  it('no match yields no labels, which the verdict reads as unknown', () => {
    assert.deepEqual(assessCorroboration(evidenceFromMatches([])), { state: 'unknown' });
  });
});

describe('checkClaimFigures', () => {
  it('lists claimed figures no matched headline states', () => {
    const check = checkClaimFigures('Panama earthquake kills 200', ['Earthquake strikes Panama, 12 dead', 'Panama quake toll rises to 30']);
    assert.deepEqual(check.claimed, ['200']);
    assert.deepEqual(check.grounded, []);
    assert.deepEqual(check.ungrounded, ['200']);
  });

  it('a figure stated by any matched headline is grounded, in digit or word form', () => {
    const check = checkClaimFigures('Strike kills 31 in camp', ['Drone strike kills thirty-one in Sudan camp']);
    assert.deepEqual(check.ungrounded, []);
    assert.deepEqual(check.grounded, check.claimed);
  });

  it('a date is one figure, grounded by a headline that gives the same day without the year', () => {
    const check = checkClaimFigures('Deal signed on 9 October 2026', ['Deal signed Oct 9 in Moscow']);
    assert.deepEqual(check.claimed, ['2026-10-09']);
    assert.deepEqual(check.grounded, ['2026-10-09']);
    assert.deepEqual(check.ungrounded, []);
  });

  it('a count equal to part of a date is still its own figure', () => {
    const check = checkClaimFigures('Panama earthquake kills 9 on October 9, 2026', ['Panama earthquake on Oct 9 leaves dozens hurt']);
    assert.deepEqual(check.claimed, ['2026-10-09', '9']);
    assert.deepEqual(check.grounded, ['2026-10-09']);
    assert.deepEqual(check.ungrounded, ['9']);
  });

  it('readable figures: percentages and scaled amounts', () => {
    const check = checkClaimFigures('Prices up 3.5% after $12 billion deal', ['Prices rise 3.5% as deal closes']);
    assert.deepEqual(check.claimed, ['12000000000', '3.5%']);
    assert.deepEqual(check.ungrounded, ['12000000000']);
  });

  it('a claim without figures has nothing to check', () => {
    assert.deepEqual(checkClaimFigures('Trump announces diesel deal', ['anything']), { claimed: [], grounded: [], ungrounded: [] });
  });
});

describe('buildClaimCard state', () => {
  const items = [item('Reuters', 'Trump announces diesel deal with Russia'), item('BBC World', 'Trump diesel deal with Russia announced')];

  it('the verdict when the claim is found', () => {
    assert.equal(buildClaimCard('Trump announces diesel deal with Russia', items).state, 'corroborated');
  });

  it('not-found only when there were headlines to search', () => {
    assert.equal(buildClaimCard('Mars colony declares independence', items).state, 'not-found');
    const empty = buildClaimCard('Mars colony declares independence', []);
    assert.equal(empty.state, 'unknown');
    assert.equal(empty.found, false);
  });

  it('candidates of a searched pool: none left is still not-found, because the pool was searched', () => {
    assert.equal(buildClaimCard('Mars colony declares independence', [], 2).state, 'not-found');
  });
});

describe('claimCandidates over a large pool', () => {
  // Clustering keeps only the newest 1,000 items, so 1,200 newer headlines
  // about something else push the two older reports of the claim out.
  const older = new Date('2026-10-14T08:00:00Z');
  const pool = [
    ...Array.from({ length: 1200 }, (_, i) => item(`Feed ${i}`, `Storm number ${i} reaches the coast`, { pubDate: new Date(Date.parse('2026-10-16T08:00:00Z') + i * 1000) })),
    item('Reuters', 'Brazil abolishes six-day workweek in win for Lula', { pubDate: older }),
    item('BBC World', 'Brazil abolishes six-day working week, a win for Lula', { pubDate: older }),
  ];
  const claim = 'Brazil abolishes six-day workweek in win for Lula';

  it('the whole pool loses the older reports to the clustering cap', () => {
    assert.equal(buildClaimCard(claim, pool).state, 'not-found');
  });

  it('the candidates keep them, best overlap first, and only headlines sharing a word', () => {
    const candidates = claimCandidates(claim, pool);
    assert.deepEqual(candidates.map((c) => c.source), ['Reuters', 'BBC World']);
    assert.equal(buildClaimCard(claim, candidates, pool.length).state, 'corroborated');
  });

  it('caps the candidates, newest first among equal overlap', () => {
    const tied = claimCandidates('storm coast', pool, 3);
    assert.deepEqual(tied.map((c) => c.source), ['Feed 1199', 'Feed 1198', 'Feed 1197']);
    assert.equal(claimCandidates(claim, pool).length <= CLAIM_CANDIDATE_LIMIT, true);
  });
});
