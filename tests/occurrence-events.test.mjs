import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  API_FANOUT_EVENT_TYPES,
  API_FANOUT_LIST_CAP,
  API_FANOUT_LIST_KEY,
  API_FANOUT_LIST_TTL_SECONDS,
  API_FANOUT_TEE_SCRIPT,
  RELAY_EVENT_TO_OCCURRENCE,
  canonicalLink,
  marketEventId,
  normalizeHeadline,
  occurrenceEventIdFor,
  rssEventId,
} = require('../scripts/lib/occurrence-events.cjs');

describe('canonicalLink', () => {
  it('keeps host and path, drops scheme, www, query, fragment and trailing slash', () => {
    assert.equal(canonicalLink('https://www.Reuters.com/world/middle-east/story-1/?utm_source=x#top'), 'reuters.com/world/middle-east/story-1');
    assert.equal(canonicalLink('http://reuters.com/world/middle-east/story-1'), 'reuters.com/world/middle-east/story-1');
  });

  it('is null for empty, relative, or non-http values', () => {
    for (const value of ['', '   ', null, undefined, 'not a url', '/relative/path', 'ftp://example.com/x', 'javascript:alert(1)']) {
      assert.equal(canonicalLink(value), null, String(value));
    }
  });
});

describe('normalizeHeadline', () => {
  it('lowercases, strips a trailing attribution and collapses punctuation', () => {
    assert.equal(normalizeHeadline('Iran’s Guards Say Two Tankers Hit Mines - Reuters'), 'iran s guards say two tankers hit mines');
    assert.equal(normalizeHeadline('Looting, blazes and clashes in France | Al Jazeera'), 'looting blazes and clashes in france');
    assert.equal(normalizeHeadline('  Gunmen   kill four  '), 'gunmen kill four');
  });

  it('keeps a hyphenated phrase that is not an attribution suffix', () => {
    assert.equal(normalizeHeadline('Cease-fire holds in Gaza'), 'cease fire holds in gaza');
  });
});

describe('rssEventId', () => {
  it('is the same id for the five variant copies of one link, whatever the headline wording', () => {
    const link = 'https://www.rferl.org/a/iran-guards-tankers-mines-hormuz/33560001.html';
    const a = rssEventId(link, 'Iran’s Guards Say Two Tankers Hit Mines In Strait Of Hormuz');
    const b = rssEventId(`${link}?variant=finance&utm_campaign=rss`, 'Two tankers hit mines in Hormuz, IRGC says');
    assert.equal(a, b);
    assert.match(a, /^rss_[0-9a-f]{32}$/);
  });

  it('collapses near-duplicate headlines of one story across all five classify variants to one id', () => {
    // The relay classifies per variant (CLASSIFY_VARIANTS in ais-relay.cjs) and
    // its classify cache is keyed by the exact title, so each reworded copy of
    // a story is a separate LLM miss and a separate rss_alert publish. The feeds
    // differ in tracking parameters, scheme, www, fragment and trailing slash.
    const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    const variants = JSON.parse(relay.match(/const CLASSIFY_VARIANTS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
    assert.deepEqual(variants, ['full', 'tech', 'finance', 'happy', 'commodity']);
    const copies = {
      full: ['https://www.reuters.com/world/middle-east/tankers-hit-mines-hormuz-2026-10-17/', 'Two tankers hit mines in Strait of Hormuz, Iran\'s Guards say - Reuters'],
      tech: ['https://reuters.com/world/middle-east/tankers-hit-mines-hormuz-2026-10-17?utm_source=rss&utm_medium=tech', 'Two tankers hit mines in Strait of Hormuz, Iran’s Guards say'],
      finance: ['http://www.Reuters.com/world/middle-east/tankers-hit-mines-hormuz-2026-10-17#markets', 'Oil jumps as two tankers hit mines in Hormuz'],
      happy: ['https://www.reuters.com/world/middle-east/tankers-hit-mines-hormuz-2026-10-17/?taid=abc', 'IRGC: two tankers struck mines in the Strait of Hormuz'],
      commodity: ['https://www.reuters.com/world/middle-east/tankers-hit-mines-hormuz-2026-10-17', 'Tanker mine strikes in Hormuz | Reuters'],
    };
    assert.deepEqual(Object.keys(copies), variants);
    const ids = new Set(variants.map((variant) => rssEventId(...copies[variant])));
    assert.equal(ids.size, 1, 'five variant publishes of one story are one event');
    assert.notEqual([...ids][0], rssEventId('https://www.reuters.com/world/middle-east/tankers-hit-mines-hormuz-follow-up/', copies.full[1]), 'a different article is a different event');
  });

  it('differs between two stories on one site', () => {
    assert.notEqual(
      rssEventId('https://example.org/a/1', 'Same title'),
      rssEventId('https://example.org/a/2', 'Same title'),
    );
  });

  it('falls back to the normalized title when the item carries no link (X candidates), so rewording still collapses', () => {
    const a = rssEventId('', 'BREAKING: Strikes reported in Sanaa - OSINT Watch');
    const b = rssEventId(null, 'breaking strikes reported in sanaa');
    assert.equal(a, b);
    assert.notEqual(a, rssEventId('', 'Strikes reported in Aden'));
  });
});

describe('marketEventId', () => {
  const key = 'market:commodity:newcastle coal:surge:high';

  it('collapses the relay\'s hourly republishes of one move into one id per UTC day', () => {
    const noon = Date.parse('2026-10-17T12:00:00.000Z');
    const ids = [0, 1, 5, 11].map((hours) => marketEventId(key, noon + hours * 3_600_000));
    assert.equal(new Set(ids).size, 1);
    assert.match(ids[0], /^mkt_[0-9a-f]{32}$/);
    assert.notEqual(ids[0], marketEventId(key, Date.parse('2026-10-18T00:00:01.000Z')), 'a move that holds past midnight UTC is a new day\'s event');
  });

  it('separates direction and severity band for the same symbol', () => {
    const at = Date.parse('2026-10-17T12:00:00.000Z');
    assert.notEqual(marketEventId(key, at), marketEventId('market:commodity:newcastle coal:surge:critical', at));
    assert.notEqual(marketEventId(key, at), marketEventId('market:commodity:newcastle coal:decline:high', at));
  });

  it('does not throw on an unparseable publication time', () => {
    assert.match(marketEventId(key, 'nope'), /^mkt_[0-9a-f]{32}$/);
  });
});

describe('occurrenceEventIdFor', () => {
  it('routes the two teed queue event types and ignores the rest', () => {
    assert.equal(occurrenceEventIdFor('rss_alert', { link: 'https://a.b/c', title: 't' }, 0), rssEventId('https://a.b/c', 't'));
    assert.equal(occurrenceEventIdFor('market_alert', { coalesceKey: 'market:equity:vix:surge:critical' }, 1_792_000_000_000), marketEventId('market:equity:vix:surge:critical', 1_792_000_000_000));
    assert.equal(occurrenceEventIdFor('market_alert', { title: 'no key' }, 0), null);
    assert.equal(occurrenceEventIdFor('weather_alert', { title: 'x' }, 0), null);
  });
});

describe('fan-out list contract', () => {
  it('names the two teed queue event types and their registry events', () => {
    assert.deepEqual([...API_FANOUT_EVENT_TYPES].sort(), ['market_alert', 'rss_alert']);
    assert.deepEqual(RELAY_EVENT_TO_OCCURRENCE, { rss_alert: 'news.breaking', market_alert: 'market.move' });
  });

  it('caps and expires the list in the same script that pushes', () => {
    assert.equal(API_FANOUT_LIST_KEY, 'wm:events:api:v1');
    assert.equal(API_FANOUT_LIST_CAP, 2000);
    assert.equal(API_FANOUT_LIST_TTL_SECONDS, 86_400);
    assert.match(API_FANOUT_TEE_SCRIPT, /LPUSH.*LTRIM.*EXPIRE/s);
  });
});
