// Unit coverage for the shared NLP cores extracted in #5697
// (shared/entity-extraction-core.js, shared/keyword-spike-core.js,
// shared/news-clustering-core.js, shared/text-analysis-core.js).
// These run against the REAL entity registry and real implementations —
// no replicas — because the same modules feed both the client pipeline
// and the MCP tools.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEntityIndex,
  extractEntitiesFromTitle,
  findEntitiesInText,
  getEntityIndex,
} from '../shared/entity-extraction-core.js';
import { ENTITY_REGISTRY, getEntityById } from '../shared/entity-registry.js';
import {
  DEFAULT_MIN_SPIKE_COUNT,
  DEFAULT_SPIKE_MULTIPLIER,
  buildBaseTermCandidates,
  computeKeywordSpikesFromStories,
  evaluateSpikeDecision,
  extractEntities,
  stripSourceAttribution,
} from '../shared/keyword-spike-core.js';
import {
  clusterNewsCore,
  effectivePubDateMs,
  topClusterKeywords,
} from '../shared/news-clustering-core.js';
import {
  SUPPRESSED_TRENDING_TERMS,
  jaccardSimilarity,
  tokenize,
} from '../shared/text-analysis-core.js';

describe('entity-extraction-core (real registry)', () => {
  it('matches long aliases at 0.95, short aliases at 0.85, keywords at 0.7', () => {
    const matches = findEntitiesInText('Microsoft and the dow react as gpu demand soars');
    const byId = new Map(matches.map((m) => [m.entityId, m]));

    const msft = byId.get('MSFT');
    assert.ok(msft, 'long alias "microsoft" must match MSFT');
    assert.equal(msft.matchType, 'alias');
    assert.equal(msft.confidence, 0.95);

    const dow = byId.get('^DJI');
    assert.ok(dow, 'short alias "dow" must match ^DJI');
    assert.equal(dow.confidence, 0.85);

    const nvda = byId.get('NVDA');
    assert.ok(nvda, 'keyword "gpu" must match NVDA');
    assert.equal(nvda.matchType, 'keyword');
    assert.equal(nvda.confidence, 0.7);
  });

  it('is idempotent across repeated calls (precompiled g-regex lastIndex reset)', () => {
    const text = 'Apple and Microsoft rally while Nvidia dips';
    const first = findEntitiesInText(text);
    const second = findEntitiesInText(text);
    assert.ok(first.length >= 3, 'sanity: expects at least AAPL/MSFT/NVDA');
    assert.deepEqual(second, first, 'shared compiled regexes must not carry lastIndex between calls');
  });

  it('reports each entity once, sorted by confidence then position', () => {
    const matches = findEntitiesInText('apple apple apple beats Apple expectations');
    const appleMatches = matches.filter((m) => m.entityId === 'AAPL');
    assert.equal(appleMatches.length, 1, 'repeated mentions must collapse to one match');
    const sorted = [...matches].sort((a, b) => b.confidence - a.confidence || a.position - b.position);
    assert.deepEqual(matches, sorted);
  });

  it('extractEntitiesFromTitle resolves display names from the registry', () => {
    const entities = extractEntitiesFromTitle('Nvidia beats expectations');
    const nvda = entities.find((e) => e.entityId === 'NVDA');
    assert.ok(nvda);
    assert.equal(nvda.name, 'NVIDIA Corporation');
  });

  it('buildEntityIndex derives alias matchers from the final alias map', () => {
    const index = buildEntityIndex(ENTITY_REGISTRY);
    assert.ok(index.aliasMatchers.length > 0);
    assert.ok(index.aliasMatchers.every((m) => m.alias.length >= 3));
    assert.equal(index.aliasMatchers.length, [...index.byAlias.keys()].filter((a) => a.length >= 3).length);
    assert.equal(getEntityIndex(), getEntityIndex(), 'singleton index must be cached');
  });

  it('registry lookups agree between entity-registry and the index', () => {
    assert.equal(getEntityById('AAPL')?.name, 'Apple Inc.');
    assert.equal(getEntityById('nope'), undefined);
  });
});

describe('keyword-spike-core', () => {
  it('extracts CVE/APT/FIN designators uppercased plus tracked leaders', () => {
    const entities = extractEntities(
      'cve-2026-12345 exploited by apt28; FIN7 resurfaces as Putin and Xi Jinping meet',
    );
    assert.deepEqual(
      entities.sort(),
      ['APT28', 'CVE-2026-12345', 'FIN7', 'putin', 'xi jinping'].sort(),
    );
  });

  it('stripSourceAttribution removes trailing outlet suffixes only', () => {
    assert.equal(stripSourceAttribution('Markets rally - Reuters'), 'Markets rally');
    assert.equal(
      stripSourceAttribution('Rate cut - a full sentence with punctuation.'),
      'Rate cut - a full sentence with punctuation.',
    );
  });

  it('buildBaseTermCandidates flags regex entities and keeps tokens', () => {
    const candidates = buildBaseTermCandidates('CVE-2026-99999 hits hospitals');
    assert.equal(candidates.get('cve-2026-99999')?.isEntity, true);
    assert.equal(candidates.get('hospitals')?.isEntity, false);
  });

  it('evaluateSpikeDecision enforces min count, strict multiplier, and cold start', () => {
    const base = { minSpikeCount: DEFAULT_MIN_SPIKE_COUNT, spikeMultiplier: DEFAULT_SPIKE_MULTIPLIER };
    assert.equal(evaluateSpikeDecision({ recentCount: 4, baseline: 0, ...base }).isSpike, false);
    assert.equal(evaluateSpikeDecision({ recentCount: 5, baseline: 0, ...base }).isSpike, true, 'cold start spikes at min count');
    assert.equal(
      evaluateSpikeDecision({ recentCount: 6, baseline: 2, ...base }).isSpike,
      false,
      'count == baseline*multiplier must NOT spike (strict >)',
    );
    const spike = evaluateSpikeDecision({ recentCount: 7, baseline: 2, ...base });
    assert.equal(spike.isSpike, true);
    assert.equal(spike.multiplier, 3.5);
  });

  it('computeKeywordSpikesFromStories spikes a bursting multi-source term only', () => {
    const HOUR = 60 * 60 * 1000;
    const nowMs = 1_800_000_000_000;
    const windowMs = 2 * HOUR;
    const baselineDurationMs = 46 * HOUR;
    const stories = [];
    // 5 recent stories about zaporizhzhia from 3 sources — should spike.
    for (let i = 0; i < 5; i++) {
      stories.push({
        title: `Zaporizhzhia plant shelling escalates (${i})`,
        lastSeenMs: nowMs - (i * 10 * 60 * 1000),
        sources: [`source-${i % 3}`],
      });
    }
    // Steady background term across the 48h baseline (outside the window).
    for (let i = 0; i < 30; i++) {
      stories.push({
        title: `Weather outlook stays calm (${i})`,
        lastSeenMs: nowMs - windowMs - (i * 90 * 60 * 1000),
        sources: ['weather-wire'],
      });
    }
    const spikes = computeKeywordSpikesFromStories(stories, { nowMs, windowMs, baselineDurationMs });
    const terms = spikes.map((s) => s.term);
    assert.ok(terms.includes('zaporizhzhia'), `expected zaporizhzhia spike, got: ${terms.join(', ')}`);
    assert.ok(!terms.includes('weather'), 'baseline-only term must not spike');
    const spike = spikes.find((s) => s.term === 'zaporizhzhia');
    assert.equal(spike.count, 5);
    assert.equal(spike.uniqueSources, 3);
    assert.ok(spike.sampleHeadlines.length > 0 && spike.sampleHeadlines.length <= 3);
  });

  it('rejects spikes that lack source diversity', () => {
    const HOUR = 60 * 60 * 1000;
    const nowMs = 1_800_000_000_000;
    const stories = Array.from({ length: 6 }, (_, i) => ({
      title: `Solarwind exploit chatter grows (${i})`,
      lastSeenMs: nowMs - (i * 5 * 60 * 1000),
      sources: ['single-blog'],
    }));
    const spikes = computeKeywordSpikesFromStories(stories, {
      nowMs, windowMs: 2 * HOUR, baselineDurationMs: 46 * HOUR,
    });
    assert.equal(spikes.length, 0, 'single-source bursts must not spike');
  });

  it('suppresses generic news terms via the shared blocklist', () => {
    const HOUR = 60 * 60 * 1000;
    const nowMs = 1_800_000_000_000;
    const stories = Array.from({ length: 6 }, (_, i) => ({
      title: `Breaking update report (${i})`,
      lastSeenMs: nowMs - (i * 5 * 60 * 1000),
      sources: [`s${i}`],
    }));
    const spikes = computeKeywordSpikesFromStories(stories, {
      nowMs, windowMs: 2 * HOUR, baselineDurationMs: 46 * HOUR,
    });
    assert.equal(spikes.length, 0, 'suppressed generic terms must not spike');
  });

  it('normalizes baseline counts over the exact fractional pre-window duration', () => {
    const HOUR = 60 * 60 * 1000;
    const nowMs = 1_800_000_000_000;
    const windowMs = 2 * HOUR;
    const stories = Array.from({ length: 5 }, (_, i) => ({
      title: `Zaporizhzhia alert expands (${i})`,
      lastSeenMs: nowMs - i * 5 * 60 * 1000,
      sources: [`source-${i % 3}`],
    }));
    stories.push({
      title: 'Zaporizhzhia monitoring continues',
      lastSeenMs: nowMs - windowMs - 30 * 60 * 1000,
      sources: ['baseline-wire'],
    });

    const spikes = computeKeywordSpikesFromStories(stories, {
      nowMs,
      windowMs,
      baselineDurationMs: 1 * HOUR,
    });

    assert.equal(
      spikes.some((spike) => spike.term === 'zaporizhzhia'),
      false,
      'one mention in a half-window baseline normalizes to 2/window, so 5 recent is not >3x',
    );
  });

  it('returns no spikes when no pre-window duration is available', () => {
    const HOUR = 60 * 60 * 1000;
    const nowMs = 1_800_000_000_000;
    const stories = Array.from({ length: 5 }, (_, i) => ({
      title: `Zaporizhzhia alert expands (${i})`,
      lastSeenMs: nowMs - i * 5 * 60 * 1000,
      sources: [`source-${i % 3}`],
    }));

    assert.deepEqual(computeKeywordSpikesFromStories(stories, {
      nowMs,
      windowMs: 2 * HOUR,
      baselineDurationMs: 0,
    }), []);
  });
});

describe('news-clustering-core', () => {
  const items = [
    { source: 'Reuters', title: 'Iran closes Strait of Hormuz to all tanker traffic', link: 'https://a/1', pubDate: new Date('2026-07-28T10:00:00Z'), isAlert: true, threat: { level: 'critical', category: 'conflict', confidence: 0.9, source: 'llm' } },
    { source: 'AP', title: 'Iran closes Strait of Hormuz, tanker traffic halted', link: 'https://a/2', pubDate: new Date('2026-07-28T10:05:00Z'), isAlert: false, threat: { level: 'high', category: 'conflict', confidence: 0.8, source: 'keyword' } },
    { source: 'DW', title: 'Berlin zoo welcomes rare panda cub', link: 'https://a/3', pubDate: new Date('2026-07-28T08:00:00Z'), isAlert: false },
  ];

  it('groups near-duplicate titles and aggregates threat to the max level', () => {
    const clusters = clusterNewsCore(items, () => 3);
    assert.equal(clusters.length, 2);
    const hormuz = clusters.find((c) => c.sourceCount === 2);
    assert.ok(hormuz, 'the two Hormuz titles must cluster together');
    assert.equal(hormuz.threat.level, 'critical', 'cluster threat takes the highest member level');
    assert.equal(hormuz.isAlert, true);
    assert.ok(hormuz.topSources.length === 2);
  });

  it('topClusterKeywords ranks member tokens and drops suppressed terms', () => {
    const clusters = clusterNewsCore(items, () => 3);
    const hormuz = clusters.find((c) => c.sourceCount === 2);
    const keywords = topClusterKeywords(hormuz, 5);
    assert.ok(keywords.includes('hormuz'), `expected hormuz in ${keywords.join(', ')}`);
    for (const kw of keywords) {
      assert.ok(!SUPPRESSED_TRENDING_TERMS.has(kw), `suppressed term leaked: ${kw}`);
    }
  });

  it('effectivePubDateMs zeroes missing/invalid stamps and passes real ones', () => {
    assert.equal(effectivePubDateMs({ pubDate: new Date('2026-01-01T00:00:00Z') }), 1767225600000);
    assert.equal(effectivePubDateMs({ pubDate: new Date('2026-01-01'), pubDateMissing: true }), 0);
    assert.equal(effectivePubDateMs({ pubDate: Number.NaN }), 0);
    assert.equal(effectivePubDateMs({ pubDate: 'not-a-date' }), 0);
  });

  it('tokenize + jaccard agree with the clustering threshold contract', () => {
    const a = tokenize('Iran closes Strait of Hormuz to all tanker traffic');
    const b = tokenize('Iran closes Strait of Hormuz, tanker traffic halted');
    assert.ok(jaccardSimilarity(a, b) >= 0.5, 'near-duplicate titles must clear the 0.5 threshold');
    assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
  });
});
