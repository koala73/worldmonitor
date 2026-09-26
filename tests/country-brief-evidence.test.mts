import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it, type TestContext } from 'node:test';

import {
  buildCountryBriefEvidence,
  COUNTRY_BRIEF_ADVISORY_LABELS,
  EVIDENCE_MAX_AGE_MS,
  FORECAST_SCORECARD_URL,
  RESILIENCE_DIMENSION_LABELS,
  chokepointTrackerSlug,
  type CountryBriefEvidenceItem,
} from '../server/worldmonitor/intelligence/v1/_country-brief-evidence.ts';
import type { ResolvedEnergyImportDependency } from '../server/worldmonitor/intelligence/v1/_energy-import-dependency.ts';
import { UNAVAILABLE_ENERGY_IMPORT_DEPENDENCY } from '../server/worldmonitor/intelligence/v1/_energy-import-dependency.ts';
import { CII_RISK_SCORE_CACHE_KEYS } from '../server/_shared/cache-keys.ts';
import { RESILIENCE_SCORE_CACHE_PREFIX } from '../server/worldmonitor/resilience/v1/_shared.ts';
import { CHOKEPOINT_REGISTRY } from '../server/_shared/chokepoint-registry.ts';
import { instabilityBand, CII_SCORE_BANDS } from '../shared/cii-band.js';
import { CHOKEPOINT_COUNTRY_CODES } from '../shared/chokepoint-countries.js';
import {
  formatAdvisory,
  instabilityBand as liveToolsInstabilityBand,
} from '../scripts/crawlable-live-tools.mjs';
import { CHOKEPOINT_CONTENT } from '../scripts/chokepoint-page-content.mjs';
import { slugify } from '../scripts/build-crawlable-corpus.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Sep 21, 2026 12:00 UTC.
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

const ADVISORIES_KEY = 'intelligence:advisories:v1';
const SANCTIONS_KEY = 'sanctions:country-counts:v1';
const SANCTIONS_META_KEY = 'seed-meta:sanctions:country-counts';
const MARKETS_KEY = 'prediction:markets-country-index:v1';
const FORECASTS_KEY = 'forecast:predictions-bootstrap:v1';
const RESILIENCE_KEY_IR = `${RESILIENCE_SCORE_CACHE_PREFIX}IR`;

// A CII component value that must never leak into a public evidence item.
const CII_COMPONENT_SENTINEL = 13.37;

function ciiScore(region: string, combinedScore: number, computedAt = NOW - 30 * 60 * 1000) {
  return {
    region,
    staticBaseline: 40,
    dynamicScore: 55,
    combinedScore,
    trend: 'TREND_DIRECTION_RISING',
    components: {
      newsActivity: CII_COMPONENT_SENTINEL,
      ciiContribution: CII_COMPONENT_SENTINEL,
      geoConvergence: CII_COMPONENT_SENTINEL,
      militaryActivity: CII_COMPONENT_SENTINEL,
    },
    computedAt,
    methodologyVersion: 'v8',
    eventMultiplier: 1.2,
    advisoryLevel: 'do-not-travel',
    advisoryProvenance: 'state',
  };
}

function fullFixtures(): Record<string, unknown> {
  return {
    [CII_RISK_SCORE_CACHE_KEYS.stale]: {
      ciiScores: [ciiScore('US', 30), ciiScore('IR', 72.46)],
    },
    [ADVISORIES_KEY]: {
      byCountry: { IR: 'do-not-travel', EG: 'reconsider' },
      byCountryName: { IR: 'Iran' },
      advisories: [],
      fetchedAt: new Date(NOW - HOUR).toISOString(),
    },
    [SANCTIONS_KEY]: { IR: 1234, EG: 12 },
    [SANCTIONS_META_KEY]: { fetchedAt: NOW - 3 * HOUR, recordCount: 2 },
    [RESILIENCE_KEY_IR]: {
      countryCode: 'IR',
      overallScore: 38.2,
      level: 'low',
      headlineEligible: true,
      dataVersion: '2026-09-20',
      domains: [
        {
          id: 'economic',
          score: 30,
          weight: 0.2,
          dimensions: [
            { id: 'macroFiscal', score: 22.5, coverage: 0.8, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
            // Lowest score of all, but withheld: no reading, never "weakest".
            { id: 'currencyExternal', score: 2, coverage: 0, observedWeight: 0, imputedWeight: 1, imputationClass: 'source-failure' },
            { id: 'tradePolicy', score: 30.04, coverage: 0.6, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
          ],
        },
        {
          id: 'governance',
          score: 25,
          weight: 0.2,
          dimensions: [
            { id: 'energy', score: 3, coverage: 0.5, observedWeight: 0, imputedWeight: 1, imputationClass: 'not-applicable' },
            { id: 'borderSecurity', score: 4, coverage: 0.9, observedWeight: 0, imputedWeight: 1, imputationClass: 'stable-absence' },
            { id: 'governanceInstitutional', score: 18, coverage: 1, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
            { id: 'socialCohesion', score: 40, coverage: 1, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
            // Retired dimension: the corpus never shows it.
            { id: 'fuelStockDays', score: 1, coverage: 1, observedWeight: 1, imputedWeight: 0, imputationClass: '' },
          ],
        },
      ],
    },
    [MARKETS_KEY]: {
      fetchedAt: NOW - 20 * 60 * 1000,
      countries: {
        IR: [
          {
            title: 'Will Iran and the US\nsign a nuclear deal by December 31?',
            yesPrice: 23.4,
            volume: 1_000_000,
            url: 'https://polymarket.com/event/iran-deal',
            endDate: '2026-12-31T00:00:00Z',
            source: 'polymarket',
          },
          {
            title: 'Iran strike before October?',
            yesPrice: 7.6,
            volume: 5000,
            url: 'javascript:alert(1)',
            endDate: '2026-10-01T00:00:00Z',
            source: 'kalshi',
          },
          {
            title: 'Iran referendum by September 1?',
            yesPrice: 50,
            volume: 900,
            url: 'https://kalshi.com/markets/expired',
            endDate: '2026-09-01T00:00:00Z',
            source: 'kalshi',
          },
        ],
      },
    },
    [FORECASTS_KEY]: {
      generatedAt: NOW - 2 * HOUR,
      predictions: [
        {
          id: 'fc-iran-talks',
          title: 'Iran nuclear talks resume',
          region: 'Americas',
          probability: 0.62,
          resolution: { kind: 'judged', deadline: Date.UTC(2026, 9, 31) },
        },
        { id: 'fc-null', title: 'Iran escalation in the Gulf', region: 'Middle East', probability: 0.4, resolution: null },
        { id: 'fc-nan', title: 'Iran oil exports fall', region: 'Middle East', probability: 0.4, resolution: { kind: 'judged', deadline: 'soon' } },
        { id: 'fc-past', title: 'Iran sanctions eased', region: 'Middle East', probability: 0.3, resolution: { kind: 'judged', deadline: NOW - DAY } },
        { id: 'fc-brazil', title: 'Brazil election result contested', region: 'Americas', probability: 0.2, resolution: { kind: 'judged', deadline: Date.UTC(2026, 10, 30) } },
      ],
    },
  };
}

const IRAN_ENERGY: ResolvedEnergyImportDependency = { available: true, value: -45.6, year: 2023, source: 'IEA' };

const originalEnv = { ...process.env };
before(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
  delete process.env.LOCAL_API_MODE;
  delete process.env.VERCEL_ENV;
});
after(() => { process.env = originalEnv; });

function mockRedis(t: TestContext, store: Record<string, unknown>) {
  const reads: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const match = /\/get\/(.+)$/.exec(url);
    if (!match) return new Response('', { status: 404 });
    const key = decodeURIComponent(match[1]!);
    reads.push(key);
    const value = store[key];
    return Response.json({ result: value === undefined || value === null ? null : JSON.stringify(value) });
  });
  return reads;
}

async function build(t: TestContext, store: Record<string, unknown>, cc = 'IR', energy = IRAN_ENERGY) {
  mockRedis(t, store);
  return buildCountryBriefEvidence(cc, { energyImportDependency: energy, nowMs: NOW });
}

function byKind(items: CountryBriefEvidenceItem[], kind: CountryBriefEvidenceItem['kind']) {
  return items.filter((item) => item.kind === kind);
}

const EXPECTED_IRAN: CountryBriefEvidenceItem[] = [
  {
    id: 'E1',
    kind: 'cii',
    label: 'Country Instability Index',
    value: '72.5 of 100 (High)',
    factText: 'Iran has a Country Instability Index score of 72.5 of 100, in the High band, as of Sep 21, 2026.',
    asOf: new Date(NOW - 30 * 60 * 1000).toISOString(),
  },
  {
    id: 'E2',
    kind: 'advisory',
    label: 'Travel advisory',
    value: 'Do Not Travel',
    factText: 'The most severe government travel advisory World Monitor tracks for Iran is Do Not Travel, as of Sep 21, 2026.',
    asOf: new Date(NOW - HOUR).toISOString(),
  },
  {
    id: 'E3',
    kind: 'sanctions',
    label: 'US OFAC and Canada SEMA designations',
    value: '1,234',
    factText: 'Iran is linked to 1,234 US OFAC and Canada SEMA sanctions designations, as of Sep 21, 2026.',
    asOf: new Date(NOW - 3 * HOUR).toISOString(),
  },
  {
    id: 'E4',
    kind: 'resilience',
    label: 'Country Resilience Index',
    value: '38.2 of 100 (low)',
    factText: 'Iran has a Country Resilience Index score of 38.2 of 100, a low resilience level, as of Sep 20, 2026.',
    asOf: '2026-09-20T00:00:00.000Z',
  },
  {
    id: 'E5',
    kind: 'resilience-dimension',
    label: 'Governance and institutions',
    value: '18 of 100',
    factText: "Governance and institutions is one of Iran's weakest observed Country Resilience Index dimensions, at 18 of 100 as of Sep 20, 2026.",
    asOf: '2026-09-20T00:00:00.000Z',
  },
  {
    id: 'E6',
    kind: 'resilience-dimension',
    label: 'Macro-fiscal position',
    value: '22.5 of 100',
    factText: "Macro-fiscal position is one of Iran's weakest observed Country Resilience Index dimensions, at 22.5 of 100 as of Sep 20, 2026.",
    asOf: '2026-09-20T00:00:00.000Z',
  },
  {
    id: 'E7',
    kind: 'resilience-dimension',
    label: 'Trade policy resilience',
    value: '30 of 100',
    factText: "Trade policy resilience is one of Iran's weakest observed Country Resilience Index dimensions, at 30 of 100 as of Sep 20, 2026.",
    asOf: '2026-09-20T00:00:00.000Z',
  },
  {
    id: 'E8',
    kind: 'energy',
    label: 'Net energy import dependency',
    value: '-46%',
    factText: 'Iran has a net energy import dependency of -46% (IEA, 2023); a negative value means Iran is a net energy exporter.',
    asOf: '2023-12-31T00:00:00.000Z',
  },
  {
    id: 'E9',
    kind: 'chokepoint',
    label: 'Chokepoint tracker',
    value: 'Strait of Hormuz',
    factText: 'Strait of Hormuz is a shipping chokepoint World Monitor tracks for Iran.',
    asOf: new Date(NOW).toISOString(),
    url: 'https://www.worldmonitor.app/chokepoints/strait-of-hormuz/',
  },
  {
    id: 'E10',
    kind: 'market',
    label: 'Polymarket prediction market',
    value: '23%',
    factText: 'A Polymarket market related to Iran, "Will Iran and the US sign a nuclear deal by December 31?", priced Yes at 23% on Sep 21, 2026; it closes Dec 31, 2026.',
    asOf: new Date(NOW - 20 * 60 * 1000).toISOString(),
    url: 'https://polymarket.com/event/iran-deal',
  },
  {
    id: 'E11',
    kind: 'market',
    label: 'Kalshi prediction market',
    value: '8%',
    factText: 'A Kalshi market related to Iran, "Iran strike before October?", priced Yes at 8% on Sep 21, 2026; it closes Oct 1, 2026.',
    asOf: new Date(NOW - 20 * 60 * 1000).toISOString(),
  },
  {
    id: 'E12',
    kind: 'forecast',
    label: 'World Monitor forecast',
    value: '62%',
    factText: 'A World Monitor forecast related to Iran, "Iran nuclear talks resume", gives a 62% probability by Oct 31, 2026, as of Sep 21, 2026.',
    asOf: new Date(NOW - 2 * HOUR).toISOString(),
    url: 'https://www.worldmonitor.app/accuracy/',
  },
];

describe('buildCountryBriefEvidence (U2)', () => {
  it('builds the expected items, fact texts and ids from full fixtures', async (t) => {
    const items = await build(t, fullFixtures());
    assert.deepEqual(items, EXPECTED_IRAN);
  });

  it('is deterministic: the same data yields the same ids', async (t) => {
    const first = await build(t, fullFixtures());
    const second = await buildCountryBriefEvidence('ir', { energyImportDependency: IRAN_ENERGY, nowMs: NOW });
    assert.deepEqual(second, first);
  });

  it('a missing sanctions key omits only the sanctions item', async (t) => {
    const store = fullFixtures();
    delete store[SANCTIONS_KEY];
    const items = await build(t, store);
    assert.deepEqual(items.map((item) => item.kind), EXPECTED_IRAN.filter((item) => item.kind !== 'sanctions').map((item) => item.kind));
    // Ids stay dense and ordered after an omission.
    assert.deepEqual(items.map((item) => item.id), items.map((_, index) => `E${index + 1}`));
  });

  it('a sanctions count without its seed-meta timestamp is undated and omitted', async (t) => {
    const store = fullFixtures();
    delete store[SANCTIONS_META_KEY];
    assert.equal(byKind(await build(t, store), 'sanctions').length, 0);
  });

  it('a malformed source drops only that source', async (t) => {
    const store = fullFixtures();
    store[CII_RISK_SCORE_CACHE_KEYS.stale] = { ciiScores: 'broken' };
    store[ADVISORIES_KEY] = ['not', 'an', 'object'];
    store[MARKETS_KEY] = { countries: { IR: 'nope' }, fetchedAt: NOW };
    const items = await build(t, store);
    assert.deepEqual(
      [...new Set(items.map((item) => item.kind))],
      ['sanctions', 'resilience', 'resilience-dimension', 'energy', 'chokepoint', 'forecast'],
    );
  });

  it('a Redis failure on one key drops only that source', async (t) => {
    const store = fullFixtures();
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const key = decodeURIComponent(String(input).split('/get/')[1] ?? '');
      if (key === ADVISORIES_KEY) return new Response('', { status: 503 });
      const value = store[key];
      return Response.json({ result: value === undefined ? null : JSON.stringify(value) });
    });
    const items = await buildCountryBriefEvidence('IR', { energyImportDependency: IRAN_ENERGY, nowMs: NOW });
    assert.equal(byKind(items, 'advisory').length, 0);
    assert.equal(byKind(items, 'cii').length, 1);
  });

  it('never picks an unavailable, imputed, not-applicable or retired dimension as weakest', async (t) => {
    const items = byKind(await build(t, fullFixtures()), 'resilience-dimension');
    const labels = items.map((item) => item.label);
    for (const excluded of ['Currency and external balance', 'Energy system resilience', 'Border security', 'Fuel-stock buffer']) {
      assert.ok(!labels.includes(excluded), `${excluded} must not be chosen as weakest`);
    }
    assert.equal(items.length, 3);
  });

  it('keeps the dimension items but drops the overall score when the headline is unpublished', async (t) => {
    const store = fullFixtures();
    (store[RESILIENCE_KEY_IR] as { headlineEligible: boolean }).headlineEligible = false;
    const items = await build(t, store);
    assert.equal(byKind(items, 'resilience').length, 0);
    assert.equal(byKind(items, 'resilience-dimension').length, 3);
  });

  it('omits a CII score older than its cutoff', async (t) => {
    const store = fullFixtures();
    store[CII_RISK_SCORE_CACHE_KEYS.stale] = {
      ciiScores: [ciiScore('IR', 72.46, NOW - EVIDENCE_MAX_AGE_MS.cii - 1)],
    };
    assert.equal(byKind(await build(t, store), 'cii').length, 0);
  });

  it('omits stale advisories, sanctions, resilience, markets and forecasts past their cutoffs', async (t) => {
    const store = fullFixtures();
    (store[ADVISORIES_KEY] as { fetchedAt: string }).fetchedAt = new Date(NOW - EVIDENCE_MAX_AGE_MS.advisory - 1).toISOString();
    (store[SANCTIONS_META_KEY] as { fetchedAt: number }).fetchedAt = NOW - EVIDENCE_MAX_AGE_MS.sanctions - 1;
    (store[RESILIENCE_KEY_IR] as { dataVersion: string }).dataVersion = '2026-09-01';
    (store[MARKETS_KEY] as { fetchedAt: number }).fetchedAt = NOW - EVIDENCE_MAX_AGE_MS.market - 1;
    (store[FORECASTS_KEY] as { generatedAt: number }).generatedAt = NOW - EVIDENCE_MAX_AGE_MS.forecast - 1;
    const kinds = (await build(t, store)).map((item) => item.kind);
    assert.deepEqual(kinds, ['cii', 'energy', 'chokepoint']);
  });

  it('builds the CII item from the stale key when the live key is absent', async (t) => {
    const store = fullFixtures();
    assert.equal(store[CII_RISK_SCORE_CACHE_KEYS.live], undefined);
    const reads = mockRedis(t, store);
    const items = await buildCountryBriefEvidence('IR', { energyImportDependency: IRAN_ENERGY, nowMs: NOW });
    assert.equal(byKind(items, 'cii').length, 1);
    assert.ok(reads.includes(CII_RISK_SCORE_CACHE_KEYS.stale));
  });

  it('bands match instabilityBand (and the live-tools page) at the boundary scores', async (t) => {
    for (const score of [0, 30, 30.9, 31, 50, 51, 65, 66, 80, 81, 100]) {
      const store = fullFixtures();
      store[CII_RISK_SCORE_CACHE_KEYS.stale] = { ciiScores: [ciiScore('IR', score)] };
      mockRedis(t, store);
      const [cii] = byKind(await buildCountryBriefEvidence('IR', { energyImportDependency: IRAN_ENERGY, nowMs: NOW }), 'cii');
      const band = instabilityBand(score);
      assert.ok(band, `band for ${score}`);
      assert.equal(band, liveToolsInstabilityBand(score), `shared band matches the page band at ${score}`);
      assert.ok(cii!.value.endsWith(`(${band})`), `${cii!.value} carries ${band}`);
      assert.ok(cii!.factText.includes(`in the ${band} band`));
    }
  });

  it('shared CII bands are the live-tools page bands for every score', () => {
    for (let tenths = -10; tenths <= 1010; tenths += 1) {
      const score = tenths / 10;
      assert.equal(instabilityBand(score), liveToolsInstabilityBand(score), `score ${score}`);
    }
    for (const invalid of [null, undefined, Number.NaN, Infinity, '50', {}]) {
      assert.equal(instabilityBand(invalid), liveToolsInstabilityBand(invalid));
    }
    assert.deepEqual(CII_SCORE_BANDS.map((band) => band.label), ['Critical', 'High', 'Elevated', 'Normal', 'Low']);
  });

  it('no item carries a chokepoint exposure score or a CII component value', async (t) => {
    const serialized = JSON.stringify(await build(t, fullFixtures()));
    assert.doesNotMatch(serialized, /exposure/i);
    assert.ok(!serialized.includes(String(CII_COMPONENT_SENTINEL)));
    assert.ok(!serialized.includes('13.4'));
  });

  it('the sanctions label names both OFAC and SEMA', async (t) => {
    const [sanctions] = byKind(await build(t, fullFixtures()), 'sanctions');
    assert.match(sanctions!.label, /OFAC/);
    assert.match(sanctions!.label, /SEMA/);
    assert.match(sanctions!.factText, /US OFAC and Canada SEMA/);
  });

  it('every fact text contains the country display name', async (t) => {
    const items = await build(t, fullFixtures());
    assert.ok(items.length > 0);
    for (const item of items) assert.ok(item.factText.includes('Iran'), item.factText);
  });

  it('uses the handler display name (TIER1 first, then ISO display name)', async (t) => {
    const store = fullFixtures();
    store[CII_RISK_SCORE_CACHE_KEYS.stale] = { ciiScores: [ciiScore('EG', 40)] };
    const items = await build(t, store, 'EG', UNAVAILABLE_ENERGY_IMPORT_DEPENDENCY);
    assert.ok(items.length >= 3);
    for (const item of items) assert.ok(item.factText.includes('Egypt'), item.factText);
    assert.deepEqual(byKind(items, 'chokepoint').map((item) => item.value), ['Suez Canal']);
  });

  it('formats a positive energy dependency without the exporter clause, and skips unavailable energy', async (t) => {
    const importer = await build(t, fullFixtures(), 'IR', { available: true, value: 61.6, year: 2022, source: '' });
    const [energy] = byKind(importer, 'energy');
    assert.equal(energy!.factText, 'Iran has a net energy import dependency of 62% (2022).');
    const none = await buildCountryBriefEvidence('IR', { energyImportDependency: UNAVAILABLE_ENERGY_IMPORT_DEPENDENCY, nowMs: NOW });
    assert.equal(byKind(none, 'energy').length, 0);
  });

  it('an unknown advisory token is omitted rather than humanized', async (t) => {
    const store = fullFixtures();
    (store[ADVISORIES_KEY] as { byCountry: Record<string, string> }).byCountry.IR = 'level-9';
    assert.equal(byKind(await build(t, store), 'advisory').length, 0);
  });
});

describe('buildCountryBriefEvidence forward evidence (U3)', () => {
  it('2 live markets give 2 market items with whole-percent prices; the expired one is skipped', async (t) => {
    const markets = byKind(await build(t, fullFixtures()), 'market');
    assert.deepEqual(markets.map((item) => item.value), ['23%', '8%']);
    assert.ok(!markets.some((item) => item.factText.includes('referendum')));
  });

  it('a market title with a newline yields a single-line fact text, and a javascript: url is dropped', async (t) => {
    const markets = byKind(await build(t, fullFixtures()), 'market');
    for (const item of markets) assert.doesNotMatch(item.factText, /[\r\n]/);
    const kalshi = markets.find((item) => item.label.startsWith('Kalshi'));
    assert.equal(kalshi!.url, undefined);
    assert.ok(!('url' in kalshi!));
  });

  it('clips an overlong market title and keeps it single-line', async (t) => {
    const store = fullFixtures();
    const long = `Iran ${'very '.repeat(80)}long title`;
    (store[MARKETS_KEY] as { countries: Record<string, Array<{ title: string }>> }).countries.IR![0]!.title = long;
    const [first] = byKind(await build(t, store), 'market');
    const quoted = /"([^"]*)"/.exec(first!.factText)![1]!;
    assert.ok(quoted.length <= 160, `clipped to ${quoted.length}`);
    assert.ok(quoted.endsWith('…'));
  });

  it('skips a market with an unknown venue or no parseable close date', async (t) => {
    const store = fullFixtures();
    const list = (store[MARKETS_KEY] as { countries: Record<string, Array<Record<string, unknown>>> }).countries.IR!;
    list[0]!.source = 'unknown-venue';
    delete list[1]!.endDate;
    assert.equal(byKind(await build(t, store), 'market').length, 0);
  });

  it('a forecast titled with Iran but regioned "Americas" matches IR and not US', async (t) => {
    const store = fullFixtures();
    const iran = byKind(await build(t, store), 'forecast');
    assert.deepEqual(iran.map((item) => item.value), ['62%']);
    assert.match(iran[0]!.factText, /Iran nuclear talks resume/);
    assert.equal(iran[0]!.url, FORECAST_SCORECARD_URL);

    store[CII_RISK_SCORE_CACHE_KEYS.stale] = { ciiScores: [ciiScore('US', 30)] };
    const us = byKind(await build(t, store, 'US', UNAVAILABLE_ENERGY_IMPORT_DEPENDENCY), 'forecast');
    assert.deepEqual(us, []);
  });

  it('skips forecasts with resolution null, a non-finite deadline, or a past deadline', async (t) => {
    const forecasts = byKind(await build(t, fullFixtures()), 'forecast');
    const text = forecasts.map((item) => item.factText).join('\n');
    assert.doesNotMatch(text, /escalation in the Gulf/);
    assert.doesNotMatch(text, /oil exports fall/);
    assert.doesNotMatch(text, /sanctions eased/);
  });

  it('a country with neither markets nor forecasts gets no forward items', async (t) => {
    const store = fullFixtures();
    store[CII_RISK_SCORE_CACHE_KEYS.stale] = { ciiScores: [ciiScore('EG', 40)] };
    const items = await build(t, store, 'EG', UNAVAILABLE_ENERGY_IMPORT_DEPENDENCY);
    assert.equal(items.filter((item) => item.kind === 'market' || item.kind === 'forecast').length, 0);
  });
});

describe('mirrors of public page vocabulary stay in sync', () => {
  it('advisory labels match the live-tools page formatter', () => {
    for (const [token, label] of Object.entries(COUNTRY_BRIEF_ADVISORY_LABELS)) {
      assert.equal(label, formatAdvisory(token), token);
    }
  });

  it('dimension labels match the corpus DIMENSION_LABELS table', () => {
    const source = readFileSync(new URL('../scripts/build-crawlable-corpus.mjs', import.meta.url), 'utf8');
    const block = /const DIMENSION_LABELS = \{([\s\S]*?)\n\};/.exec(source)?.[1];
    assert.ok(block, 'corpus DIMENSION_LABELS block found');
    const corpus = Object.fromEntries(
      [...block!.matchAll(/^\s*([A-Za-z]+): '([^']+)',$/gm)].map((match) => [match[1], match[2]]),
    );
    assert.ok(Object.keys(corpus).length >= 20);
    assert.deepEqual(RESILIENCE_DIMENSION_LABELS, corpus);
  });

  it('chokepoint tracker slugs match the corpus slugify for every registry entry', () => {
    for (const entry of CHOKEPOINT_REGISTRY) {
      assert.equal(chokepointTrackerSlug(entry.displayName), slugify(entry.displayName), entry.id);
    }
  });

  it('the shared chokepoint relation is the one the chokepoint pages publish', () => {
    const fromPages = Object.fromEntries(
      Object.entries(CHOKEPOINT_CONTENT).map(([id, content]) => [id, [...(content as { countryCodes: string[] }).countryCodes]]),
    );
    const fromShared = Object.fromEntries(Object.entries(CHOKEPOINT_COUNTRY_CODES).map(([id, codes]) => [id, [...codes]]));
    assert.deepEqual(fromShared, fromPages);
    for (const id of Object.keys(CHOKEPOINT_COUNTRY_CODES)) {
      assert.ok(CHOKEPOINT_REGISTRY.some((entry) => entry.id === id), `${id} is a registry chokepoint`);
    }
  });
});
