import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCountryMarketIndex,
  countCountryMarkets,
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
  it('counts only published country-market arrays', () => {
    assert.equal(countCountryMarkets({ US: [{}, {}], CN: [{}], invalid: null }), 3);
    assert.equal(countCountryMarkets(undefined), 0);
  });

  it('selects country markets before the global top-25 pool cap', () => {
    const globallyPopular = Array.from({ length: 30 }, (_, index) => (
      market(`Will Iran event ${index} happen?`, 'polymarket', 10_000_000 - index)
    ));
    const usMarket = market('Will United States GDP grow in 2027?', 'kalshi', 6_000);

    const index = buildCountryMarketIndex([...globallyPopular, usMarket], { now: NOW });

    assert.deepEqual(index.US.map((entry) => entry.title), [usMarket.title]);
  });

  it('uses precise country terms and rejects ambiguous United States aliases', () => {
    const lastOfUs = market('Will The Last of Us win best drama?', 'polymarket', 1_000_000);
    const southAmerica = market('Will South America grow faster in 2027?', 'polymarket', 500_000);
    const trump = market('Will Trump sign the tariff bill in 2027?', 'kalshi', 25_000);

    const index = buildCountryMarketIndex([lastOfUs, southAmerica, trump], { now: NOW });

    assert.deepEqual(index.US.map((entry) => entry.title), [trump.title]);
  });

  it('ranks a nearer country alias ahead of an exact-name 2045 contract', () => {
    const distant = market(
      'Will Nick Fuentes become President of the United States before 2045?',
      'kalshi',
      500_000,
      { endDate: '2045-01-08T19:00:00Z' },
    );
    const near = market(
      'Will the Fed cut rates in 2027?',
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

  it('keeps overlapping country names on the most specific country only', () => {
    const drCongo = market('Will Democratic Republic of the Congo hold an election?', 'polymarket', 50_000);
    const southSudan = market('Will South Sudan reach a peace agreement?', 'kalshi', 40_000);
    const equatorialGuinea = market('Will Equatorial Guinea increase oil output?', 'polymarket', 30_000);

    const index = buildCountryMarketIndex([drCongo, southSudan, equatorialGuinea], { now: NOW });

    assert.deepEqual(index.CD.map((entry) => entry.title), [drCongo.title]);
    assert.equal(index.CG, undefined);
    assert.deepEqual(index.SS.map((entry) => entry.title), [southSudan.title]);
    assert.equal(index.SD, undefined);
    assert.deepEqual(index.GQ.map((entry) => entry.title), [equatorialGuinea.title]);
    assert.equal(index.GN, undefined);

    const kinshasa = market('Will Kinshasa, Congo hold a local election?', 'kalshi', 20_000);
    const contextIndex = buildCountryMarketIndex([kinshasa], { now: NOW });
    assert.deepEqual(contextIndex.CD.map((entry) => entry.title), [kinshasa.title]);
    assert.equal(contextIndex.CG, undefined);
  });

  it('requires country context before assigning a Georgia market', () => {
    const usState = market('Will Georgia voters approve the ballot measure?', 'kalshi', 90_000);
    const country = market('Will Georgian Dream win the Tbilisi election?', 'polymarket', 30_000);

    const index = buildCountryMarketIndex([usState, country], { now: NOW });

    assert.deepEqual(index.GE.map((entry) => entry.title), [country.title]);
  });

  it('requires country context before assigning bare Jordan or Chad names', () => {
    const jordanPerson = market('Will Jordan Bardella win the election?', 'kalshi', 90_000);
    const chadPerson = market('Will Chad Bianco become governor?', 'polymarket', 80_000);
    const jordanian = market('Will Jordanian GDP grow in 2027?', 'kalshi', 40_000);
    const amman = market('Will Amman host the summit?', 'polymarket', 35_000);
    const chadian = market('Will Chadian forces hold the border?', 'kalshi', 30_000);
    const nDjamena = market("Will N'Djamena hold a local election?", 'polymarket', 25_000);

    const personOnly = buildCountryMarketIndex([jordanPerson, chadPerson], { now: NOW });
    assert.equal(personOnly.JO, undefined);
    assert.equal(personOnly.TD, undefined);

    const index = buildCountryMarketIndex(
      [jordanPerson, chadPerson, jordanian, amman, chadian, nDjamena],
      { now: NOW },
    );

    assert.deepEqual(index.JO.map((entry) => entry.title), [jordanian.title, amman.title]);
    assert.deepEqual(index.TD.map((entry) => entry.title), [chadian.title, nDjamena.title]);
  });
});
