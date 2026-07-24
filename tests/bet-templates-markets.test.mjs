import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { generateBets } from '../scripts/_bet-templates.mjs';
import {
  MARKET_BET_TEMPLATES, MARKET_FEED, MARKET_SETTLEMENT_FEED, MARKET_MIN_VOLUME,
  eligibleMarkets, marketSlugFromUrl,
} from '../scripts/_bet-templates-markets.mjs';
import { parseMetricKey, resolveHardSpec, MARKET_SETTLEMENT_MAX_LAG_MS } from '../scripts/_forecast-resolution-eval.mjs';
import { RESOLUTION_FEED_KEYS } from '../scripts/_forecast-resolution.mjs';
import { shapeResolutionFeed, ingestHistory } from '../scripts/seed-forecast-resolutions.mjs';
import {
  updateMarketSettlements, parseGammaSettlement, parseKalshiSettlement,
} from '../scripts/_forecast-market-settlements.mjs';

const NOW = Date.parse('2026-07-23T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function market(overrides = {}) {
  return {
    title: 'Will the Fed cut rates in September 2026?',
    yesPrice: 62,
    volume: 500_000,
    url: 'https://polymarket.com/event/fed-cut-september-2026',
    endDate: new Date(NOW + 20 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function feedFixture(markets = [market()], overrides = {}) {
  return { geopolitical: markets, tech: [], finance: [], fetchedAt: NOW, ...overrides };
}

describe('marketSlugFromUrl', () => {
  it('derives venue + slug from polymarket and kalshi urls', () => {
    assert.deepEqual(marketSlugFromUrl('https://polymarket.com/event/fed-cut-2026'), { source: 'polymarket', slug: 'fed-cut-2026' });
    assert.deepEqual(marketSlugFromUrl('https://kalshi.com/markets/KXFED-26SEP'), { source: 'kalshi', slug: 'KXFED-26SEP' });
    assert.equal(marketSlugFromUrl('https://example.com/x'), null);
  });
});

describe('eligibleMarkets + slot templates', () => {
  it('generates a bet per eligible market with a settlement-feed spec and market decorations', () => {
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feedFixture() }, NOW);
    assert.equal(bets.length, 1);
    const bet = bets[0];
    assert.equal(bet.id, 'market:fed-cut-september-2026');
    assert.equal(bet.domain, 'market');
    assert.equal(bet.resolution.sourceFeed, MARKET_SETTLEMENT_FEED);
    assert.equal(bet.resolution.window, 'at-deadline');
    assert.equal(bet.resolution.threshold, 50);
    assert.equal(bet.resolution.deadline, Date.parse(market().endDate));
    assert.equal(bet.marketSlug, 'fed-cut-september-2026');
    assert.equal(bet.marketSource, 'polymarket');
    assert.equal(bet.calibration.marketPrice, 62);
    const parsed = parseMetricKey(bet.resolution.metricKey);
    assert.equal(parsed.fn, 'yesPrice');
    assert.equal(parsed.feedKey, MARKET_SETTLEMENT_FEED);
    assert.ok(RESOLUTION_FEED_KEYS.has(bet.resolution.sourceFeed));
  });

  it('skips thin, dateless, near-dated, and far-dated markets', () => {
    const feed = feedFixture([
      market({ title: 'thin', volume: MARKET_MIN_VOLUME - 1, url: 'https://polymarket.com/event/thin' }),
      market({ title: 'dateless', endDate: undefined, url: 'https://polymarket.com/event/dateless' }),
      market({ title: 'too near', endDate: new Date(NOW + 1 * DAY_MS).toISOString(), url: 'https://polymarket.com/event/near' }),
      market({ title: 'too far', endDate: new Date(NOW + 90 * DAY_MS).toISOString(), url: 'https://polymarket.com/event/far' }),
    ]);
    assert.equal(generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feed }, NOW).length, 0);
  });

  it('dedups the same market across category arrays and sorts by volume', () => {
    const shared = market();
    const bigger = market({ title: 'Bigger market?', volume: 900_000, url: 'https://polymarket.com/event/bigger' });
    const feed = feedFixture([shared], { tech: [shared, bigger] });
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feed }, NOW);
    assert.equal(bets.length, 2);
    assert.equal(bets[0].marketSlug, 'bigger'); // slot 0 = highest volume
  });

  it('extractMetric is pure — eligibility uses the injected nowMs, never the wall clock (review R3 #1)', () => {
    // A feed WITHOUT fetchedAt must fall back to the registry-injected nowMs.
    // Run far in the future: a wall-clock fallback would see this endDate as
    // >45d out and reject it, so the bet only generates if nowMs is honored.
    const FUTURE = Date.parse('2030-01-01T00:00:00Z');
    const feed = {
      geopolitical: [market({ endDate: new Date(FUTURE + 20 * DAY_MS).toISOString() })],
      tech: [],
      finance: [],
    };
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feed }, FUTURE);
    assert.equal(bets.length, 1);
    assert.equal(bets[0].resolution.deadline, FUTURE + 20 * DAY_MS);
  });

  it('keys the metricKey on the stable slug, not the mutable title', () => {
    const tricky = market({ title: 'Will X (or Y==Z) happen?', url: 'https://polymarket.com/event/tricky' });
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feedFixture([tricky]) }, NOW);
    const parsed = parseMetricKey(bets[0].resolution.metricKey);
    assert.equal(parsed.field, 'slug');
    assert.equal(parsed.value, 'tricky');
  });
});

describe('market bets resolve via the settlement feed (pend → settle → resolve)', () => {
  function marketEntry() {
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feedFixture() }, NOW);
    const ledger = ingestHistory({}, [{ generatedAt: NOW, predictions: bets }], NOW);
    return Object.values(ledger)[0];
  }

  it('carries marketSlug/marketSource through resolver ingest', () => {
    const entry = marketEntry();
    assert.equal(entry.marketSlug, 'fed-cut-september-2026');
    assert.equal(entry.marketSource, 'polymarket');
  });

  it('pends at endDate while no settlement record exists (empty feed present)', () => {
    const entry = marketEntry();
    const res = resolveHardSpec(entry, [], [], entry.deadline + DAY_MS);
    assert.equal(res.status, 'pending');
    assert.equal(res.evidence.reason, 'value_source_record_missing');
  });

  it('resolves YES/NO from a settled record regardless of its asOf timing', () => {
    const entry = marketEntry();
    const settledYes = shapeResolutionFeed(MARKET_SETTLEMENT_FEED, {
      records: [{ market: market().title, slug: 'fed-cut-september-2026', yesPrice: 100, asOf: entry.deadline - DAY_MS }],
    });
    const yes = resolveHardSpec(entry, settledYes, [], entry.deadline + DAY_MS);
    assert.equal(yes.outcome, 'YES'); // settled 100 >= 50, early-settle asOf accepted

    const settledNo = shapeResolutionFeed(MARKET_SETTLEMENT_FEED, {
      records: [{ market: market().title, slug: 'fed-cut-september-2026', yesPrice: 0, asOf: entry.deadline + DAY_MS }],
    });
    const no = resolveHardSpec(entry, settledNo, [], entry.deadline + 2 * DAY_MS);
    assert.equal(no.outcome, 'NO');
  });

  it('VOIDs only after the settlement grace with no record', () => {
    const entry = marketEntry();
    const res = resolveHardSpec(entry, [], [], entry.deadline + MARKET_SETTLEMENT_MAX_LAG_MS + 1);
    assert.equal(res.outcome, 'VOID');
    assert.equal(res.evidence.reason, 'value_source_never_settled');
  });

  it('settlement identity survives a title WITHOUT a trailing question mark (review #1)', async () => {
    // Venue titles are often statements ("Fed cuts rates in September") while the
    // bet question/title gets a '?' appended — the loader-written record must
    // still match the spec end-to-end or every such bet VOIDs after grace.
    const statement = market({ title: 'Fed cuts rates in September 2026', url: 'https://polymarket.com/event/fed-statement' });
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feedFixture([statement]) }, NOW);
    const ledger = ingestHistory({}, [{ generatedAt: NOW, predictions: bets }], NOW);
    const entry = Object.values(ledger)[0];
    const writes = [];
    await updateMarketSettlements(ledger, entry.deadline + DAY_MS, {
      fetchSettlement: async () => 100,
      readJson: async () => null,
      writeJson: async (key, value) => { writes.push({ key, value }); },
    });
    const feedWrite = writes.find((w) => w.key === MARKET_SETTLEMENT_FEED);
    assert.ok(feedWrite, 'settlement feed written');
    const feed = shapeResolutionFeed(MARKET_SETTLEMENT_FEED, feedWrite.value);
    const res = resolveHardSpec(entry, feed, [], entry.deadline + DAY_MS);
    assert.equal(res.status, 'resolved');
    assert.equal(res.outcome, 'YES');
  });
});

describe('open-window merge tracks the venue endDate (review #4)', () => {
  it('advances deadline + spec.deadline when the venue moves endDate on re-ingest', () => {
    const first = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feedFixture() }, NOW);
    const ledger = ingestHistory({}, [{ generatedAt: NOW, predictions: first }], NOW);
    const movedEndDate = new Date(NOW + 30 * DAY_MS).toISOString();
    const moved = generateBets(MARKET_BET_TEMPLATES, {
      [MARKET_FEED]: feedFixture([market({ endDate: movedEndDate })], { fetchedAt: NOW + DAY_MS }),
    }, NOW + DAY_MS);
    const after = ingestHistory(ledger, [{ generatedAt: NOW + DAY_MS, predictions: moved }], NOW + DAY_MS);
    assert.equal(Object.values(after).length, 1); // merged, not duplicated
    const entry = Object.values(after)[0];
    assert.equal(entry.deadline, Date.parse(movedEndDate));
    assert.equal(entry.spec.deadline, Date.parse(movedEndDate));
  });
});

describe('settlement parsing + loader', () => {
  it('parseGammaSettlement extracts the settled YES price by title', () => {
    const events = [{
      markets: [
        { question: 'Other market?', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0.2","0.8"]' },
        { question: 'Will the Fed cut rates in September 2026?', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' },
      ],
    }];
    assert.equal(parseGammaSettlement(events, 'Will the Fed cut rates in September 2026?'), 100);
  });

  it('parseGammaSettlement returns null while the market is still open', () => {
    const events = [{ markets: [{ question: 'Q?', closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.6","0.4"]' }] }];
    assert.equal(parseGammaSettlement(events, 'Q?'), null);
  });

  it('parseKalshiSettlement maps settled results and rejects open markets', () => {
    assert.equal(parseKalshiSettlement({ market: { status: 'settled', result: 'yes' } }), 100);
    assert.equal(parseKalshiSettlement({ market: { status: 'finalized', result: 'no' } }), 0);
    assert.equal(parseKalshiSettlement({ market: { status: 'active', result: '' } }), null);
  });

  it('updateMarketSettlements fetches due unsettled slugs and appends records', async () => {
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feedFixture() }, NOW);
    const ledger = ingestHistory({}, [{ generatedAt: NOW, predictions: bets }], NOW);
    const writes = [];
    const stats = await updateMarketSettlements(ledger, Date.parse(market().endDate) + DAY_MS, {
      fetchSettlement: async () => 100,
      readJson: async () => ({ records: [] }),
      writeJson: async (key, value) => { writes.push({ key, value }); },
    });
    assert.equal(stats.settled, 1);
    const feedWrites = writes.filter((w) => w.key === MARKET_SETTLEMENT_FEED);
    assert.equal(feedWrites.length, 1);
    assert.equal(feedWrites[0].value.records[0].slug, 'fed-cut-september-2026');
    assert.equal(feedWrites[0].value.records[0].yesPrice, 100);
  });

  it('updateMarketSettlements skips already-settled slugs and non-due bets', async () => {
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feedFixture() }, NOW);
    const ledger = ingestHistory({}, [{ generatedAt: NOW, predictions: bets }], NOW);
    let fetches = 0;
    // Already settled → no fetch.
    const statsSettled = await updateMarketSettlements(ledger, Date.parse(market().endDate) + DAY_MS, {
      fetchSettlement: async () => { fetches += 1; return 100; },
      readJson: async () => ({ records: [{ slug: 'fed-cut-september-2026', yesPrice: 100 }] }),
      writeJson: async () => {},
    });
    assert.equal(statsSettled.fetched, 0);
    // Not yet due → no fetch.
    const statsNotDue = await updateMarketSettlements(ledger, NOW + DAY_MS, {
      fetchSettlement: async () => { fetches += 1; return 100; },
      readJson: async () => ({ records: [] }),
      writeJson: async () => {},
    });
    assert.deepEqual(statsNotDue, { fetched: 0, settled: 0 });
    assert.equal(fetches, 0);
  });

  it('fetch cap drains the OLDEST deadlines first — a backlog cannot starve near-grace markets (review R2 #2)', async () => {
    // 12 due markets whose alphabetical (ledger-key) order deliberately
    // disagrees with deadline order. The 10-per-run cap must take the 10
    // nearest-to-grace entries, or the two oldest could sit unfetched until
    // the 14d grace expires and VOID despite the venue having adjudicated.
    const agesDays = [3, 11, 0, 7, 5, 9, 1, 8, 2, 10, 4, 6]; // by slug order m-a…m-l
    const ledger = {};
    agesDays.forEach((age, i) => {
      const slug = `m-${String.fromCharCode(97 + i)}`;
      const deadline = NOW - age * DAY_MS;
      ledger[`market:${slug}@${deadline}`] = {
        id: `market:${slug}`,
        key: `market:${slug}@${deadline}`,
        status: 'pending',
        title: slug,
        spec: { sourceFeed: MARKET_SETTLEMENT_FEED, deadline },
        deadline,
        marketSlug: slug,
        marketSource: 'polymarket',
      };
    });
    const fetchedSlugs = [];
    const writes = [];
    const stats = await updateMarketSettlements(ledger, NOW, {
      fetchSettlement: async (entry) => { fetchedSlugs.push(entry.marketSlug); return null; }, // queued, not yet adjudicated
      readJson: async () => null,
      writeJson: async (key, value) => { writes.push({ key, value }); },
    });
    assert.equal(stats.fetched, 10);
    assert.equal(stats.settled, 0);
    // null fetches never write the FEED (the seed-meta companion still fires)
    assert.equal(writes.filter((w) => w.key === MARKET_SETTLEMENT_FEED).length, 0);
    const oldestTen = agesDays
      .map((age, i) => ({ age, slug: `m-${String.fromCharCode(97 + i)}` }))
      .sort((a, b) => b.age - a.age)
      .slice(0, 10)
      .map((x) => x.slug)
      .sort();
    assert.deepEqual([...fetchedSlugs].sort(), oldestTen);
  });

  it('fails CLOSED when the settlement feed read errors — never rebuilds from empty (review #2)', async () => {
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feedFixture() }, NOW);
    const ledger = ingestHistory({}, [{ generatedAt: NOW, predictions: bets }], NOW);
    const writes = [];
    const stats = await updateMarketSettlements(ledger, Date.parse(market().endDate) + DAY_MS, {
      fetchSettlement: async () => 100,
      readJson: async () => { throw new Error('redis blip'); },
      writeJson: async (key, value) => { writes.push({ key, value }); },
    });
    // A read failure is indistinguishable from a populated feed: writing would
    // full-document SET an empty records array and wipe prior adjudications.
    assert.deepEqual(stats, { fetched: 0, settled: 0 });
    assert.equal(writes.filter((w) => w.key === MARKET_SETTLEMENT_FEED).length, 0);
  });
});

describe('settlement loader edge paths + health meta (review #5526)', () => {
  const DUE_AT = Date.parse(market().endDate) + DAY_MS;

  function dueLedger(markets = [market()]) {
    const bets = generateBets(MARKET_BET_TEMPLATES, { [MARKET_FEED]: feedFixture(markets) }, NOW);
    return ingestHistory({}, [{ generatedAt: NOW, predictions: bets }], NOW);
  }

  it('a not-yet-adjudicated venue (null) writes no record — the bet stays pending', async () => {
    const ledger = dueLedger();
    const writes = [];
    const stats = await updateMarketSettlements(ledger, DUE_AT, {
      fetchSettlement: async () => null,
      readJson: async () => null,
      writeJson: async (key, value) => { writes.push({ key, value }); },
    });
    assert.deepEqual(stats, { fetched: 1, settled: 0 });
    assert.equal(writes.filter((w) => w.key === MARKET_SETTLEMENT_FEED).length, 0);
  });

  it('a throwing fetch skips that slug but still settles the others', async () => {
    const ledger = dueLedger([
      market({ title: 'Market A?', url: 'https://polymarket.com/event/aaa' }),
      market({ title: 'Market B?', volume: 400_000, url: 'https://polymarket.com/event/bbb' }),
    ]);
    const writes = [];
    const stats = await updateMarketSettlements(ledger, DUE_AT, {
      fetchSettlement: async (entry) => {
        if (entry.marketSlug === 'aaa') throw new Error('venue 500');
        return 0;
      },
      readJson: async () => null,
      writeJson: async (key, value) => { writes.push({ key, value }); },
    });
    assert.deepEqual(stats, { fetched: 2, settled: 1 });
    const feedWrite = writes.find((w) => w.key === MARKET_SETTLEMENT_FEED);
    assert.equal(feedWrite.value.records.length, 1);
    assert.equal(feedWrite.value.records[0].slug, 'bbb');
    assert.equal(feedWrite.value.records[0].yesPrice, 0);
  });

  it('two due entries sharing a marketSlug fetch and record once per run', async () => {
    const base = dueLedger();
    const entry = Object.values(base)[0];
    // A venue-moved endDate can mint a second id@deadline window for the same
    // slug; both are due in the same run. The loader must fetch/record once.
    const ledger = {
      ...base,
      'market:fed-cut-september-2026@9999999999999': {
        ...entry,
        key: 'market:fed-cut-september-2026@9999999999999',
        deadline: entry.deadline + DAY_MS,
      },
    };
    let fetches = 0;
    const writes = [];
    const stats = await updateMarketSettlements(ledger, entry.deadline + 2 * DAY_MS, {
      fetchSettlement: async () => { fetches += 1; return 100; },
      readJson: async () => null,
      writeJson: async (key, value) => { writes.push({ key, value }); },
    });
    assert.deepEqual(stats, { fetched: 1, settled: 1 });
    assert.equal(fetches, 1);
    const feedWrite = writes.find((w) => w.key === MARKET_SETTLEMENT_FEED);
    assert.equal(feedWrite.value.records.length, 1);
  });

  it('writes a seed-meta companion on every run — even with nothing due', async () => {
    const ledger = dueLedger();
    const writes = [];
    const stats = await updateMarketSettlements(ledger, NOW, { // NOW < deadline → nothing due
      fetchSettlement: async () => 100,
      readJson: async () => null,
      writeJson: async (key, value) => { writes.push({ key, value }); },
    });
    assert.deepEqual(stats, { fetched: 0, settled: 0 });
    const meta = writes.find((w) => w.key === 'seed-meta:prediction:markets-resolution');
    assert.ok(meta, 'seed-meta written even with zero due bets');
    assert.equal(meta.value.fetchedAt, NOW);
    assert.equal(meta.value.settled, 0);
  });
});

describe('settlement ambiguity guard (Greptile #5526)', () => {
  it('returns null for a multi-market event whose children do not title-match', () => {
    const events = [{
      markets: [
        { question: 'Will there be a 25bp cut?', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' },
        { question: 'Will there be a 50bp cut?', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0","1"]' },
      ],
    }];
    // The saved bet title matches neither child — settling on "first closed"
    // would grade with another market's outcome. Must stay pending (null).
    assert.equal(parseGammaSettlement(events, 'Will there be no change in Fed rates?'), null);
  });

  it('title-matches across the appended question mark (review #1)', () => {
    // The bet title is normalizeQuestion(venue title) — '?' appended when the
    // venue used a statement. Disambiguation must tolerate that transform, or a
    // multi-market event never matches and the bet VOIDs.
    const events = [{
      markets: [
        { question: 'Fed cuts rates in September 2026', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' },
        { question: 'Fed raises rates in September 2026', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0","1"]' },
      ],
    }];
    assert.equal(parseGammaSettlement(events, 'Fed cuts rates in September 2026?'), 100);
  });

  it('still settles a single-market event when the title drifted', () => {
    const events = [{
      markets: [
        { question: 'Will X happen? (updated wording)', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0","1"]' },
      ],
    }];
    assert.equal(parseGammaSettlement(events, 'Will X happen?'), 0); // only one candidate → unambiguous
  });
});
