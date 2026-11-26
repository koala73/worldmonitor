// A Google News topic feed names the original publisher in <source>, and the
// relay scores the alert on that publisher's tier (#10977). Two faults kept
// tiered publishers on the feed's tier 4: Google writes "The Times of India"
// for the table key "Times of India", and the relay's tier map left out the
// Telegram table the digest resolves names against. These tests run the
// digest's parser and toProtoItem, the relay's candidate map, and the relay's
// own tier map and scorer from scripts/ais-relay.cjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { __testing__, computeItemCredibilityScore, toProtoItem } from '../server/worldmonitor/news/v1/list-feed-digest';
import { SOURCE_TIERS, declaredSourceTier } from '../server/_shared/source-tiers';
import { countPublisherFamilies, publisherFamilyFor, publisherFamilyForItem } from '../shared/publisher-families.js';
import { foldPublisherName } from '../shared/publisher-name.js';

const require = createRequire(import.meta.url);
const { buildClassifyCandidateMap } = require('../scripts/lib/digest-stale-gate.cjs');
const { reachesRealtimeRules } = require('../scripts/lib/news-story-key.cjs');

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const relaySrc = readFileSync(path.join(scriptsDir, 'ais-relay.cjs'), 'utf8');

function relaySlice(startMarker: string, endMarker: string): string {
  const start = relaySrc.indexOf(startMarker);
  const end = relaySrc.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `relay block ${startMarker} not found`);
  return relaySrc.slice(start, end);
}

// The relay's tier map, tier lookup and scorer, built by the relay's own code
// with its own requireShared, so the test reads the tables the relay ships.
const relay = (() => {
  const context = vm.createContext({
    require, path, __dirname: scriptsDir,
    Date, Math, Number, String, RegExp, Object, Array, Set, Map,
  });
  vm.runInContext(relaySlice('function requireShared(', '\nconst RSS_ALLOWED_DOMAINS'), context);
  vm.runInContext(relaySlice('const RELAY_SOURCE_TIERS', '\nconst CLASSIFY_VALID_LEVELS'), context);
  return {
    tier: vm.runInContext('relayGetSourceTier', context) as (source: string) => number,
    score: vm.runInContext('relayComputeImportanceScore', context) as (
      level: string, source: string, corroboration: number, publishedAt: number, ctx?: object) => number,
  };
})();

const topicFeed = {
  name: 'Tanker & Shipping',
  url: 'https://news.google.com/rss/search?q=tanker+shipping&hl=en-US&gl=US&ceid=US:en',
  lang: 'en',
};
const TITLE = 'US Strikes Iranian Oil Tanker In Gulf Of Oman';

function servedFromTopicFeed(publisher: string) {
  const xml = `<?xml version="1.0"?><rss><channel><item><title>${TITLE} - ${publisher}</title>`
    + '<link>https://news.google.com/rss/articles/abc</link>'
    + `<pubDate>${new Date().toUTCString()}</pubDate><source url="https://example.com">${publisher}</source>`
    + '</item></channel></rss>';
  const parsed = __testing__.parseRssXml(xml, topicFeed, 'energy');
  assert.ok(parsed && parsed.items.length === 1, 'topic feed item parsed');
  return { parsed: parsed.items[0]!, served: toProtoItem(parsed.items[0]!) };
}

function relaySourceFor(served: ReturnType<typeof toProtoItem>): string {
  const digest = { coverage: { servedStale: false }, categories: { energy: { items: [served] } } };
  return [...buildClassifyCandidateMap(digest, [], 'energy', Date.now(), 6 * 3600_000).values()][0].source;
}

function relayScoreForLoneCriticalCopy(publisher: string): number {
  return relay.score('critical', relaySourceFor(servedFromTopicFeed(publisher).served), 1, Date.now(), {
    title: TITLE, classSource: 'llm', entityCorroborationCount: 0,
  });
}

describe('digest and relay resolve one tier for every publisher the digest names (#10977)', () => {
  it('the relay scores every tier-table name on the tier the digest declares for it', () => {
    const mismatches = Object.keys(SOURCE_TIERS)
      .filter((name) => relay.tier(name) !== declaredSourceTier(name))
      .map((name) => `${name}: digest ${declaredSourceTier(name)}, relay ${relay.tier(name)}`);
    assert.deepEqual(mismatches, []);
  });

  it('a Middle East Eye copy from a topic feed scores as tier 2 and reaches the realtime bar', () => {
    const { served } = servedFromTopicFeed('Middle East Eye');
    assert.equal(served.originPublisher, 'Middle East Eye');
    const score = relayScoreForLoneCriticalCopy('Middle East Eye');
    assert.equal(score, 83);
    assert.ok(reachesRealtimeRules('critical', score));
  });
});

describe('a leading "The" names the same publisher (#10977)', () => {
  it('"The Times of India" from a topic feed is served as the tier-table key', () => {
    assert.equal(servedFromTopicFeed('The Times of India').served.originPublisher, 'Times of India');
  });

  it('a lone critical "The Times of India" copy scores 83 through the relay and reaches the realtime bar', () => {
    const score = relayScoreForLoneCriticalCopy('The Times of India');
    assert.equal(score, 83);
    assert.ok(reachesRealtimeRules('critical', score));
  });

  it('the article folds both ways: "Jordan Times" resolves to the key "The Jordan Times"', () => {
    assert.equal(servedFromTopicFeed('Jordan Times').served.originPublisher, 'The Jordan Times');
    assert.equal(relayScoreForLoneCriticalCopy('Jordan Times'), 83);
  });

  it('the digest credits "The Times of India" with the credibility of "Times of India"', () => {
    const credibility = (publisher: string) => computeItemCredibilityScore(servedFromTopicFeed(publisher).parsed, 1);
    assert.equal(credibility('The Times of India'), credibility('Times of India'));
  });

  it('"The Hacker News" keeps tier 3 and "Hacker News" keeps tier 4: an exact key wins', () => {
    assert.equal(servedFromTopicFeed('The Hacker News').served.originPublisher, 'The Hacker News');
    assert.equal(relay.tier(relaySourceFor(servedFromTopicFeed('The Hacker News').served)), 3);
    assert.equal(servedFromTopicFeed('Hacker News').served.originPublisher, 'Hacker News');
    assert.equal(relay.tier(relaySourceFor(servedFromTopicFeed('Hacker News').served)), 4);
  });
});

describe('a leading "The" is one publisher family (#10977)', () => {
  it('one outlet under both spellings counts as one family', () => {
    assert.equal(countPublisherFamilies(['The Times of India', 'Times of India']), 1);
    assert.equal(countPublisherFamilies(['Jerusalem Post', 'The Jerusalem Post']), 1);
    const direct = { source: 'Times of India', originPublisher: '', originPublisherTrusted: false };
    const viaTopicFeed = { source: 'Tanker & Shipping', originPublisher: 'The Times of India', originPublisherTrusted: true };
    assert.equal(publisherFamilyForItem(viaTopicFeed), publisherFamilyForItem(direct));
  });

  it('two tier-table outlets whose names differ only by "The" stay two families', () => {
    const byFold = new Map<string, string[]>();
    for (const name of Object.keys(SOURCE_TIERS)) {
      byFold.set(foldPublisherName(name), [...(byFold.get(foldPublisherName(name)) ?? []), name]);
    }
    const pairs = [...byFold.values()].filter((names) => names.length > 1);
    assert.ok(pairs.some((names) => names.includes('The Hacker News') && names.includes('Hacker News')));
    for (const names of pairs) {
      assert.equal(new Set(names.map(publisherFamilyFor)).size, names.length, `${names.join(' / ')} are distinct outlets`);
    }
  });
});
