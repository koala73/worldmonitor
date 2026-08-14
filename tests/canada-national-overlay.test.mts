import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyCanadaNationalOverlay,
  canadaStatcanSourceKey,
  RESILIENCE_BOC_VALET_KEY,
  RESILIENCE_STATCAN_WDS_KEY,
  STATCAN_SCORE_PROVIDER,
} from '../server/worldmonitor/resilience/v1/_canada-national-overlay.ts';
import { classifyDimensionFreshness } from '../server/worldmonitor/resilience/v1/_dimension-freshness.ts';
import {
  scoreAllDimensions,
  scoreCurrencyExternal,
  scoreMacroFiscal,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { fixtureReader } from './helpers/resilience-fixtures.mts';

const here = dirname(fileURLToPath(import.meta.url));
const scorerSrc = readFileSync(resolve(here, '../server/worldmonitor/resilience/v1/_dimension-scorers.ts'), 'utf8');

const LAGGED_IMF_INFLATION = 12.5;
const STATCAN_INFLATION = 2.8;
const LAGGED_IMF_UNEMPLOYMENT = 18;
const STATCAN_UNEMPLOYMENT = 6.4;

function canadaReader(opts: { statcan?: boolean; boc?: boolean } = {}): ResilienceSeedReader {
  const { statcan = true, boc = true } = opts;
  return async (key: string) => {
    if (key === 'economic:imf:macro:v2') {
      return { countries: { CA: { inflationPct: LAGGED_IMF_INFLATION, currentAccountPct: -1, govRevenuePct: 40, year: 2024 } } };
    }
    if (key === 'economic:imf:labor:v1') {
      return { countries: { CA: { unemploymentPct: LAGGED_IMF_UNEMPLOYMENT, populationMillions: 40, year: 2024 } } };
    }
    if (key === RESILIENCE_STATCAN_WDS_KEY) {
      return statcan
        ? { inflationPct: STATCAN_INFLATION, inflationRefPer: '2026-06-01', unemploymentPct: STATCAN_UNEMPLOYMENT, unemploymentRefPer: '2026-07-01' }
        : null;
    }
    if (key === RESILIENCE_BOC_VALET_KEY) {
      return boc
        ? { rates: { USD: { rate: 1.3938, date: '2026-08-13' } }, policyRate: { rate: 2.25, observedAt: '2026-08-12' } }
        : null;
    }
    return fixtureReader(key);
  };
}

describe('Canada national overlay', () => {
  it('replaces lagged IMF inflation and unemployment for CA only', () => {
    const ca = applyCanadaNationalOverlay(
      'CA',
      { inflationPct: LAGGED_IMF_INFLATION, currentAccountPct: -1, govRevenuePct: 40, year: 2024 },
      { unemploymentPct: LAGGED_IMF_UNEMPLOYMENT, populationMillions: 40, year: 2024 },
      {
        statcan: { inflationPct: STATCAN_INFLATION, unemploymentPct: STATCAN_UNEMPLOYMENT },
        boc: { rates: { USD: { rate: 1.3938 } }, policyRate: { rate: 2.25 } },
      },
    );
    assert.equal(ca.usedStatcanInflation, true);
    assert.equal(ca.usedStatcanUnemployment, true);
    assert.equal(ca.imfEntry?.inflationPct, STATCAN_INFLATION);
    assert.equal(ca.laborEntry?.unemploymentPct, STATCAN_UNEMPLOYMENT);
    assert.equal(ca.bocUsdCad, 1.3938);
    assert.equal(ca.bocPolicyRate, 2.25);

    const us = applyCanadaNationalOverlay(
      'US',
      { inflationPct: 3.5 },
      { unemploymentPct: 4.1 },
      { statcan: { inflationPct: STATCAN_INFLATION, unemploymentPct: STATCAN_UNEMPLOYMENT } },
    );
    assert.equal(us.usedStatcanInflation, false);
    assert.equal(us.imfEntry?.inflationPct, 3.5);
  });

  it('scoreMacroFiscal and scoreCurrencyExternal read Valet and WDS keys for CA and drop IMF-lag inflation', async () => {
    const withNational = await scoreCurrencyExternal('CA', canadaReader());
    const imfOnly = await scoreCurrencyExternal('CA', canadaReader({ statcan: false, boc: false }));
    assert.ok(withNational.score > imfOnly.score, `national CPI YoY (${withNational.score}) should beat lagged IMF inflation (${imfOnly.score})`);

    const keys: string[] = [];
    const spy: ResilienceSeedReader = async (key) => {
      keys.push(key);
      return canadaReader()(key);
    };
    await scoreMacroFiscal('CA', spy);
    assert.ok(keys.includes(RESILIENCE_STATCAN_WDS_KEY));
    assert.ok(keys.includes(RESILIENCE_BOC_VALET_KEY));

    const usKeys: string[] = [];
    await scoreMacroFiscal('US', async (key) => {
      usKeys.push(key);
      return fixtureReader(key);
    });
    assert.ok(!usKeys.includes(RESILIENCE_STATCAN_WDS_KEY));
  });

  it('does not drop StatCan when the IMF envelopes are missing', async () => {
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'economic:imf:macro:v2' || key === 'economic:imf:labor:v1') return null;
      return canadaReader()(key);
    };
    const currency = await scoreCurrencyExternal('CA', reader);
    const macro = await scoreMacroFiscal('CA', reader);
    const imfMissingNoStatcan = await scoreCurrencyExternal('CA', async (key) => {
      if (key === 'economic:imf:macro:v2' || key === 'economic:imf:labor:v1') return null;
      return canadaReader({ statcan: false, boc: false })(key);
    });
    assert.ok(currency.score != null && currency.score > 0, 'StatCan CPI must score without an IMF envelope');
    assert.ok(currency.score !== imfMissingNoStatcan.score, 'missing IMF must not also drop StatCan inflation');
    assert.ok(macro.score != null && macro.observedWeight > 0, 'StatCan LFS must keep macroFiscal observed');
  });

  it('scorers import the overlay keys rather than leaving CA on IMF-only reads', () => {
    assert.match(scorerSrc, /RESILIENCE_BOC_VALET_KEY/);
    assert.match(scorerSrc, /RESILIENCE_STATCAN_WDS_KEY/);
    assert.match(scorerSrc, /applyCanadaNationalOverlay/);
    assert.match(scorerSrc, /classifyDimensionFreshness\([^)]*countryCode/);
    assert.match(scorerSrc, /statcanOverlayUsed/);
  });

  it('StatCan-derived CA scores stamp StatCan source/observedAt/provider, not IMF', () => {
    const ca = applyCanadaNationalOverlay(
      'CA',
      { inflationPct: LAGGED_IMF_INFLATION, currentAccountPct: -1, govRevenuePct: 40, year: 2024 },
      { unemploymentPct: LAGGED_IMF_UNEMPLOYMENT, populationMillions: 40, year: 2024 },
      {
        statcan: {
          inflationPct: STATCAN_INFLATION,
          inflationRefPer: '2026-06-01',
          inflationReleaseTime: '2026-07-15T08:30',
          unemploymentPct: STATCAN_UNEMPLOYMENT,
          unemploymentRefPer: '2026-07-01',
          unemploymentReleaseTime: '2026-08-07T08:30',
        },
      },
    );
    assert.deepEqual(ca.inflationFreshness, {
      sourceKey: RESILIENCE_STATCAN_WDS_KEY,
      observedAt: '2026-07-15T08:30',
      provider: STATCAN_SCORE_PROVIDER,
    });
    assert.deepEqual(ca.unemploymentFreshness, {
      sourceKey: RESILIENCE_STATCAN_WDS_KEY,
      observedAt: '2026-08-07T08:30',
      provider: STATCAN_SCORE_PROVIDER,
    });
    assert.notEqual(ca.inflationFreshness?.sourceKey, 'economic:imf:macro:v2');
    assert.notEqual(ca.unemploymentFreshness?.sourceKey, 'economic:imf:labor:v1');
    assert.notEqual(ca.inflationFreshness?.observedAt, '2024');
    const used = { inflation: true, unemployment: true };
    assert.equal(canadaStatcanSourceKey('inflationStability', 'CA', used), RESILIENCE_STATCAN_WDS_KEY);
    assert.equal(canadaStatcanSourceKey('unemploymentPct', 'CA', used), RESILIENCE_STATCAN_WDS_KEY);
    assert.equal(canadaStatcanSourceKey('inflationStability', 'CA'), null, 'EMPTY StatCan must not steal IMF freshness');
    assert.equal(canadaStatcanSourceKey('inflationStability', 'US', used), null);
    assert.equal(canadaStatcanSourceKey('govRevenuePct', 'CA', used), null);

    const us = applyCanadaNationalOverlay(
      'US',
      { inflationPct: 3.5, year: 2024 },
      { unemploymentPct: 4.1, year: 2024 },
      { statcan: { inflationPct: STATCAN_INFLATION, unemploymentPct: STATCAN_UNEMPLOYMENT } },
    );
    assert.equal(us.inflationFreshness, null);
    assert.equal(us.unemploymentFreshness, null);
  });

  it('CA dimension freshness follows StatCan, not a fresh IMF stamp', () => {
    const now = Date.parse('2026-08-14T12:00:00Z');
    const imfFresh = now - 60 * 60 * 1000;
    const statcanStale = now - 5 * 365 * 24 * 60 * 60 * 1000;
    const map = new Map<string, number>([
      ['economic:imf:macro:v2', imfFresh],
      ['economic:imf:labor:v1', imfFresh],
      ['economic:national-debt:v1', imfFresh],
      ['economic:bis:dsr:v1', imfFresh],
      ['resilience:static:*', imfFresh],
      ['economic:bis:eer:v1', imfFresh],
      [RESILIENCE_STATCAN_WDS_KEY, statcanStale],
    ]);

    const used = { inflation: true, unemployment: true };
    const caCurrency = classifyDimensionFreshness('currencyExternal', map, now, 'CA', used);
    const usCurrency = classifyDimensionFreshness('currencyExternal', map, now, 'US', used);
    const caWithoutUse = classifyDimensionFreshness('currencyExternal', map, now, 'CA');
    assert.equal(caCurrency.staleness, 'stale', 'stale StatCan CPI must not hide behind fresh IMF');
    assert.equal(caCurrency.lastObservedAtMs, statcanStale);
    assert.notEqual(usCurrency.lastObservedAtMs, statcanStale, 'US must keep IMF freshness');
    assert.notEqual(usCurrency.staleness, 'stale', 'US IMF-fresh inflation must not inherit StatCan stale');
    assert.notEqual(caWithoutUse.lastObservedAtMs, statcanStale, 'unused StatCan must not remap CA onto a missing WDS seed');

    const caMacro = classifyDimensionFreshness('macroFiscal', map, now, 'CA', used);
    assert.equal(caMacro.lastObservedAtMs, statcanStale, 'CA unemployment freshness is StatCan, not IMF labor');
  });

  it('scoreAllDimensions stamps CA StatCan seed-meta instead of IMF', async () => {
    const now = Date.parse('2026-08-14T12:00:00Z');
    const imfFresh = now - 60 * 60 * 1000;
    const statcanStale = now - 5 * 365 * 24 * 60 * 60 * 1000;
    const reader: ResilienceSeedReader = async (key: string) => {
      if (key === 'seed-meta:economic:statcan-wds') {
        return { fetchedAt: statcanStale, status: 'ok', recordCount: 2 };
      }
      if (key.startsWith('seed-meta:')) {
        return { fetchedAt: imfFresh, status: 'ok', recordCount: 10 };
      }
      return canadaReader()(key);
    };
    const ca = await scoreAllDimensions('CA', reader);
    const us = await scoreAllDimensions('US', reader);
    assert.equal(ca.currencyExternal.freshness.lastObservedAtMs, statcanStale);
    assert.equal(ca.macroFiscal.freshness.lastObservedAtMs, statcanStale);
    assert.notEqual(us.currencyExternal.freshness.lastObservedAtMs, statcanStale);
    assert.notEqual(us.macroFiscal.freshness.lastObservedAtMs, statcanStale);
  });
});
