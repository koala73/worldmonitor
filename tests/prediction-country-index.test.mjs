import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCountryMarketIndex,
} from '../scripts/_prediction-country-index.mjs';

const NOW = Date.parse('2026-08-31T00:00:00Z');

function market(title, source, volume, options = {}) {
  return {
    title,
    source,
    volume,
    yesPrice: 50,
    url: `https://example.test/${encodeURIComponent(title)}`,
    endDate: '2027-08-31T00:00:00Z',
    eventKey: `${source}:${title}`,
    ...options,
  };
}

describe('buildCountryMarketIndex', () => {
  it('selects country markets before the global top-25 pool cap', () => {
    const globallyPopular = Array.from({ length: 30 }, (_, index) => (
      market(`Will Iran event ${index} happen?`, 'polymarket', 10_000_000 - index)
    ));
    const usMarket = market('Will United States GDP grow in 2027?', 'kalshi', 6_000);

    const index = buildCountryMarketIndex([...globallyPopular, usMarket], { now: NOW });

    assert.deepEqual(index.US.map((entry) => entry.title), [usMarket.title]);
  });

  it('uses curated country terms and does not treat the word us as the United States', () => {
    const lastOfUs = market('Will The Last of Us win best drama?', 'polymarket', 1_000_000);
    const trump = market('Will Trump sign the tariff bill in 2027?', 'kalshi', 25_000);

    const index = buildCountryMarketIndex([lastOfUs, trump], { now: NOW });

    assert.deepEqual(index.US.map((entry) => entry.title), [trump.title]);
  });

  it('ranks nearer contracts ahead of equally relevant 2045 contracts', () => {
    const distant = market(
      'Will Nick Fuentes become President of the United States before 2045?',
      'kalshi',
      500_000,
      { endDate: '2045-01-08T19:00:00Z' },
    );
    const near = market(
      'Will United States GDP grow in 2027?',
      'kalshi',
      20_000,
      { endDate: '2027-12-31T00:00:00Z' },
    );

    const index = buildCountryMarketIndex([distant, near], { now: NOW });

    assert.deepEqual(index.US.map((entry) => entry.title), [near.title, distant.title]);
  });

  it('keeps both providers when both have eligible country contracts', () => {
    const markets = [
      ...Array.from({ length: 6 }, (_, index) => market(
        `Will United States policy ${index} change?`,
        'polymarket',
        1_000_000 - index,
      )),
      market('Will Trump nominate the next Fed chair?', 'kalshi', 6_000),
    ];

    const index = buildCountryMarketIndex(markets, { now: NOW, limit: 5 });

    assert.equal(index.US.length, 5);
    assert.deepEqual(new Set(index.US.map((entry) => entry.source)), new Set(['polymarket', 'kalshi']));
  });

  it('publishes at most one contract from the same event for a country', () => {
    const sameEvent = [
      market('Will a United States candidate win?: Candidate A', 'kalshi', 20_000, { eventKey: 'kalshi:event-1' }),
      market('Will a United States candidate win?: Candidate B', 'kalshi', 30_000, { eventKey: 'kalshi:event-1' }),
    ];

    const index = buildCountryMarketIndex(sameEvent, { now: NOW });

    assert.equal(index.US.length, 1);
    assert.equal(index.US[0].title, sameEvent[1].title);
  });
});
