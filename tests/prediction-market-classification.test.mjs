// Producer-side pool classification for prediction:markets-bootstrap:v1 (#5733).
//
// The bug: seed-prediction-markets built its pools as
//   geopolitical = filterAndScore(markets, null)                     // NO filter
//   tech         = filterAndScore(markets, m => m.tags ∈ TECH_TAGS)
//   finance      = filterAndScore(markets, m => kalshi || tags ∈ FINANCE_TAGS)
// so (a) `geopolitical` was an unfiltered copy of EVERY market, and (b) the tech
// and finance tag lists shared `economy`/`crypto`/`business`, which made the
// three pools near-duplicates. Production on 2026-07-30 published 75 records
// covering only 46 distinct markets, and the geopolitical pool's top-volume
// entry was a Fed-rates market at $45.6M.
//
// These tests run the REAL classifier against the REAL production records in
// tests/fixtures/prediction-markets-raw-candidates.json.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { isGeopoliticalMarket } from '../scripts/_bet-templates-markets-classify.mjs';
import {
  CATEGORIES,
  DEFAULT_CATEGORY,
  MIN_PUBLISHED_MARKETS,
  allBootstrapMarkets,
  buildBootstrapPools,
  classifyMarket,
  dedupeMarkets,
  formatIntegrityViolations,
  hasCategoryTag,
  marketIdentity,
  partitionMarkets,
  predictionPoolCounts,
  poolIntegrityViolations,
  validateBootstrapPayload,
} from '../scripts/_prediction-classify.mjs';
import { filterAndScore } from '../scripts/_prediction-scoring.mjs';
import predictionTags from '../scripts/data/prediction-tags.json' with { type: 'json' };
import filterParamContracts from '../shared/openapi-filter-param-contracts.json' with { type: 'json' };
import fixture from './fixtures/prediction-markets-raw-candidates.json' with { type: 'json' };

const RAW = fixture.markets;
const FIXTURE_NOW = Date.parse('2026-08-04T00:00:00Z');

// The seeder's REAL pool-building path — buildBootstrapPools is what
// seed-prediction-markets.mjs calls, not a replica of it. This matters: an
// earlier version of this file re-implemented the partition-then-rank wiring
// locally, which meant reverting the seeder to the #5733 shape
// (`filterAndScore(markets, null)` for geopolitical) left the whole suite green.
function buildFixtureBootstrap(markets) {
  return buildBootstrapPools(markets, { now: FIXTURE_NOW });
}

function buildPools(markets) {
  return buildFixtureBootstrap(markets).pools;
}

function filterFixtureMarkets(tagFilter, limit = 25) {
  return filterAndScore(RAW, tagFilter, limit, FIXTURE_NOW);
}

function titles(pool) {
  return pool.map((m) => m.title);
}

describe('#5733 fixture actually exhibits the bug (guards the assertions below from being vacuous)', () => {
  // Without this, "pools are disjoint" could pass simply because the fixture
  // happens to contain no market matching two pools. Replays the OLD pool
  // construction verbatim and pins the duplication it produced.
  const TECH_TAGS = predictionTags.tech;
  const FINANCE_TAGS = predictionTags.finance;

  const legacy = {
    geopolitical: filterFixtureMarkets(null),
    tech: filterFixtureMarkets((m) => m.tags?.some((t) => TECH_TAGS.includes(t))),
    finance: filterFixtureMarkets((m) => m.source === 'kalshi' || m.tags?.some((t) => FINANCE_TAGS.includes(t))),
  };

  it('the legacy geopolitical pool was an unfiltered draw from every category', () => {
    // filterAndScore caps at 25, which is exactly the pool size production
    // published — the pool was the top 25 of ALL markets, not of geo markets.
    assert.equal(legacy.geopolitical.length, 25);
    const drawn = new Set(legacy.geopolitical.map((m) => classifyMarket(m)));
    assert.deepEqual([...drawn].sort(), ['finance', 'geopolitical', 'tech']);
  });

  it('the legacy pools cross-duplicated many markets', () => {
    const counts = new Map();
    for (const category of CATEGORIES) {
      for (const m of legacy[category]) {
        counts.set(marketIdentity(m), (counts.get(marketIdentity(m)) ?? 0) + 1);
      }
    }
    const duplicated = [...counts.values()].filter((n) => n > 1).length;
    assert.ok(duplicated >= 20, `expected the legacy pools to cross-duplicate many markets, got ${duplicated}`);
  });

  it('the legacy geopolitical pool was topped by a non-geopolitical market', () => {
    const top = legacy.geopolitical.slice().sort((a, b) => b.volume - a.volume)[0];
    assert.equal(top.title, 'Will no Fed rate cuts happen in 2026?');
    assert.ok(!isGeopoliticalMarket(top.title));
  });
});

describe('classifyMarket', () => {
  it('assigns exactly one of the three canonical categories', () => {
    for (const m of RAW) {
      assert.ok(CATEGORIES.includes(classifyMarket(m)), `${m.title} → ${classifyMarket(m)}`);
    }
  });

  it('classifies conflict / statecraft / national-election markets as geopolitical', () => {
    for (const title of [
      'Iran agrees to surrender enriched uranium stockpile by December 31, 2026?',
      'Iran coup attempt by December 31?',
      'Iran leadership change by December 31?',
      'Will China invade Taiwan by December 31, 2027?',
      'NATO/EU troops fighting in Ukraine by December 31, 2026?',
      'Will Ukraine agree to cede territory to Russia before 2027?',
      'Will Mojtaba Khamenei be head of state in Iran end of 2026?',
      'Will the Democratic Party control the House after the 2026 Midterm elections?',
      'Will Renan Santos finish in second place in the first round of the 2026 Brazilian presidential election?',
    ]) {
      const market = RAW.find((m) => m.title === title);
      assert.ok(market, `fixture is missing ${title}`);
      assert.equal(classifyMarket(market), 'geopolitical', title);
    }
  });

  it('keeps the crypto / AI / company markets that polluted the geo pool OUT of it', () => {
    for (const title of [
      'Will no Fed rate cuts happen in 2026?',
      'Ledger IPO before 2027?',
      'Will Nebius Group be acquired before 2027?',
      'Will Anthropic have the highest IPO Market Cap 2026?',
      'Will Pump.fun perform an airdrop by December 31, 2026',
      'Opensea FDV above $500M one day after launch?',
      'US recession by end of 2026?',
      'Sam Altman out as OpenAI CEO before 2027?',
      'Will MegaETH perform an airdrop by December 31, 2026?',
      'Will 7-8 SpaceX Starship launches successfully reach Space in 2026?',
      'Will the Doge-1 Lunar Mission launch by December 31, 2026?',
    ]) {
      const market = RAW.find((m) => m.title === title);
      assert.ok(market, `fixture is missing ${title}`);
      assert.notEqual(classifyMarket(market), 'geopolitical', title);
    }
  });

  it('rescues geopolitical markets whose venue tags are absent (Kalshi) via the title', () => {
    // Kalshi records always carry tags: [] — the legacy `source === 'kalshi'`
    // rule filed every one of these under finance.
    for (const title of [
      'Who will succeed Netanyahu as Prime Minister of Israel?: Naftali Bennett',
      'Will Zohran Mamdani become President of the United States before 2045?: Before 2045',
      'Will Nick Fuentes become President of the United States before 2045?: Before 2045',
    ]) {
      const market = RAW.find((m) => m.title === title);
      assert.ok(market, `fixture is missing ${title}`);
      assert.deepEqual(market.tags, []);
      assert.equal(classifyMarket(market), 'geopolitical', title);
    }
  });

  it('rescues geopolitical markets whose title the strict matcher misses, via venue tags', () => {
    // "Berlin state elections" is not in the title matcher's qualified-election
    // vocabulary (it is deliberately precision-first), but the venue tags
    // elections/global-elections/world-elections are unambiguous.
    const market = RAW.find((m) => m.title === 'Will AfD win the most seats in the 2026 Berlin state elections?');
    assert.ok(!isGeopoliticalMarket(market.title), 'title matcher is expected to miss this one');
    assert.ok(hasCategoryTag(market.tags, 'geopolitical'));
    assert.equal(classifyMarket(market), 'geopolitical');
  });

  it('routes rates / macro markets to finance, not tech', () => {
    for (const title of [
      'Will no Fed rate cuts happen in 2026?',
      'US recession by end of 2026?',
      'Will the ECB announce a 25 bps increase at the September 2026 meeting?',
      'ECB rate cut in 2026?',
      'Will the Reserve Bank of India make no change to the policy repo rate after the August Meeting?',
    ]) {
      const market = RAW.find((m) => m.title === title);
      assert.ok(market, `fixture is missing ${title}`);
      assert.equal(classifyMarket(market), 'finance', title);
    }
  });

  it('routes AI / crypto / science markets to tech', () => {
    for (const title of [
      'Will a Chinese company have the best AI model by December 31?',
      'Will Hyperliquid reach $100 by December 31, 2026?',
      'Kraken IPO by December 31, 2026?',
      'Will there be between 11 and 13 earthquakes of magnitude 7.0 or higher worldwide in 2026?',
      'AI bubble burst in 2026?',
    ]) {
      const market = RAW.find((m) => m.title === title);
      assert.ok(market, `fixture is missing ${title}`);
      assert.equal(classifyMarket(market), 'tech', title);
    }
  });

  it('falls back to the documented default when nothing matches', () => {
    // Hardcoded, NOT compared against DEFAULT_CATEGORY: round-tripping through
    // the constant under test would let a flip to 'geopolitical' pass here and
    // silently recreate the #5733 catch-all geo pool.
    assert.equal(classifyMarket({ title: 'Will an unclassifiable thing happen?', tags: [] }), 'finance');
    assert.equal(classifyMarket({ title: 'Untagged', tags: undefined }), 'finance');
    assert.equal(DEFAULT_CATEGORY, 'finance', 'the exported default must stay finance');
  });

  it('is total — never throws and never returns a non-category for junk input', () => {
    for (const junk of [null, undefined, {}, { title: null, tags: null }, { title: 42, tags: 'nope' }]) {
      assert.ok(CATEGORIES.includes(classifyMarket(junk)), JSON.stringify(junk));
    }
  });

  it('resolves a multi-list market by PRECEDENCE, not by tag disjointness', () => {
    // Disjoint classify lists guarantee no single tag maps to two categories.
    // They do NOT make markets unambiguous: a market routinely carries tags from
    // several lists, and then the order in CATEGORIES decides. Reordering
    // CATEGORIES would silently move these between published pools.
    assert.deepEqual([...CATEGORIES], ['geopolitical', 'tech', 'finance'], 'precedence order is a contract');

    // crypto (tech) + business/finance (finance) -> tech wins, because tech is first.
    const kraken = RAW.find((m) => m.title === 'Kraken IPO by December 31, 2026?');
    assert.ok(kraken.tags.includes('crypto') && kraken.tags.includes('business'));
    assert.equal(classifyMarket(kraken), 'tech');

    // A geo tag beats both, whatever else the market carries.
    assert.equal(classifyMarket({ title: 'x', tags: ['geopolitics', 'ai', 'economy'] }), 'geopolitical');
    // Title geo beats every tag.
    assert.equal(classifyMarket({ title: 'Iran coup attempt by December 31?', tags: ['ai', 'economy'] }), 'geopolitical');
    // tech beats finance when both match and neither is geo.
    assert.equal(classifyMarket({ title: 'x', tags: ['ai', 'economy'] }), 'tech');
  });

  it('matches tags case-insensitively (Polymarket ships mixed-case slugs like Global-Rates)', () => {
    assert.ok(hasCategoryTag(['GLOBAL-RATES', 'Interest-Rates'], 'finance'));
    assert.ok(hasCategoryTag([' Crypto '], 'tech'));
  });
});

describe('partitionMarkets / published pools', () => {
  const pools = buildPools(RAW);

  it('publishes every market exactly once across the three pools', () => {
    const seen = new Map();
    for (const category of CATEGORIES) {
      for (const m of pools[category]) {
        const id = marketIdentity(m);
        assert.ok(!seen.has(id), `${m.title} appears in both ${seen.get(id)} and ${category}`);
        seen.set(id, category);
      }
    }
    assert.equal(seen.size, RAW.length, 'no market may be dropped by the partition');
  });

  it('no longer inflates the record count with cross-pool copies', () => {
    const total = CATEGORIES.reduce((n, c) => n + pools[c].length, 0);
    assert.equal(total, RAW.length, 'declared record count must equal the distinct market count');
  });

  it('every geopolitical pool entry meets the geo criteria (keyword OR venue category)', () => {
    for (const m of pools.geopolitical) {
      assert.ok(
        isGeopoliticalMarket(m.title) || hasCategoryTag(m.tags, 'geopolitical'),
        `non-geopolitical market in the geo pool: ${m.title}`,
      );
    }
  });

  it('surfaces genuine geopolitics at the top of the geo pool instead of burying it', () => {
    const top = pools.geopolitical.slice().sort((a, b) => b.volume - a.volume)[0];
    assert.equal(top.title, 'Will Mojtaba Khamenei be head of state in Iran end of 2026?');
  });

  it('leaves every pool populated for the site variants that read them', () => {
    for (const category of CATEGORIES) {
      assert.ok(pools[category].length > 0, `${category} pool is empty`);
    }
  });

  it('keeps the pools recognisably distinct rather than near-copies', () => {
    assert.ok(
      pools.geopolitical.length < RAW.length,
      'the geo pool must no longer be a copy of every market',
    );
    for (const title of titles(pools.geopolitical)) {
      assert.ok(!titles(pools.tech).includes(title), `${title} in both geo and tech`);
      assert.ok(!titles(pools.finance).includes(title), `${title} in both geo and finance`);
    }
  });

  it('drops nothing on the floor: partition sizes sum to the input', () => {
    const partitioned = partitionMarkets(RAW);
    const total = CATEGORIES.reduce((n, c) => n + partitioned[c].length, 0);
    assert.equal(total, RAW.length);
  });

  it('tolerates junk entries without dropping valid ones', () => {
    const partitioned = partitionMarkets([null, RAW[0], 'nope', undefined, RAW[2]]);
    const total = CATEGORIES.reduce((n, c) => n + partitioned[c].length, 0);
    assert.equal(total, 2);
  });

  it('returns empty pools for a non-array input instead of throwing', () => {
    for (const junk of [null, undefined, {}, 'markets']) {
      const partitioned = partitionMarkets(junk);
      assert.deepEqual(partitioned, { geopolitical: [], tech: [], finance: [] });
    }
  });
});

describe('allBootstrapMarkets', () => {
  it('dedupes the legacy near-duplicate pools and keeps the highest-volume record', () => {
    const market = RAW[0];
    const result = allBootstrapMarkets({
      geopolitical: [{ ...market, volume: 10 }],
      tech: [{ ...market, volume: 30 }],
      finance: [{ ...market, volume: 20 }],
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].volume, 30);
  });
});

describe('poolIntegrityViolations (the publish gate)', () => {
  it('passes the pools the producer actually builds', () => {
    assert.deepEqual(poolIntegrityViolations(buildPools(RAW)), []);
  });

  it('catches a market copied across two pools', () => {
    const geo = RAW.find((m) => m.title === 'Iran coup attempt by December 31?');
    const violations = poolIntegrityViolations({ geopolitical: [geo], tech: [], finance: [geo] });
    assert.ok(violations.some((v) => v.kind === 'duplicate-market'));
  });

  it('catches a mislabeled market — the exact #5733 regression', () => {
    const fed = RAW.find((m) => m.title === 'Will no Fed rate cuts happen in 2026?');
    const violations = poolIntegrityViolations({ geopolitical: [fed], tech: [], finance: [] });
    assert.ok(violations.some((v) => v.kind === 'category-mismatch' && v.expected === 'finance'));
  });

  it('catches the legacy unfiltered geopolitical pool wholesale', () => {
    const violations = poolIntegrityViolations({
      geopolitical: filterFixtureMarkets(null),
      tech: [],
      finance: [],
    });
    assert.ok(violations.length > 0);
  });

  it('reports a pool that is not an array rather than throwing', () => {
    const violations = poolIntegrityViolations({ geopolitical: 'nope', tech: [], finance: [] });
    assert.ok(violations.some((v) => v.kind === 'pool-not-array'));
  });

  it('formats a readable log line for every violation kind, not just mismatch', () => {
    const fed = RAW.find((m) => m.title === 'Will no Fed rate cuts happen in 2026?');
    const geo = RAW.find((m) => m.title === 'Iran coup attempt by December 31?');
    const lines = formatIntegrityViolations([
      ...poolIntegrityViolations({ geopolitical: [fed], tech: [], finance: [] }),
      ...poolIntegrityViolations({ geopolitical: [geo], tech: [], finance: [geo] }),
      ...poolIntegrityViolations({ geopolitical: 'nope', tech: [], finance: [] }),
    ]);
    const joined = lines.join('\n');
    for (const kind of ['category-mismatch', 'duplicate-market', 'pool-not-array']) {
      assert.ok(joined.includes(kind), `${kind} must render a log line:\n${joined}`);
    }
    assert.ok(!joined.includes('undefined'), `no log line may render "undefined":\n${joined}`);
  });

  it('caps the log at the requested number of lines', () => {
    const many = RAW.slice(0, 8).map((m) => ({ ...m, tags: [] }));
    const violations = poolIntegrityViolations({ geopolitical: many, tech: [], finance: [] });
    assert.ok(violations.length > 3);
    assert.equal(formatIntegrityViolations(violations, 3).length, 3);
  });

  it('treats a missing pool as vacuously clean (partial payloads are the caller\'s gate)', () => {
    assert.deepEqual(poolIntegrityViolations({ tech: [], finance: [] }), []);
    assert.deepEqual(poolIntegrityViolations({}), []);
  });
});

describe('dedupeMarkets (upstream fan-out must not freeze the feed)', () => {
  // The Polymarket url is built from `event.slug` while the fetch loop dedupes
  // on `event.id`, so a parent event and its derivative can arrive as two
  // records with one identity. If they classified differently they would land in
  // two pools, and the integrity gate would refuse the WHOLE publish over an
  // upstream quirk — freezing all three pools for 90+ minutes.
  const geo = RAW.find((m) => m.title === 'Iran coup attempt by December 31?');

  it('collapses same-url records, keeping the highest-volume one', () => {
    const low = { ...geo, volume: 1_000_000, title: 'low volume twin' };
    const high = { ...geo, volume: 9_000_000, title: 'high volume twin' };
    const out = dedupeMarkets([low, high]);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'high volume twin');
  });

  it('is order-independent (deterministic run to run)', () => {
    const low = { ...geo, volume: 1_000_000, title: 'low' };
    const high = { ...geo, volume: 9_000_000, title: 'high' };
    assert.equal(dedupeMarkets([low, high])[0].title, 'high');
    assert.equal(dedupeMarkets([high, low])[0].title, 'high');
  });

  it('does not collapse records whose url slug is degenerate', () => {
    // Both producer paths build the url from a template, so a missing
    // slug/ticker yields the literal ".../undefined" for every such record.
    // Keying on that would fuse unrelated markets and drop all but one.
    const a = { ...geo, url: 'https://polymarket.com/event/undefined', title: 'first orphan' };
    const b = { ...geo, url: 'https://polymarket.com/event/undefined', title: 'second orphan' };
    assert.notEqual(marketIdentity(a), marketIdentity(b));
    assert.equal(dedupeMarkets([a, b]).length, 2);
    const kalshi = { ...geo, url: 'https://kalshi.com/markets/undefined', title: 'kalshi orphan' };
    assert.equal(marketIdentity(kalshi), 'title:kalshi orphan');
  });

  it('keeps distinct markets and tolerates junk / non-finite volume', () => {
    assert.equal(dedupeMarkets(RAW).length, RAW.length);
    assert.equal(dedupeMarkets([null, 'x', undefined]).length, 0);
    const noVol = { ...geo, volume: undefined, title: 'no volume' };
    const withVol = { ...geo, volume: 5, title: 'has volume' };
    assert.equal(dedupeMarkets([noVol, withVol])[0].title, 'has volume');
  });

  it('a duplicate that would straddle two pools is absorbed, not published twice', () => {
    // Same url, but tags that classify differently — geo by tag vs tech by tag.
    const asGeo = { ...geo, tags: ['geopolitics'], volume: 2_000_000 };
    const asTech = { ...geo, tags: ['ai'], volume: 1_000_000 };
    const { pools } = buildFixtureBootstrap([...RAW, asTech, asGeo]);
    assert.deepEqual(poolIntegrityViolations(pools), []);
    const appearances = CATEGORIES.flatMap((c) => pools[c]).filter((m) => marketIdentity(m) === marketIdentity(geo));
    assert.equal(appearances.length, 1, 'the straddling duplicate must be published exactly once');
  });

  it('reports how many duplicates it dropped so the seeder can log it', () => {
    const twin = { ...geo, volume: 1 };
    assert.equal(buildFixtureBootstrap([...RAW, twin]).duplicatesDropped, 1);
    assert.equal(buildFixtureBootstrap(RAW).duplicatesDropped, 0);
  });
});

describe('per-pool ranking: relaxation and truncation', () => {
  function synth(n, { tag, price, volume = 50_000 }) {
    return Array.from({ length: n }, (_, i) => ({
      title: `Synthetic market ${i} about nothing in particular`,
      yesPrice: price,
      volume: volume + i,
      url: `https://polymarket.com/event/synthetic-${tag}-${i}`,
      endDate: '2099-01-01T00:00:00Z',
      tags: [tag],
      source: 'polymarket',
    }));
  }

  it('truncates a pool above the 25 cap, dropping the lowest-ranked entries', () => {
    // 30 tech candidates -> the published tech pool caps at 25.
    const { pools, classified } = buildFixtureBootstrap(synth(30, { tag: 'ai', price: 60 }));
    assert.equal(classified.tech, 30);
    assert.equal(pools.tech.length, 25);
    assert.deepEqual(poolIntegrityViolations(pools), []);
  });

  it('relaxes the price band for a pool under 15, as filterAndScore intends', () => {
    // yesPrice 7 fails the strict [10,90] band but passes relaxed [5,95]; with
    // only 3 candidates the pool is under the 15 threshold so relaxation fires.
    const { pools } = buildFixtureBootstrap(synth(3, { tag: 'ai', price: 7 }));
    assert.equal(pools.tech.length, 3, 'narrow pools relax rather than publish empty');
  });

  it('does NOT relax a pool that already has 15+ strict passers', () => {
    const strict = synth(20, { tag: 'ai', price: 60 });
    const edge = synth(1, { tag: 'ai', price: 7 }).map((m) => ({ ...m, url: `${m.url}-edge`, title: 'Edge at 7 percent' }));
    const { pools } = buildFixtureBootstrap([...strict, ...edge]);
    assert.ok(!pools.tech.some((m) => m.title === 'Edge at 7 percent'));
  });

  it('per-pool caps mean a pool cannot crowd out another (the #5733 inversion)', () => {
    // 40 tech candidates + 2 geo: pre-fix a single ranked list would let the
    // tech flood bury both geo markets; per-pool caps keep geo addressable.
    const geoTwo = RAW.filter((m) => classifyMarket(m) === 'geopolitical').slice(0, 2);
    const { pools } = buildFixtureBootstrap([...synth(40, { tag: 'ai', price: 60, volume: 90_000_000 }), ...geoTwo]);
    assert.equal(pools.geopolitical.length, 2);
    assert.equal(pools.tech.length, 25);
  });
});

describe('predictionPoolCounts (seed-meta coverage signal)', () => {
  it('reports the published count for every canonical pool', () => {
    const pools = buildPools(RAW);
    assert.deepEqual(predictionPoolCounts(pools), {
      geopolitical: pools.geopolitical.length,
      tech: pools.tech.length,
      finance: pools.finance.length,
    });
  });

  it('reports absent or malformed pools as zero so health fails closed', () => {
    assert.deepEqual(predictionPoolCounts({ geopolitical: [{}], tech: null, finance: 'nope' }), {
      geopolitical: 1,
      tech: 0,
      finance: 0,
    });
  });

  it('keys stay aligned with api/_pool-coverage health floors', async () => {
    // Edge helpers cannot import seeder modules; both lists must name the same
    // pools or a new category would publish counts health never floors.
    const { PREDICTION_MARKET_MIN_POOL_COUNTS } = await import('../api/_pool-coverage.js');
    assert.deepEqual(
      Object.keys(PREDICTION_MARKET_MIN_POOL_COUNTS).sort(),
      [...CATEGORIES].sort(),
    );
  });
});

describe('validateBootstrapPayload (the seeder\'s validateFn)', () => {
  const silent = { log: () => {} };

  it('accepts the payload the producer actually builds', () => {
    assert.equal(validateBootstrapPayload({ ...buildPools(RAW), fetchedAt: 1 }, silent), true);
  });

  it('rejects a payload with no markets at all', () => {
    assert.equal(validateBootstrapPayload({ geopolitical: [], tech: [], finance: [] }, silent), false);
    assert.equal(validateBootstrapPayload({}, silent), false);
    assert.equal(validateBootstrapPayload(null, silent), false);
  });

  it('accepts a legitimately single-pool cycle instead of freezing the feed', () => {
    // The pre-#5733 floor demanded `finance` be non-empty, which was only safe
    // while finance was the catch-all for every Kalshi record. Now that pool
    // membership is content-decided, a cycle whose Kalshi records are all
    // geopolitical by title and whose Polymarket finance tags all failed yields
    // real, publishable data — rejecting it would strand last-good until
    // /api/health noticed 90 minutes later.
    const pools = buildPools(RAW);
    assert.equal(validateBootstrapPayload({ geopolitical: pools.geopolitical, tech: [], finance: [] }, silent), true);
    assert.equal(validateBootstrapPayload({ geopolitical: [], tech: pools.tech, finance: [] }, silent), true);
    assert.equal(validateBootstrapPayload({ geopolitical: [], tech: [], finance: pools.finance }, silent), true);
  });

  it('rejects a non-empty but severely partial snapshot', () => {
    const oneMarket = { geopolitical: [RAW[0]], tech: [], finance: [] };
    assert.equal(MIN_PUBLISHED_MARKETS, 5);
    assert.equal(validateBootstrapPayload(oneMarket, silent), false);
  });

  it('rejects a payload whose pools are mislabeled — the #5733 regression gate', () => {
    // The exact pre-fix shape: geopolitical is an unfiltered copy of everything.
    const legacyShaped = {
      geopolitical: filterFixtureMarkets(null),
      tech: filterFixtureMarkets((m) => m.tags?.some((t) => predictionTags.tech.includes(t))),
      finance: filterFixtureMarkets((m) => m.source === 'kalshi' || m.tags?.some((t) => predictionTags.finance.includes(t))),
    };
    assert.equal(validateBootstrapPayload(legacyShaped, silent), false);
  });

  it('reports why it refused, so a blocked publish is diagnosable in the Railway log', () => {
    const lines = [];
    const fed = RAW.find((m) => m.title === 'Will no Fed rate cuts happen in 2026?');
    const pools = buildPools(RAW);
    validateBootstrapPayload(
      { geopolitical: [...pools.geopolitical, fed], tech: pools.tech, finance: pools.finance },
      { log: (line) => lines.push(line) },
    );
    assert.ok(lines.some((l) => l.includes('INTEGRITY')), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('Fed rate cuts')), lines.join('\n'));
  });
});

describe('the seeder is wired to the tested pool-building path', () => {
  // buildBootstrapPools is the real guard: the partition-then-rank logic that
  // carried the #5733 bug now lives in ONE function that both the seeder and
  // these tests call, so it cannot be tested in replica. This source assertion
  // is only a supplement for the remaining hole — seed-prediction-markets.mjs
  // calls runSeed at module scope, so no test can import it and prove the call
  // happens. Treat it as a tripwire for a literal revert, NOT as proof of
  // wiring: a determined rewrite could satisfy the regex and still be wrong.
  const source = readFileSync(new URL('../scripts/seed-prediction-markets.mjs', import.meta.url), 'utf8');

  it('calls buildBootstrapPools rather than assembling pools inline', () => {
    assert.match(source, /buildBootstrapPools\(markets\)/);
  });

  it('no longer builds an unfiltered geopolitical pool — the #5733 defect', () => {
    assert.doesNotMatch(source, /filterAndScore\(\s*markets\s*,\s*null\s*\)/);
    assert.doesNotMatch(source, /from '\.\/_prediction-scoring\.mjs'[\s\S]{0,400}filterAndScore/);
  });

  it('uses the shared validateFn instead of an inline population check', () => {
    assert.match(source, /validateFn:\s*validateBootstrapPayload/);
  });

  it('publishes the tested per-pool counts through seed freshness metadata', () => {
    assert.match(
      source,
      /afterPublish:[\s\S]{0,300}freshnessMetaPatch:[\s\S]{0,200}poolCounts:\s*predictionPoolCounts\(data\)/,
    );
  });
});

describe('classification tag data', () => {
  const classify = predictionTags.classify;

  it('declares a tag list for every category', () => {
    for (const category of CATEGORIES) {
      assert.ok(Array.isArray(classify?.[category]) && classify[category].length > 0, category);
    }
  });

  it('keeps the classification tag lists mutually disjoint', () => {
    // The root cause of the near-duplicate pools was `economy`, `crypto`, and
    // `business` living in more than one list. Overlap here silently reintroduces
    // it, since precedence would decide membership invisibly.
    for (const a of CATEGORIES) {
      for (const b of CATEGORIES) {
        if (a >= b) continue;
        const shared = classify[a].filter((t) => classify[b].includes(t));
        assert.deepEqual(shared, [], `${a} and ${b} share tags: ${shared.join(', ')}`);
      }
    }
  });

  it('is lowercase and de-duplicated', () => {
    for (const category of CATEGORIES) {
      const list = classify[category];
      assert.deepEqual(list, list.map((t) => t.toLowerCase()), `${category} must be lowercase`);
      assert.equal(new Set(list).size, list.length, `${category} has duplicate entries`);
    }
  });

  it('stays consistent with the RPC category contracts that select these pools', () => {
    // server/.../list-prediction-markets.ts maps a requested category to a pool
    // using these contracts. A category the RPC calls "tech" must not be
    // classified into a different pool by the producer, or the RPC serves the
    // wrong bucket for it.
    for (const tag of filterParamContracts.predictionMarketTechCategories) {
      assert.equal(classifyMarket({ title: 'x', tags: [tag] }), 'tech', `rpc tech category ${tag}`);
    }
    for (const tag of filterParamContracts.predictionMarketFinanceCategories) {
      assert.equal(classifyMarket({ title: 'x', tags: [tag] }), 'finance', `rpc finance category ${tag}`);
    }
  });
});
